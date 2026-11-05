import "reflect-metadata";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EnvSecretProvider } from "@adlc/adapters";
import { HeartbeatService, KillSwitch } from "@adlc/control-plane";
import { leaseDeadline, LEASE_TTL_MS, type Actor } from "@adlc/domain";
import { AgentRunRepository, AuditRepository, ControlFlagRepository, createDb, GatewaySessionRepository, LeaseRepository, runMigrations, type Db } from "@adlc/db";
import { RUN_EXIT_CODES } from "@adlc/executor/contract";
import { Gateway, GatewayModule, loadRolePolicies } from "@adlc/gateway";
import { allTools } from "@adlc/mcp-servers";
import { createLogger } from "@adlc/telemetry";
import { FakeIssueTracker, FakeSourceControl, freshDatabase, seedProjectAndDefinition, skipIntegration, type TestDatabase } from "@adlc/testing";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dummyFileContent, dummyFilePath, runAgent } from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const svc: Actor = { kind: "service", id: "adlc-orchestrator" };

class TestClock {
  constructor(public current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
}

/** Captures the agent's structured log lines so tests can check what it reported (and leaked). */
function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger("agent-runtime-test", { level: "debug", destination: { write: (s: string) => lines.push(s) } });
  return { logger, lines };
}

describe.skipIf(skipIntegration)("P0-WP4 dummy agent through the real gateway", () => {
  let t: TestDatabase;
  let db: Db;
  let app: INestApplication;
  let clock: TestClock;
  let jira: FakeIssueTracker;
  let github: FakeSourceControl;
  let env: Record<string, string>;
  let runId: string;

  beforeEach(async () => {
    t = await freshDatabase({ migrate: (pool) => runMigrations(createDb(pool)) });
    db = createDb(t.pool);
    clock = new TestClock(new Date());
    const seed = await seedProjectAndDefinition(t.pool); // agent definition role: "dummy"
    await t.pool.query("update project set jira_project_key = 'PILOT', repos = '[\"org/product\"]'::jsonb where id = $1", [seed.projectId]);
    const run = await new AgentRunRepository(db).create({ agentDefinitionId: seed.agentDefinitionId, projectId: seed.projectId, kind: "task-pipeline", taskKey: "PILOT-1" }, svc, clock.now());
    runId = run.id;
    const { lease } = await new LeaseRepository(db).acquire({ taskKey: "PILOT-1", runId, deadlineAt: leaseDeadline(clock.now(), "S"), now: clock.now() });
    const token = await new GatewaySessionRepository(db).issue({ runId, role: "dummy", projectId: seed.projectId, taskKey: "PILOT-1", fencingToken: lease.fencingToken, expiresAt: lease.deadlineAt }, clock.now());

    jira = new FakeIssueTracker();
    jira.seed({ key: "PILOT-1", type: "Task", status: "In Progress", summary: "Add a dummy document", description: "" });
    github = new FakeSourceControl();
    github.seedRepo("org/product", { "README.md": "product" });
    const gateway = new Gateway({
      db,
      tools: allTools,
      policies: await loadRolePolicies(path.join(repoRoot, "agents")), // the real agents/dummy/policy.yaml
      adapters: { jira, github },
      secrets: new EnvSecretProvider({}),
      heartbeats: new HeartbeatService(new LeaseRepository(db), new KillSwitch(new ControlFlagRepository(db), clock), clock),
      clock,
      logger: createLogger("gateway-test", { level: "silent" }),
    });
    app = await NestFactory.create(GatewayModule.forRoot(gateway), { logger: false });
    await app.listen(0);
    const base = (await app.getUrl()).replace("[::1]", "localhost");
    env = { ADLC_GATEWAY_URL: base, ADLC_GATEWAY_TOKEN: token, ADLC_RUN_ID: runId, ADLC_TASK_KEY: "PILOT-1", ADLC_ROLE: "dummy", ADLC_REPO: "org/product", ADLC_HEARTBEAT_MS: "50" };
  });

  afterEach(async () => {
    await app.close();
    await t.close();
  });

  it("P0-WP4 the dummy agent edits a file on its task branch and opens a PR — only through the gateway", async () => {
    const { logger } = captureLogger();
    expect(await runAgent(env, logger)).toBe(RUN_EXIT_CODES.succeeded);

    const file = await github.getFile("org/product", "task/PILOT-1", dummyFilePath("PILOT-1"));
    expect(file?.content).toBe(dummyFileContent({ key: "PILOT-1", summary: "Add a dummy document" }, runId));
    expect(github.pullRequests).toEqual([expect.objectContaining({ head: "task/PILOT-1", base: "main", title: "PILOT-1: dummy change" })]);
    expect(jira.comments).toEqual([{ key: "PILOT-1", body: `Pull request #1 opened by run ${runId}.` }]);
    expect(await github.getFile("org/product", "main", dummyFilePath("PILOT-1"))).toBeNull(); // main untouched

    const toolCalls = (await new AuditRepository(db).list()).filter((e) => e.action.startsWith("tool.")).map((e) => `${e.action}:${e.reason}`);
    expect(toolCalls).toEqual([
      "tool.jira.read_issue:allowed",
      "tool.github.get_branch:allowed",
      "tool.github.create_branch:allowed",
      "tool.github.read_file:allowed",
      "tool.github.commit_files:allowed",
      "tool.github.open_pull_request:allowed",
      "tool.jira.comment:allowed",
    ]);
    expect((await new AgentRunRepository(db).get(runId))?.heartbeatAt).not.toBeNull();
  });

  it("AT-P0-03 a resumed run continues on the existing branch and does not commit the same change twice", async () => {
    const { logger } = captureLogger();
    expect(await runAgent(env, logger)).toBe(RUN_EXIT_CODES.succeeded);
    const commitsBefore = github.calls.filter((c) => c.startsWith("commit")).length;
    expect(await runAgent(env, logger)).toBe(RUN_EXIT_CODES.succeeded);
    expect(github.calls.filter((c) => c.startsWith("commit")).length).toBe(commitsBefore);
    expect(github.calls.filter((c) => c.startsWith("createBranch")).length).toBe(1);
  });

  it("FR-ORC-012 with the kill switch engaged the run finishes its step and stops with exit 3, writing nothing", async () => {
    await new KillSwitch(new ControlFlagRepository(db), clock).engage({ kind: "human", id: "op" }, "drill");
    const { logger, lines } = captureLogger();
    expect(await runAgent(env, logger)).toBe(RUN_EXIT_CODES.stoppedByDirective);
    expect(github.calls.some((c) => c.startsWith("createBranch") || c.startsWith("commit"))).toBe(false);
    expect(lines.join("")).toContain('"afterStep":"read-task"');
  });

  it("FR-ORC-008 a run whose lease is gone does not start, and exits 1", async () => {
    clock.current = new Date(clock.current.getTime() + LEASE_TTL_MS + 1);
    const { logger } = captureLogger();
    expect(await runAgent(env, logger)).toBe(RUN_EXIT_CODES.failed);
    expect(jira.calls).toEqual([]);
    expect(github.calls).toEqual([]);
  });

  it("hard rule 9: a bad environment fails cleanly and the session token never appears in logs", async () => {
    const { logger, lines } = captureLogger();
    expect(await runAgent({ ...env, ADLC_REPO: "not a repo" }, logger)).toBe(RUN_EXIT_CODES.failed);
    expect(await runAgent({ ...env, ADLC_ROLE: "engineer" }, logger)).toBe(RUN_EXIT_CODES.failed);
    expect(await runAgent(env, logger)).toBe(RUN_EXIT_CODES.succeeded);
    const all = lines.join("");
    expect(all).toContain('"invalid":["ADLC_REPO"]');
    expect(all).not.toContain(env.ADLC_GATEWAY_TOKEN);
  });

  it("an unreachable gateway fails the run with exit 1 instead of hanging", async () => {
    const { logger } = captureLogger();
    expect(await runAgent({ ...env, ADLC_GATEWAY_URL: "http://127.0.0.1:9" }, logger)).toBe(RUN_EXIT_CODES.failed);
  });
});
