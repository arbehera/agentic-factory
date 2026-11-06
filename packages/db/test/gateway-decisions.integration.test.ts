import type { Actor } from "@adlc/domain";
import type { DecisionInput } from "@adlc/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRunRepository, AuditRepository, DecisionRepository, GatewaySessionRepository, InvalidSessionError } from "../src/index.js";
import { freshDatabase, seedProjectAndDefinition, skipIntegration, type TestDatabase } from "./helpers.js";

const svc: Actor = { kind: "service", id: "adlc-orchestrator" };
const t0 = new Date("2026-11-05T08:00:00.000Z");

describe.skipIf(skipIntegration)("P0-WP5 gateway storage (PostgreSQL 16)", () => {
  let t: TestDatabase;
  let seed: { projectId: string; agentDefinitionId: string };
  let runId: string;

  beforeAll(async () => {
    t = await freshDatabase();
    seed = await seedProjectAndDefinition(t.pool);
    runId = (await new AgentRunRepository(t.db).create({ agentDefinitionId: seed.agentDefinitionId, projectId: seed.projectId, kind: "task-pipeline", taskKey: "PILOT-1" }, svc, t0)).id;
  });
  afterAll(async () => {
    await t.close();
  });

  it("NFR-001 issues per-run tokens stored only as hashes; expired and revoked tokens are refused", async () => {
    const sessions = new GatewaySessionRepository(t.db);
    const token = await sessions.issue({ runId, role: "dummy", projectId: seed.projectId, taskKey: "PILOT-1", fencingToken: 7n, expiresAt: new Date(t0.getTime() + 60_000) }, t0);
    expect(token.length).toBeGreaterThanOrEqual(43);
    const { rows } = await t.pool.query<{ token_hash: string }>("select token_hash from gateway_session");
    expect(rows.map((r) => r.token_hash)).not.toContain(token);

    expect(await sessions.resolve(token, t0)).toMatchObject({ runId, role: "dummy", taskKey: "PILOT-1", fencingToken: 7n, repos: [] });
    await expect(sessions.resolve(token, new Date(t0.getTime() + 60_000))).rejects.toBeInstanceOf(InvalidSessionError);
    await expect(sessions.resolve("forged", t0)).rejects.toBeInstanceOf(InvalidSessionError);
    await sessions.revokeRun(runId, t0);
    await expect(sessions.resolve(token, t0)).rejects.toBeInstanceOf(InvalidSessionError);
  });

  it("a task-scoped session must carry a fencing token, and only then", async () => {
    await expect(
      t.pool.query("insert into gateway_session (token_hash, run_id, role, project_id, task_key, issued_at, expires_at) values ('h', $1, 'r', $2, 'PILOT-1', now(), now())", [runId, seed.projectId]),
    ).rejects.toThrow(/gateway_session_fence_chk/);
  });

  it("FR-DEC-001 raises Decisions with DEC-nnnn IDs and due times, answers once, and audits both", async () => {
    const decisions = new DecisionRepository(t.db);
    const input: DecisionInput = { class: "consult", route: "design", question: "Which header?", options: [], owner: "architect", timeboxMinutes: 240, reversible: true, autoResolve: false, projectId: seed.projectId, taskKey: "PILOT-1" };
    const d = await decisions.raise(input, { kind: "agent-run", id: runId }, t0);
    expect(d).toMatchObject({ id: "DEC-0001", status: "open", raisedBy: `agent-run:${runId}`, dueAt: new Date(t0.getTime() + 240 * 60_000) });
    expect((await decisions.list(seed.projectId, "open")).map((x) => x.id)).toEqual(["DEC-0001"]);
    const answered = await decisions.answer("DEC-0001", "include/api/x.h", { kind: "agent-run", id: "architect-run" }, t0);
    expect(answered).toMatchObject({ status: "decided", decidedBy: "agent-run:architect-run" });
    await expect(decisions.answer("DEC-0001", "again", svc, t0)).rejects.toThrow(/not allowed/);
    await expect(decisions.get("DEC-9999")).rejects.toThrow(/not found/);
    await expect(decisions.raise({ ...input, class: "gate", reversible: false, autoResolve: true }, svc, t0)).rejects.toThrow(/autoResolve=false/);
    const actions = (await new AuditRepository(t.db).list()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["decision.raise", "decision.answer"]));
  });
});
