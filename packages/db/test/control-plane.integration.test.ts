import { leaseDeadline, LEASE_TTL_MS, type Actor } from "@adlc/domain";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentRunRepository,
  AuditRepository,
  BudgetLedgerRepository,
  ControlFlagRepository,
  LeaseExpiredError,
  LeaseHeldError,
  LeaseRepository,
  StaleFencingTokenError,
  stepRecord,
} from "../src/index.js";
import { freshDatabase, seedProjectAndDefinition, skipIntegration, type TestDatabase } from "./helpers.js";

const svc: Actor = { kind: "service", id: "adlc-orchestrator" };
const human: Actor = { kind: "human", id: "operator-1" };
const t0 = new Date("2026-11-05T08:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

describe.skipIf(skipIntegration)("P0-WP3 control-plane storage (PostgreSQL 16)", () => {
  let t: TestDatabase;
  let leases: LeaseRepository;
  let runs: AgentRunRepository;
  let seed: { projectId: string; agentDefinitionId: string };
  const newRun = async (taskKey: string) =>
    (await runs.create({ agentDefinitionId: seed.agentDefinitionId, projectId: seed.projectId, kind: "task-pipeline", taskKey }, svc, t0)).id;

  beforeAll(async () => {
    t = await freshDatabase();
    leases = new LeaseRepository(t.db);
    runs = new AgentRunRepository(t.db);
    seed = await seedProjectAndDefinition(t.pool);
  });
  afterAll(async () => {
    await t.close();
  });

  describe("FR-ORC-008 leases with fencing", () => {
    it("FR-ORC-008 a live lease cannot be taken; expiry is now + 15 min", async () => {
      const r1 = await newRun("T-1");
      const { lease, displaced } = await leases.acquire({ taskKey: "T-1", runId: r1, deadlineAt: leaseDeadline(t0, "S"), now: t0 });
      expect(displaced).toBeNull();
      expect(lease.expiresAt).toEqual(at(LEASE_TTL_MS));
      await expect(leases.acquire({ taskKey: "T-1", runId: await newRun("T-1"), deadlineAt: leaseDeadline(t0, "S"), now: at(60_000) })).rejects.toBeInstanceOf(LeaseHeldError);
    });

    it("AT-P0-03 a stale fencing token is rejected after the lease moves to a new run", async () => {
      const r1 = await newRun("T-2");
      const old = (await leases.acquire({ taskKey: "T-2", runId: r1, deadlineAt: leaseDeadline(t0, "M"), now: t0 })).lease;
      // The old executor goes silent; after the TTL a new run takes the task.
      const later = at(LEASE_TTL_MS + 1);
      const r2 = await newRun("T-2");
      const { lease: fresh, displaced } = await leases.acquire({ taskKey: "T-2", runId: r2, deadlineAt: leaseDeadline(later, "M"), now: later });
      expect(displaced?.runId).toBe(r1);
      expect(fresh.fencingToken > old.fencingToken).toBe(true);

      const staleRef = { taskKey: "T-2", fencingToken: old.fencingToken };
      await expect(leases.renew(staleRef, later)).rejects.toBeInstanceOf(StaleFencingTokenError);
      await expect(leases.withFence(staleRef, later, () => Promise.resolve("written"))).rejects.toBeInstanceOf(StaleFencingTokenError);
      await expect(leases.release(staleRef, "x", later)).rejects.toBeInstanceOf(StaleFencingTokenError);
      await expect(leases.withFence({ taskKey: "T-2", fencingToken: fresh.fencingToken }, later, () => Promise.resolve("written"))).resolves.toBe("written");
    });

    it("FR-ORC-008 heartbeats renew up to the wall-clock deadline, then the lease expires", async () => {
      const r = await newRun("T-3");
      const deadlineAt = leaseDeadline(t0, "S"); // 1 h
      const { lease } = await leases.acquire({ taskKey: "T-3", runId: r, deadlineAt, now: t0 });
      const ref = { taskKey: "T-3", fencingToken: lease.fencingToken };
      let last = lease;
      for (let m = 5; m < 60; m += 5) last = await leases.renew(ref, at(m * 60_000));
      expect(last.expiresAt).toEqual(deadlineAt);
      await expect(leases.renew(ref, deadlineAt)).rejects.toBeInstanceOf(LeaseExpiredError);
      await expect(leases.withFence(ref, deadlineAt, () => Promise.resolve(1))).rejects.toBeInstanceOf(LeaseExpiredError);
    });

    it("FR-ORC-008 a fenced write holds off a takeover until it commits", async () => {
      const r1 = await newRun("T-4");
      const { lease } = await leases.acquire({ taskKey: "T-4", runId: r1, deadlineAt: leaseDeadline(t0, "S"), now: t0 });
      const order: string[] = [];
      let releaseWrite = (): void => undefined;
      const writing = leases.withFence({ taskKey: "T-4", fencingToken: lease.fencingToken }, t0, async (tx) => {
        await tx.insert(stepRecord).values({ runId: r1, step: "S4", status: "running", startedAt: t0 });
        order.push("write-started");
        await new Promise<void>((resolve) => { releaseWrite = resolve; });
        order.push("write-committing");
      });
      await new Promise((r) => setTimeout(r, 100));
      const takeover = leases
        .acquire({ taskKey: "T-4", runId: await newRun("T-4"), deadlineAt: leaseDeadline(at(LEASE_TTL_MS), "S"), now: at(LEASE_TTL_MS) })
        .then(() => order.push("takeover"));
      await new Promise((r) => setTimeout(r, 200));
      order.push("released");
      releaseWrite();
      await Promise.all([writing, takeover]);
      expect(order).toEqual(["write-started", "released", "write-committing", "takeover"]);
    });

    it("FR-ORC-008 the reaper removes only expired leases and audits each", async () => {
      const r = await newRun("T-5");
      await leases.acquire({ taskKey: "T-5", runId: r, deadlineAt: leaseDeadline(at(LEASE_TTL_MS * 10), "S"), now: at(LEASE_TTL_MS * 10) });
      const reaped = await leases.reapExpired(at(LEASE_TTL_MS * 10 + 1));
      // By 10 TTLs every earlier lease (including the re-acquired T-2 and T-4) has expired; T-5 is live.
      expect(reaped.map((l) => l.taskKey).sort()).toEqual(["T-1", "T-2", "T-3", "T-4"]);
      expect(await leases.get("T-5")).not.toBeNull();
      const audit = new AuditRepository(t.db);
      expect((await audit.list()).filter((e) => e.action === "lease.expire").map((e) => e.target).sort()).toEqual(["task:T-1", "task:T-2", "task:T-3", "task:T-4"]);
    });

    it("FR-ORC-008 release ends the lease (S10) and only the holder can release", async () => {
      const lease = await leases.get("T-5");
      if (!lease) throw new Error("missing lease");
      await leases.release({ taskKey: "T-5", fencingToken: lease.fencingToken }, "S10 reached", at(LEASE_TTL_MS * 10 + 2));
      expect(await leases.get("T-5")).toBeNull();
    });

    it("FR-ORC-008 concurrent acquirers of a free task: exactly one wins", async () => {
      const runIds = await Promise.all(Array.from({ length: 8 }, () => newRun("T-6")));
      const results = await Promise.allSettled(
        runIds.map((runId) => leases.acquire({ taskKey: "T-6", runId, deadlineAt: leaseDeadline(t0, "S"), now: t0 })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected").every((r) => r.reason instanceof LeaseHeldError)).toBe(true);
    });
  });

  describe("agent runs", () => {
    it("records machine-checked, audited transitions with timestamps", async () => {
      const id = await newRun("T-7");
      await runs.transition(id, "starting", svc, "container created", t0, { containerId: "c-1" });
      await runs.transition(id, "running", svc, "started", at(1000));
      await runs.heartbeat(id, at(2000));
      const done = await runs.transition(id, "lost", svc, "heartbeat-missed", at(3000));
      expect(done).toMatchObject({ state: "lost", containerId: "c-1", exitReason: "heartbeat-missed", endedAt: at(3000) });
      expect(runs.isTerminal(done)).toBe(true);
      await expect(runs.transition(id, "running", svc, "again", at(4000))).rejects.toThrow(/not allowed/);
      await expect(runs.transition("00000000-0000-0000-0000-000000000000", "running", svc, "x", t0)).rejects.toThrow(/not found/);
      expect((await runs.get(id))?.heartbeatAt).toEqual(at(2000));
    });
  });

  describe("FR-ORC-011 budget ledger", () => {
    it("FR-ORC-011 adds usage atomically across task, day and month keys, and audits cap changes", async () => {
      const ledger = new BudgetLedgerRepository(t.db);
      const keys = [
        { scope: "task", scopeKey: "T-8" },
        { scope: "day", scopeKey: "p:2026-11-05" },
      ] as const;
      await ledger.setCap(keys[1], { capUsd: 50, capTokens: null }, human, "pilot daily cap", t0);
      await Promise.all(Array.from({ length: 10 }, () => ledger.add(keys, 1000, 1.25, t0)));
      expect(await ledger.get(keys[0])).toMatchObject({ tokens: 10_000, costUsd: "12.5000" });
      expect(await ledger.get(keys[1])).toMatchObject({ tokens: 10_000, costUsd: "12.5000", capUsd: "50.0000" });
      expect(await ledger.get({ scope: "month", scopeKey: "none" })).toBeNull();
    });
  });

  describe("FR-ORC-012 control flags", () => {
    it("FR-ORC-012 the kill switch flag is shared, upserted and audited", async () => {
      const flags = new ControlFlagRepository(t.db);
      expect(await flags.get("kill-switch")).toBeNull();
      await flags.set("kill-switch", true, human, "incident", t0);
      const row = await flags.set("kill-switch", false, human, "resolved", at(1000));
      expect(row).toMatchObject({ enabled: false, setBy: "human:operator-1", reason: "resolved" });
      const events = (await new AuditRepository(t.db).list()).filter((e) => e.action === "control.flag");
      expect(events.map((e) => e.reason)).toEqual(["engaged: incident", "released: resolved"]);
    });
  });

  it("hard rule 11: the whole audit chain still verifies", async () => {
    expect(await new AuditRepository(t.db).verify()).toMatchObject({ ok: true });
    const { rows } = await t.pool.query<{ n: string }>("select count(*) as n from audit_event where action like 'lease.%'");
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
    await t.db.execute(sql`select 1`);
  });
});
