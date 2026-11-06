import path from "node:path";
import { fileURLToPath } from "node:url";
import { EnvSecretProvider } from "@adlc/adapters";
import { leaseDeadline, type Actor } from "@adlc/domain";
import { AgentRunRepository, ControlFlagRepository, createDb, GatewaySessionRepository, LeaseRepository, runMigrations, type Db } from "@adlc/db";
import { allTools } from "@adlc/mcp-servers";
import { rolePolicySchema, type RolePolicy } from "@adlc/schemas";
import { createLogger, type Logger } from "@adlc/telemetry";
import { FakeIssueTracker, FakeSourceControl, freshDatabase, seedProjectAndDefinition, type TestDatabase } from "@adlc/testing";
import { HeartbeatService, KillSwitch } from "@adlc/control-plane";
import { Gateway } from "../src/gateway.js";

export { skipIntegration } from "@adlc/testing";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const silentLogger: Logger = createLogger("gateway-test", { level: "silent" });
export const SECRET = "jira-api-token-0123456789";

export class TestClock {
  constructor(public current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
}

export const enginePolicy: RolePolicy = rolePolicySchema.parse({
  role: "engineer",
  tools: ["jira.read_issue", "jira.comment", "jira.transition", "github.create_branch", "github.commit_files", "decisions.raise"],
  jira: { transitions: [{ from: "In Progress", to: "In Review" }] },
  github: { branches: ["task/{taskKey}"], writePaths: ["src/**"] },
});

export interface GatewayHarness {
  t: TestDatabase;
  db: Db;
  gateway: Gateway;
  jira: FakeIssueTracker;
  github: FakeSourceControl;
  clock: TestClock;
  token: string;
  runId: string;
  fencingToken: bigint;
  projectId: string;
  close(): Promise<void>;
}

/** A database, a leased task PILOT-1 held by an engineer run, its gateway session and fakes. */
export async function gatewayHarness(policies: RolePolicy[] = [enginePolicy]): Promise<GatewayHarness> {
  const t = await freshDatabase({ migrate: (pool) => runMigrations(createDb(pool)) });
  const db = createDb(t.pool);
  const clock = new TestClock(new Date("2026-11-05T08:00:00.000Z"));
  const seed = await seedProjectAndDefinition(t.pool);
  await t.pool.query("update project set jira_project_key = 'PILOT', repos = '[\"org/product\"]'::jsonb where id = $1", [seed.projectId]);
  const svc: Actor = { kind: "service", id: "adlc-orchestrator" };
  const run = await new AgentRunRepository(db).create({ agentDefinitionId: seed.agentDefinitionId, projectId: seed.projectId, kind: "task-pipeline", taskKey: "PILOT-1" }, svc, clock.now());
  const { lease } = await new LeaseRepository(db).acquire({ taskKey: "PILOT-1", runId: run.id, deadlineAt: leaseDeadline(clock.now(), "S"), now: clock.now() });
  const token = await new GatewaySessionRepository(db).issue(
    { runId: run.id, role: "engineer", projectId: seed.projectId, taskKey: "PILOT-1", fencingToken: lease.fencingToken, expiresAt: new Date(clock.now().getTime() + 3_600_000) },
    clock.now(),
  );

  const jira = new FakeIssueTracker();
  jira.seed({ key: "PILOT-1", type: "Task", status: "In Progress", summary: "dummy task", description: "" });
  jira.seed({ key: "PILOT-2", type: "Gate", status: "Ready for Approval", summary: "G5", description: "" });
  const github = new FakeSourceControl();
  github.seedRepo("org/product", { "src/a.c": "int a;" });
  const secrets = new EnvSecretProvider({ ADLC_SECRET_JIRA_AGENT: SECRET });
  await secrets.get("jira-agent"); // as the gateway does when it builds the Jira adapter

  const heartbeats = new HeartbeatService(new LeaseRepository(db), new KillSwitch(new ControlFlagRepository(db), clock), clock);
  const gateway = new Gateway({ db, tools: allTools, policies: new Map(policies.map((p) => [p.role, p])), adapters: { jira, github }, secrets, heartbeats, clock, logger: silentLogger });
  return { t, db, gateway, jira, github, clock, token, runId: run.id, fencingToken: lease.fencingToken, projectId: seed.projectId, close: () => t.close() };
}
