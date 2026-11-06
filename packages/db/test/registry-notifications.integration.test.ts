import type { Actor } from "@adlc/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentDefinitionNotFoundError,
  AgentDefinitionRepository,
  AuditRepository,
  NotificationNotFoundError,
  NotificationRepository,
  ProjectNotFoundError,
  ProjectRepository,
  type Db,
} from "../src/index.js";
import { freshDatabase, skipIntegration, type TestDatabase } from "./helpers.js";

const MISSING = "00000000-0000-0000-0000-000000000000";
const T0 = new Date("2026-11-06T08:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const human: Actor = { kind: "human", id: "on.duty" };

describe.skipIf(skipIntegration)("repositories used by the orchestrator, notifier and portal (PostgreSQL 16)", () => {
  let t: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    t = await freshDatabase();
    db = t.db;
  });
  afterAll(async () => {
    await t.close();
  });

  describe("FR-ORC-005 projects and agent definitions", () => {
    it("projects: get, by repository, active ones oldest first, and the dispatch environment", async () => {
      const insert = async (key: string, status: string, repos: string[], environment: string, createdAt: Date) =>
        (
          await t.pool.query<{ id: string }>(
            "insert into project (name, jira_project_key, status, repos, environment, created_at) values ($1, $1, $2, $3::jsonb, $4, $5) returning id",
            [key, status, JSON.stringify(repos), environment, createdAt],
          )
        ).rows[0]?.id ?? "";
      const newer = await insert("NEWER", "active", ["org/b"], "production", at(10));
      const older = await insert("OLDER", "active", ["org/a", "org/shared"], "sandbox", at(0));
      await insert("PAUSED", "paused", ["org/c"], "production", at(5));
      const repo = new ProjectRepository(db);

      expect((await repo.get(older)).jiraProjectKey).toBe("OLDER");
      await expect(repo.get(MISSING)).rejects.toBeInstanceOf(ProjectNotFoundError);
      expect((await repo.findByRepo("org/shared"))?.id).toBe(older);
      expect(await repo.findByRepo("org/none")).toBeNull();
      expect((await repo.listActive()).map((p) => p.id)).toEqual([older, newer]);
      expect(await repo.environment(older)).toBe("sandbox");
    });

    it("agent definitions: get, and the latest registration for a role", async () => {
      const insert = async (name: string, role: string, createdAt: Date) =>
        (
          await t.pool.query<{ id: string }>(
            `insert into agent_definition (name, version, role, tier, model_id, autonomy_level, owner_role, release, source_sha, content_hash, created_at)
             values ($1, '0.0.1', $2, 'B', 'none', 1, 'lead', 'R1', 'sha', 'hash', $3) returning id`,
            [name, role, createdAt],
          )
        ).rows[0]?.id ?? "";
      const first = await insert("reviewer-1", "reviewer", at(0));
      const latest = await insert("reviewer-2", "reviewer", at(1));
      const repo = new AgentDefinitionRepository(db);

      expect((await repo.get(first)).name).toBe("reviewer-1");
      await expect(repo.get(MISSING)).rejects.toBeInstanceOf(AgentDefinitionNotFoundError);
      expect((await repo.latestForRole("reviewer"))?.id).toBe(latest);
      expect(await repo.latestForRole("nobody")).toBeNull();
    });
  });

  describe("FR-NOT-001/002 notification outbox and inbox", () => {
    const raise = (repo: NotificationRepository, dedupeKey: string, now = at(0)) =>
      repo.raise({ event: "run.needs-human", severity: "high", audience: "role:dummy", title: "t", body: "b", link: "/runs/x", dedupeKey }, now);

    it("FR-NOT-002 a duplicate of an open event merges; routing is set once", async () => {
      const repo = new NotificationRepository(db);
      const first = await raise(repo, "dup");
      expect(first.merged).toBe(false);
      const again = await raise(repo, "dup", at(1));
      expect(again).toMatchObject({ merged: true, row: { id: first.row.id } });

      expect((await repo.unrouted()).map((n) => n.id)).toContain(first.row.id);
      const routed = await repo.route(first.row.id, ["a@example.invalid"], at(30), at(1));
      expect(routed).toMatchObject({ recipients: ["a@example.invalid"], routedAt: at(1) });
      // A second route does not overwrite the first.
      expect((await repo.route(first.row.id, ["b@example.invalid"], at(60), at(2))).recipients).toEqual(["a@example.invalid"]);
      expect((await repo.unrouted()).map((n) => n.id)).not.toContain(first.row.id);
      await expect(repo.get(MISSING)).rejects.toBeInstanceOf(NotificationNotFoundError);
    });

    it("FR-NOT-002 delivery, deadlines and escalation stop once acknowledged; acknowledgement is audited once", async () => {
      const repo = new NotificationRepository(db);
      const { row } = await raise(repo, "esc");
      await repo.route(row.id, ["on.duty@example.invalid"], at(30), at(0));

      expect((await repo.undelivered()).map((n) => n.id)).toContain(row.id);
      await repo.markSent(row.id, 1, at(1));
      expect((await repo.undelivered()).map((n) => n.id)).not.toContain(row.id);

      expect((await repo.overdue(at(29))).map((n) => n.id)).not.toContain(row.id);
      expect((await repo.overdue(at(30))).map((n) => n.id)).toContain(row.id);
      expect(await repo.escalate(row.id, 2, ["backup@example.invalid"], at(60), at(29))).toBeNull(); // not due yet
      const escalated = await repo.escalate(row.id, 2, ["backup@example.invalid"], at(60), at(31));
      expect(escalated).toMatchObject({ escalationLevel: 2, recipients: ["backup@example.invalid"] });

      expect((await repo.inbox("backup@example.invalid")).map((n) => n.id)).toContain(row.id);
      const acked = await repo.acknowledge(row.id, human, at(32));
      expect(acked).toMatchObject({ ackBy: "human:on.duty", ackAt: at(32) });
      expect((await repo.acknowledge(row.id, { kind: "human", id: "someone.else" }, at(33))).ackBy).toBe("human:on.duty");
      expect((await repo.inbox("backup@example.invalid")).map((n) => n.id)).not.toContain(row.id);
      expect((await repo.inbox("backup@example.invalid", { openOnly: false })).map((n) => n.id)).toContain(row.id);
      expect(await repo.escalate(row.id, 3, ["lead@example.invalid"], at(90), at(61))).toBeNull(); // acknowledged
      expect((await repo.acknowledgedSince(at(31))).map((n) => n.id)).toContain(row.id);
      expect((await repo.acknowledgedSince(at(32))).map((n) => n.id)).not.toContain(row.id);

      const audit = (await new AuditRepository(db).list()).filter((e) => e.target === `notification:${row.id}`);
      expect(audit.map((e) => [e.action, e.actor.id])).toEqual([["notification.ack", "on.duty"]]);
      await expect(repo.acknowledge(MISSING, human, at(40))).rejects.toBeInstanceOf(NotificationNotFoundError);
    });
  });
});
