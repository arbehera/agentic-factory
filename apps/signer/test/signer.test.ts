import { PublicKeyVerifier, SoftwareEd25519Signer, verifyEvidence, type DsseEnvelope } from "@adlc/attestation";
import type { Actor } from "@adlc/domain";
import { AgentRunRepository, AuditRepository, createDb, EvidenceRepository, ModelCallRepository, runMigrations, type Db } from "@adlc/db";
import { createLogger } from "@adlc/telemetry";
import { FakeSourceControl, freshDatabase, seedProjectAndDefinition, skipIntegration, type TestDatabase } from "@adlc/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVIDENCE_CONTEXT, SignerService } from "../src/index.js";

const reviewerIdentity: Actor = { kind: "service", id: "adlc-reviewer" };
const clock = { now: () => new Date("2026-11-05T08:00:00.000Z") };

describe.skipIf(skipIntegration)("FR-EVD-002 evidence signer", () => {
  let t: TestDatabase;
  let db: Db;
  let scm: FakeSourceControl;
  let key: SoftwareEd25519Signer;
  let signer: SignerService;
  let reviewerRunId: string;
  let projectId: string;
  let head: string;

  async function verdict(over: { headSha?: string; verdict?: "approve" | "request-changes"; modelCallId?: string; runId?: string; role?: string } = {}) {
    return new EvidenceRepository(db).writeVerdict(
      { projectId, repo: "org/product", prNumber: 1, headSha: over.headSha ?? head, reviewerRole: over.role ?? "dummy-reviewer", reviewerRunId: over.runId ?? reviewerRunId, verdict: over.verdict ?? "approve", summary: "ok", modelCallId: over.modelCallId ?? "msg_1" },
      reviewerIdentity,
      clock.now(),
    );
  }

  beforeEach(async () => {
    t = await freshDatabase({ migrate: (pool) => runMigrations(createDb(pool)) });
    db = createDb(t.pool);
    const seed = await seedProjectAndDefinition(t.pool);
    projectId = seed.projectId;
    await t.pool.query("update project set repos = '[\"org/product\"]'::jsonb where id = $1", [projectId]);
    reviewerRunId = (await new AgentRunRepository(db).create({ agentDefinitionId: seed.agentDefinitionId, projectId, kind: "review" }, { kind: "service", id: "adlc-orchestrator" }, clock.now())).id;
    await new ModelCallRepository(db).record({ id: "msg_1", runId: reviewerRunId, model: "m", inputTokens: 1, outputTokens: 1, requestHash: "a", responseHash: "b" }, clock.now());

    scm = new FakeSourceControl();
    scm.seedRepo("org/product", { "a.txt": "a" });
    await scm.createBranch("org/product", "task/PILOT-1", "main");
    head = scm.pushAsHuman("org/product", "task/PILOT-1", { "docs/dummy/PILOT-1.md": "x" });
    await scm.openPullRequest("org/product", { head: "task/PILOT-1", base: "main", title: "t", body: "b" });
    await scm.setCommitStatus("org/product", head, { context: "adlc/verify", state: "success", description: "verify passed" });

    key = SoftwareEd25519Signer.generate("test");
    signer = new SignerService(db, scm, key, { reviewerSets: { sets: { dummy: ["dummy-reviewer"] } }, requiredChecks: ["adlc/verify"] }, clock, createLogger("signer-test", { level: "silent" }));
  });
  afterEach(async () => {
    await t.close();
  });

  const evidenceStatus = (sha: string) => scm.postedStatuses.filter((s) => s.sha === sha && s.status.context === EVIDENCE_CONTEXT).at(-1)?.status;

  it("FR-EVD-002 signs when all four conditions hold, stores a verifiable envelope and posts adlc/evidence success", async () => {
    await verdict();
    const out = await signer.signPullRequest("org/product", 1, "dummy");
    expect(out).toMatchObject({ signed: true, headSha: head, keyId: key.keyId, reposted: false });
    expect(evidenceStatus(head)).toMatchObject({ state: "success" });

    const row = await new EvidenceRepository(db).evidenceFor("org/product", 1, head);
    const statement = await verifyEvidence(row?.envelope as unknown as DsseEnvelope, new PublicKeyVerifier([key.publicKeyPem]));
    expect(statement.subject[0]?.digest.gitCommit).toBe(head);
    expect(statement.predicate).toMatchObject({ authorRole: "dummy", verdicts: [{ reviewerRole: "dummy-reviewer", modelCallId: "msg_1", verdict: "approve" }], checks: [{ context: "adlc/verify", state: "success" }] });
    expect((await new AuditRepository(db).list()).map((e) => e.action)).toContain("evidence.sign");
  });

  it("FR-EVD-002 signing the same head again re-posts the status without a second record", async () => {
    await verdict();
    const first = await signer.signPullRequest("org/product", 1, "dummy");
    const again = await signer.signPullRequest("org/product", 1, "dummy");
    expect(again).toMatchObject({ signed: true, reposted: true, evidenceId: first.signed ? first.evidenceId : "" });
  });

  it("FR-EVD-002 refuses without a verdict, with request-changes, or without passing checks — failure status plus audit", async () => {
    expect(await signer.signPullRequest("org/product", 1, "dummy")).toEqual({ signed: false, headSha: head, reasons: ["missing verdict from required reviewer dummy-reviewer"] });
    expect(evidenceStatus(head)).toMatchObject({ state: "failure", description: "missing verdict from required reviewer dummy-reviewer" });
    await verdict({ verdict: "request-changes" });
    expect(await signer.signPullRequest("org/product", 1, "dummy")).toMatchObject({ signed: false, reasons: ["dummy-reviewer requested changes"] });
    const refusals = (await new AuditRepository(db).list()).filter((e) => e.action === "evidence.refuse");
    expect(refusals).toHaveLength(2);
    expect(refusals[0]?.actor).toEqual({ kind: "service", id: "adlc-signer" });
  });

  it("FR-EVD-002 (d) refuses when adlc/verify has not passed on the head", async () => {
    await verdict();
    await scm.setCommitStatus("org/product", head, { context: "adlc/verify", state: "failure", description: "build failed" });
    expect(await signer.signPullRequest("org/product", 1, "dummy")).toMatchObject({ signed: false, reasons: ["required check adlc/verify is failure"] });
  });

  it("FR-EVD-002 (b) a later push invalidates the evidence: the new head needs new verdicts", async () => {
    await verdict();
    expect((await signer.signPullRequest("org/product", 1, "dummy")).signed).toBe(true);
    const newHead = scm.pushAsHuman("org/product", "task/PILOT-1", { "docs/dummy/PILOT-1.md": "changed" });
    await scm.setCommitStatus("org/product", newHead, { context: "adlc/verify", state: "success", description: "ok" });
    expect(await signer.signPullRequest("org/product", 1, "dummy")).toEqual({ signed: false, headSha: newHead, reasons: ["missing verdict from required reviewer dummy-reviewer"] });
    await new ModelCallRepository(db).record({ id: "msg_2", runId: reviewerRunId, model: "m", inputTokens: 1, outputTokens: 1, requestHash: "c", responseHash: "d" }, clock.now());
    await verdict({ headSha: newHead, modelCallId: "msg_2" });
    expect(await signer.signPullRequest("org/product", 1, "dummy")).toMatchObject({ signed: true, headSha: newHead });
  });

  it("FR-EVD-002 a refusal reason longer than GitHub's 140-character status description is shortened, not rejected", async () => {
    const longRole = `reviewer-${"x".repeat(150)}`;
    const strict = new SignerService(db, scm, key, { reviewerSets: { sets: { dummy: [longRole] } }, requiredChecks: ["adlc/verify"] }, clock, createLogger("signer-test", { level: "silent" }));
    expect(await strict.signPullRequest("org/product", 1, "dummy")).toMatchObject({ signed: false, reasons: [`missing verdict from required reviewer ${longRole}`] });
    const description = evidenceStatus(head)?.description ?? "";
    expect(description).toHaveLength(140);
    expect(description.endsWith("...")).toBe(true);
  });

  it("FR-EVD-002 refuses author roles without a reviewer set, unknown PRs and repositories outside any project", async () => {
    await verdict();
    expect(await signer.signPullRequest("org/product", 1, "engineer")).toEqual({ signed: false, headSha: head, reasons: ["no reviewer set is configured for the author role"] });
    expect(await signer.signPullRequest("org/product", 99, "dummy")).toEqual({ signed: false, headSha: null, reasons: ["pull request not found"] });
    scm.seedRepo("org/other", { a: "a" });
    await scm.createBranch("org/other", "task/X-1", "main");
    await scm.openPullRequest("org/other", { head: "task/X-1", base: "main", title: "t", body: "b" });
    expect(await signer.signPullRequest("org/other", 2, "dummy")).toMatchObject({ signed: false, reasons: ["repository is not part of any ADLC project"] });
  });
});
