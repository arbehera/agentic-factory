import type { Actor } from "@adlc/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRunRepository, AuditRepository, EvidenceRepository, ModelCallRepository, VerdictExistsError } from "../src/index.js";
import { freshDatabase, seedProjectAndDefinition, skipIntegration, type TestDatabase } from "./helpers.js";

const reviewer: Actor = { kind: "agent-run", id: "reviewer" };
const t0 = new Date("2026-11-05T08:00:00.000Z");
const HEAD = "a".repeat(40);

describe.skipIf(skipIntegration)("FR-EVD-001 write-once evidence store", () => {
  let t: TestDatabase;
  let evidence: EvidenceRepository;
  let calls: ModelCallRepository;
  let seed: { projectId: string; agentDefinitionId: string };
  let runId: string;

  beforeAll(async () => {
    t = await freshDatabase();
    seed = await seedProjectAndDefinition(t.pool);
    runId = (await new AgentRunRepository(t.db).create({ agentDefinitionId: seed.agentDefinitionId, projectId: seed.projectId, kind: "review" }, { kind: "service", id: "adlc-orchestrator" }, t0)).id;
    evidence = new EvidenceRepository(t.db);
    calls = new ModelCallRepository(t.db);
    await calls.record({ id: "msg_01", runId, model: "test-model", inputTokens: 10, outputTokens: 5, requestHash: "r".repeat(64), responseHash: "s".repeat(64) }, t0);
  });
  afterAll(async () => {
    await t.close();
  });

  const verdict = (over: Partial<Parameters<EvidenceRepository["writeVerdict"]>[0]> = {}) => ({
    projectId: seed.projectId,
    repo: "org/product",
    prNumber: 1,
    headSha: HEAD,
    reviewerRole: "dummy-reviewer",
    reviewerRunId: runId,
    verdict: "approve" as const,
    summary: "looks fine",
    modelCallId: "msg_01",
    ...over,
  });

  it("FR-EVD-001 stores a verdict bound to the head SHA and a logged model call, and audits it", async () => {
    const row = await evidence.writeVerdict(verdict(), reviewer, t0);
    expect(row).toMatchObject({ headSha: HEAD, modelCallId: "msg_01", verdict: "approve" });
    expect(row.verdictHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await new AuditRepository(t.db).list()).map((e) => e.action)).toContain("evidence.verdict");
  });

  it("FR-EVD-001 one verdict per reviewer role per head: a second write is refused, a new head needs a new verdict", async () => {
    await expect(evidence.writeVerdict(verdict({ verdict: "request-changes" }), reviewer, t0)).rejects.toBeInstanceOf(VerdictExistsError);
    // A model call backs at most one verdict: reusing msg_01 for the new head is refused.
    await expect(evidence.writeVerdict(verdict({ headSha: "b".repeat(40) }), reviewer, t0)).rejects.toMatchObject({ cause: { constraint: "reviewer_verdict_model_call_uq" } });
    await calls.record({ id: "msg_02", runId, model: "test-model", inputTokens: 10, outputTokens: 5, requestHash: "r".repeat(64), responseHash: "t".repeat(64) }, t0);
    await expect(evidence.writeVerdict(verdict({ headSha: "b".repeat(40), modelCallId: "msg_02" }), reviewer, t0)).resolves.toBeDefined();
    expect((await evidence.verdictsFor("org/product", 1)).map((v) => v.headSha).sort()).toEqual(["a".repeat(40), "b".repeat(40)]);
  });

  it("FR-EVD-001 verdicts must cite a model call the gateway logged, and a full 40-character SHA", async () => {
    await expect(evidence.writeVerdict(verdict({ reviewerRole: "x", modelCallId: "msg_forged" }), reviewer, t0)).rejects.toThrow();
    await expect(evidence.writeVerdict(verdict({ reviewerRole: "y", headSha: "abc1234" }), reviewer, t0)).rejects.toThrow();
  });

  it("FR-EVD-001 verdicts, model calls and evidence records cannot be changed or removed", async () => {
    await evidence.storeEvidence(
      { projectId: seed.projectId, repo: "org/product", authorRole: "dummy", prNumber: 1, headSha: HEAD, patchId: "p", reviewerVerdicts: [], checkResults: [], envelope: { payloadType: "x" }, status: "signed" },
      { kind: "service", id: "adlc-signer" },
      t0,
    );
    for (const table of ["reviewer_verdict", "model_call", "evidence_record"]) {
      await expect(t.pool.query(`update ${table} set created_at = now()`)).rejects.toThrow(/write-once/);
      await expect(t.pool.query(`delete from ${table}`)).rejects.toThrow(/write-once/);
      await expect(t.pool.query(`truncate ${table} cascade`)).rejects.toThrow(/write-once/);
    }
    await expect(
      evidence.storeEvidence(
        { projectId: seed.projectId, repo: "org/product", authorRole: "dummy", prNumber: 1, headSha: HEAD, patchId: "p", reviewerVerdicts: [], checkResults: [], envelope: {}, status: "signed" },
        { kind: "service", id: "adlc-signer" },
        t0,
      ),
    ).rejects.toThrow();
    expect(await evidence.evidenceFor("org/product", 1, HEAD)).toMatchObject({ status: "signed", envelope: { payloadType: "x" } });
    expect(await evidence.evidenceFor("org/product", 1, "c".repeat(40))).toBeNull();
  });

  it("model call logging is idempotent per provider call ID", async () => {
    await calls.record({ id: "msg_01", runId, model: "other", inputTokens: 1, outputTokens: 1, requestHash: "x", responseHash: "y" }, t0);
    expect(await calls.getMany(["msg_01", "missing"])).toMatchObject([{ id: "msg_01", model: "test-model" }]);
    expect(await calls.getMany([])).toEqual([]);
  });
});
