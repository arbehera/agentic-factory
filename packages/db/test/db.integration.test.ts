import { formatDecisionId, stateHash, type AuditEventContent } from "@adlc/domain";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditRepository, runMigrations, type Db } from "../src/index.js";
import { freshDatabase, skipIntegration, type TestDatabase } from "./helpers.js";

const event = (n: number, extra: Partial<AuditEventContent> = {}): AuditEventContent => ({
  actor: { kind: "service", id: "adlc-orchestrator" },
  action: "test.event",
  target: `T-${n}`,
  reason: `reason ${n}`,
  beforeHash: null,
  afterHash: stateHash({ n }),
  correlation: { taskKey: `T-${n}` },
  ...extra,
});

describe.skipIf(skipIntegration)("P0-WP2 database (PostgreSQL 16)", () => {
  let t: TestDatabase;
  let pool: pg.Pool;
  let db: Db;
  let projectId: string;

  beforeAll(async () => {
    // Session time zone deliberately not UTC: storage must be UTC regardless (CLAUDE.md §6).
    t = await freshDatabase({ sessionTimeZone: "Asia/Kolkata" });
    ({ pool, db } = t);
    const { rows } = await pool.query<{ id: string }>(
      "insert into project (name, jira_project_key, status) values ('p', 'PILOT', 'active') returning id",
    );
    projectId = (rows[0] as { id: string }).id;
  });

  afterAll(async () => {
    await t.close();
  });

  it("creates a table for every spec.md §5 entity, and re-running migrations is a no-op", async () => {
    await runMigrations(db);
    const { rows } = await pool.query<{ t: string }>(
      "select tablename as t from pg_tables where schemaname = 'public' and tablename not like 'audit_event_%'",
    );
    expect(rows.map((r) => r.t).sort()).toEqual([
      "agent_definition", "agent_run", "audit_event", "budget_ledger", "component_lock", "decision",
      "evidence_record", "gate", "lease", "notification", "pack_version", "product_profile", "project",
      "step_record", "test_target_lease", "trace_link", "trace_node",
    ]);
  });

  describe("NFR-006 hash-chained audit", () => {
    it("NFR-006 appends a verifiable chain, linear under 25 concurrent writers", async () => {
      const repo = new AuditRepository(db);
      const written = await Promise.all(Array.from({ length: 25 }, (_, i) => repo.append(event(i))));
      expect(new Set(written.map((e) => e.seq)).size).toBe(25);
      expect(await repo.verify()).toMatchObject({ ok: true, count: 25 });
      const stored = await repo.list();
      stored.slice(1).forEach((e, i) => { expect(e.prevHash).toBe(stored[i]?.hash); });
    });

    it("NFR-006 verification can start from an export anchor", async () => {
      const repo = new AuditRepository(db);
      const all = await repo.list();
      const anchor = all[9];
      expect(await repo.verify({ hash: anchor?.hash ?? "", afterSeq: anchor?.seq ?? 0 })).toMatchObject({
        ok: true,
        count: all.length - 10,
      });
    });

    it("NFR-001 rejects an event without a reason or with a malformed hash", async () => {
      const repo = new AuditRepository(db);
      await expect(repo.append(event(1, { reason: "" }))).rejects.toThrow();
      await expect(repo.append(event(1, { afterHash: "nothex" }))).rejects.toThrow();
    });

    it("NFR-006 UPDATE, DELETE and TRUNCATE are rejected (append-only)", async () => {
      await expect(pool.query("update audit_event set reason = 'x'")).rejects.toThrow(/append-only/);
      await expect(pool.query("delete from audit_event")).rejects.toThrow(/append-only/);
      await expect(pool.query("truncate audit_event")).rejects.toThrow(/append-only/);
    });

    it("NFR-006 tampering that bypasses the trigger is detected by chain verification", async () => {
      const repo = new AuditRepository(db);
      const victim = (await repo.list())[3];
      const client = await pool.connect();
      try {
        // A superuser can disable triggers; the hash chain still exposes the edit.
        await client.query("begin");
        await client.query("set local session_replication_role = replica");
        await client.query("update audit_event set reason = 'edited' where seq = $1", [victim?.seq]);
        await client.query("commit");
      } finally {
        client.release();
      }
      expect(await repo.verify()).toEqual({ ok: false, brokenAtSeq: victim?.seq, reason: "hash-mismatch" });
    });

    it("NFR-006 events land in the monthly partition; partition bounds are UTC midnights", async () => {
      const { rows } = await pool.query<{ part: string }>(
        "select distinct tableoid::regclass::text as part from audit_event",
      );
      const now = new Date();
      const month = `${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      expect(rows.map((r) => r.part)).toEqual([`audit_event_${month}`]);

      await pool.query("select adlc_ensure_audit_partition('2031-03-15')");
      await pool.query("select adlc_ensure_audit_partition('2031-03-01')"); // idempotent
      const { rows: bounds } = await pool.query<{ expr: string }>(
        "select pg_get_expr(relpartbound, oid) as expr from pg_class where relname = 'audit_event_2031_03'",
      );
      expect(bounds[0]?.expr).toBe("FOR VALUES FROM ('2031-03-01 05:30:00+05:30') TO ('2031-04-01 05:30:00+05:30')");
    });
  });

  describe("FR-ORC-008 lease storage", () => {
    it("FR-ORC-008 fencing tokens increase strictly, even when a task's lease row is replaced", async () => {
      const { rows: def } = await pool.query<{ id: string }>(
        `insert into agent_definition (name, version, role, tier, model_id, autonomy_level, owner_role, release, source_sha, content_hash)
         values ('dummy', '0.0.1', 'dummy', 'B', 'none', 1, 'lead', 'R1', 'sha', 'hash') returning id`,
      );
      const runIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { rows } = await pool.query<{ id: string }>(
          "insert into agent_run (agent_definition_id, project_id, kind) values ($1, $2, 'task-pipeline') returning id",
          [def[0]?.id, projectId],
        );
        runIds.push((rows[0] as { id: string }).id);
      }
      const tokens: bigint[] = [];
      for (const runId of runIds) {
        await pool.query("delete from lease where task_key = 'PILOT-1'");
        const { rows } = await pool.query<{ fencing_token: string }>(
          `insert into lease (task_key, run_id, expires_at, deadline_at)
           values ('PILOT-1', $1, now() + interval '15 min', now() + interval '1 hour') returning fencing_token`,
          [runId],
        );
        tokens.push(BigInt((rows[0] as { fencing_token: string }).fencing_token));
      }
      expect(tokens[0]).toBeLessThan(tokens[1] as bigint);
      expect(tokens[1]).toBeLessThan(tokens[2] as bigint);
    });

    it("FR-ORC-008 a lease cannot expire after its wall-clock deadline", async () => {
      const { rows } = await pool.query<{ id: string }>("select id from agent_run limit 1");
      await expect(
        pool.query(
          `insert into lease (task_key, run_id, expires_at, deadline_at)
           values ('PILOT-2', $1, now() + interval '2 hour', now() + interval '1 hour')`,
          [rows[0]?.id],
        ),
      ).rejects.toThrow(/lease_expiry_chk/);
    });
  });

  describe("FR-DEC-002 Decision storage invariants", () => {
    const insert = (id: string, cls: string, reversible: boolean, autoResolve: boolean) =>
      db.execute(sql`insert into decision (id, project_id, class, route, question, owner, timebox_minutes, due_at, reversible, auto_resolve)
        values (${id}, ${projectId}, ${cls}, 'human', 'q', 'owner', 60, now() + interval '1 hour', ${reversible}, ${autoResolve})`);

    it("FR-DEC-002 the database rejects auto-resolving or reversible gate Decisions", async () => {
      // Violates both checks; PostgreSQL reports whichever it evaluates first.
      const err: unknown = await insert(formatDecisionId(1), "gate", false, true).then(() => null, (e: unknown) => e);
      expect(["decision_gate_chk", "decision_auto_resolve_chk"]).toContain(
        (err as { cause?: { constraint?: string } } | null)?.cause?.constraint,
      );
      await expect(insert(formatDecisionId(2), "gate", true, false)).rejects.toMatchObject({ cause: { constraint: "decision_gate_chk" } });
      await expect(insert(formatDecisionId(3), "risk", false, true)).rejects.toMatchObject({ cause: { constraint: "decision_auto_resolve_chk" } });
      await expect(insert(formatDecisionId(5), "requirement", false, true)).rejects.toMatchObject({ cause: { constraint: "decision_auto_resolve_chk" } });
      await expect(insert(formatDecisionId(4), "gate", false, false)).resolves.toBeDefined();
    });

    it("Decision IDs must match DEC-nnnn and allow more than four digits", async () => {
      await expect(insert("DEC-7", "consult", true, true)).rejects.toMatchObject({ cause: { constraint: "decision_id_chk" } });
      await expect(insert(formatDecisionId(12345), "consult", true, true)).resolves.toBeDefined();
    });
  });
});
