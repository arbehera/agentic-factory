import "reflect-metadata";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EnvSecretProvider } from "@adlc/adapters";
import { PublicKeyVerifier, SoftwareEd25519Signer, verifyEvidence, type DsseEnvelope } from "@adlc/attestation";
import { HeartbeatService, KillSwitch } from "@adlc/control-plane";
import { leaseDeadline, type Actor } from "@adlc/domain";
import { AgentRunRepository, ControlFlagRepository, createDb, EvidenceRepository, GatewaySessionRepository, LeaseRepository, ModelCallRepository, runMigrations, type Db } from "@adlc/db";
import { RUN_EXIT_CODES } from "@adlc/executor/contract";
import { Gateway, GatewayModule, loadRolePolicies, ModelProxy } from "@adlc/gateway";
import { allTools } from "@adlc/mcp-servers";
import { loadYamlContract } from "@adlc/pack-sdk";
import { reviewerSetsSchema } from "@adlc/schemas";
import { EVIDENCE_CONTEXT, SignerService } from "@adlc/signer";
import { createLogger } from "@adlc/telemetry";
import { FakeClaudeApi, FakeIssueTracker, FakeSourceControl, freshDatabase, seedProjectAndDefinition, skipIntegration, type TestDatabase } from "@adlc/testing";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const svc: Actor = { kind: "service", id: "adlc-orchestrator" };
const silent = createLogger("chain-test", { level: "silent" });
const clock = { now: () => new Date() };

describe.skipIf(skipIntegration)("P0-WP7 evidence chain: dummy agent → CI → dummy reviewer → signer", () => {
  let t: TestDatabase;
  let db: Db;
  let app: INestApplication;
  let claude: FakeClaudeApi;
  let github: FakeSourceControl;
  let base: string;
  let seed: { projectId: string; agentDefinitionId: string };
  let signer: SignerService;
  let key: SoftwareEd25519Signer;

  async function session(
    role: string,
    kind: "task-pipeline" | "review",
    taskKey: string | null,
    reviewTarget?: { repo: string; prNumber: number; headSha: string },
  ): Promise<{ runId: string; token: string }> {
    const run = await new AgentRunRepository(db).create({ agentDefinitionId: seed.agentDefinitionId, projectId: seed.projectId, kind, ...(taskKey ? { taskKey } : {}) }, svc, clock.now());
    let fencingToken: bigint | null = null;
    let expiresAt = new Date(clock.now().getTime() + 3_600_000);
    if (taskKey) {
      const { lease } = await new LeaseRepository(db).acquire({ taskKey, runId: run.id, deadlineAt: leaseDeadline(clock.now(), "S"), now: clock.now() });
      fencingToken = lease.fencingToken;
      expiresAt = lease.deadlineAt;
    }
    const token = await new GatewaySessionRepository(db).issue({ runId: run.id, role, projectId: seed.projectId, taskKey, fencingToken, expiresAt, ...(reviewTarget ? { reviewTarget } : {}) }, clock.now());
    return { runId: run.id, token };
  }

  const env = (s: { runId: string; token: string }, extra: Record<string, string>): Record<string, string> => ({
    ADLC_GATEWAY_URL: base,
    ADLC_GATEWAY_TOKEN: s.token,
    ADLC_RUN_ID: s.runId,
    ADLC_TASK_KEY: "PILOT-1",
    ADLC_REPO: "org/product",
    ADLC_HEARTBEAT_MS: "1000",
    ...extra,
  });

  beforeEach(async () => {
    t = await freshDatabase({ migrate: (pool) => runMigrations(createDb(pool)) });
    db = createDb(t.pool);
    seed = await seedProjectAndDefinition(t.pool);
    await t.pool.query("update project set jira_project_key = 'PILOT', repos = '[\"org/product\"]'::jsonb where id = $1", [seed.projectId]);
    const jira = new FakeIssueTracker();
    jira.seed({ key: "PILOT-1", type: "Task", status: "In Progress", summary: "Dummy change", description: "" });
    github = new FakeSourceControl();
    github.seedRepo("org/product", { "README.md": "product" });
    claude = new FakeClaudeApi();
    const secrets = new EnvSecretProvider({ ADLC_SECRET_CLAUDE_API_KEY: "sk-test-key-0123456789" });
    const gateway = new Gateway({
      db,
      tools: allTools,
      policies: await loadRolePolicies(path.join(repoRoot, "agents")),
      adapters: { jira, github },
      secrets,
      heartbeats: new HeartbeatService(new LeaseRepository(db), new KillSwitch(new ControlFlagRepository(db), clock), clock),
      clock,
      logger: silent,
    });
    const proxy = new ModelProxy({ upstreamUrl: await claude.start(), apiKeySecret: "claude-api-key", maxTokensCap: 1024 }, secrets, new ModelCallRepository(db), clock, silent);
    app = await NestFactory.create(GatewayModule.forRoot(gateway, proxy), { logger: false });
    await app.listen(0);
    base = (await app.getUrl()).replace("[::1]", "localhost");

    const reviewerSets = loadYamlContract(reviewerSetsSchema, await readFile(path.join(repoRoot, "agents/reviewer-sets.yaml"), "utf8"), "agents/reviewer-sets.yaml");
    key = SoftwareEd25519Signer.generate("test");
    signer = new SignerService(db, github, key, { reviewerSets, requiredChecks: ["adlc/verify"] }, clock, silent);
  });

  afterEach(async () => {
    await app.close();
    await claude.stop();
    await t.close();
  });

  async function authorPr(): Promise<string> {
    expect(await runAgent(env(await session("dummy", "task-pipeline", "PILOT-1"), { ADLC_ROLE: "dummy" }), silent)).toBe(RUN_EXIT_CODES.succeeded);
    const pr = await github.getPullRequest("org/product", 1);
    if (!pr) throw new Error("no PR");
    // CI (Jenkins verify, FR-CI-001) reports on the head under its own identity.
    await github.setCommitStatus("org/product", pr.headSha, { context: "adlc/verify", state: "success", description: "verify passed" });
    return pr.headSha;
  }

  const reviewerEnv = async (headSha: string) => env(await session("dummy-reviewer", "review", null, { repo: "org/product", prNumber: 1, headSha }), { ADLC_ROLE: "dummy-reviewer", ADLC_PR_NUMBER: "1", ADLC_HEAD_SHA: headSha, ADLC_MODEL: "claude-test" });

  it("FR-EVD-002 a reviewed, verified PR head gets signed evidence and adlc/evidence success", async () => {
    const head = await authorPr();
    expect(await runAgent(await reviewerEnv(head), silent)).toBe(RUN_EXIT_CODES.succeeded);
    const out = await signer.signPullRequest("org/product", 1, "dummy");
    expect(out).toMatchObject({ signed: true, headSha: head });
    expect(github.postedStatuses.filter((s) => s.status.context === EVIDENCE_CONTEXT).at(-1)).toMatchObject({ sha: head, status: { state: "success" } });

    const row = await new EvidenceRepository(db).evidenceFor("org/product", 1, head);
    const st = await verifyEvidence(row?.envelope as unknown as DsseEnvelope, new PublicKeyVerifier([key.publicKeyPem]));
    expect(st.predicate.verdicts).toEqual([expect.objectContaining({ reviewerRole: "dummy-reviewer", verdict: "approve", modelCallId: "msg_fake_0001" })]);
    expect(claude.requests).toHaveLength(1); // one model call, made through the gateway
  });

  it("FR-EVD-002 a push after review invalidates the evidence until the new head is reviewed again", async () => {
    const head = await authorPr();
    expect(await runAgent(await reviewerEnv(head), silent)).toBe(RUN_EXIT_CODES.succeeded);
    expect((await signer.signPullRequest("org/product", 1, "dummy")).signed).toBe(true);

    const newHead = github.pushAsHuman("org/product", "task/PILOT-1", { "docs/dummy/PILOT-1.md": "edited after review" });
    await github.setCommitStatus("org/product", newHead, { context: "adlc/verify", state: "success", description: "verify passed" });
    expect(await signer.signPullRequest("org/product", 1, "dummy")).toEqual({ signed: false, headSha: newHead, reasons: ["missing verdict from required reviewer dummy-reviewer"] });

    expect(await runAgent(await reviewerEnv(newHead), silent)).toBe(RUN_EXIT_CODES.succeeded);
    expect(await signer.signPullRequest("org/product", 1, "dummy")).toMatchObject({ signed: true, headSha: newHead });
  });

  it("FR-EVD-002 a reviewer that asks for changes blocks signing", async () => {
    const head = await authorPr();
    claude.reply = "CHANGES: the file is empty";
    expect(await runAgent(await reviewerEnv(head), silent)).toBe(RUN_EXIT_CODES.succeeded);
    expect(await signer.signPullRequest("org/product", 1, "dummy")).toMatchObject({ signed: false, reasons: ["dummy-reviewer requested changes"] });
  });

  it("a review run without a PR, head or model fails cleanly", async () => {
    const noModel = await reviewerEnv("a".repeat(40));
    delete noModel.ADLC_MODEL;
    expect(await runAgent(noModel, silent)).toBe(RUN_EXIT_CODES.failed);
  });
});
