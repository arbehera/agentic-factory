import { leaseDeadline, type Actor } from "@adlc/domain";
import { AgentRunRepository, AuditRepository, createDb, GatewaySessionRepository, LeaseRepository, NotificationRepository, runMigrations } from "@adlc/db";
import { RUN_EXIT_CODES } from "@adlc/executor";
import { buildOrchestrator, loadConfig, type Orchestrator } from "@adlc/orchestrator";
import { ManualClock } from "@adlc/control-plane";
import { createLogger } from "@adlc/telemetry";
import { FakeExecutorBackend, FakeIssueTracker, freshDatabase, seedProjectAndDefinition, skipIntegration, type TestDatabase } from "@adlc/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotifierService } from "../src/index.js";
import { CALENDAR, FakeEmail, ROTA } from "./helpers.js";

const ist = (local: string) => new Date(`${local}+05:30`);
const silent = createLogger("at-p0-02", { level: "silent" });
const svc: Actor = { kind: "service", id: "adlc-orchestrator" };

describe.skipIf(skipIntegration)("AT-P0-02 a failed run reaches a human and escalates until acknowledged", () => {
  let t: TestDatabase;
  let orch: Orchestrator;
  let clock: ManualClock;
  let exec: FakeExecutorBackend;
  let jira: FakeIssueTracker;
  let email: FakeEmail;
  let notifier: NotifierService;
  let notifications: NotificationRepository;

  beforeEach(async () => {
    t = await freshDatabase({ migrate: (pool) => runMigrations(createDb(pool)) });
    clock = new ManualClock(ist("2026-11-05T13:30:00")); // Thursday, working hours
    exec = new FakeExecutorBackend();
    jira = new FakeIssueTracker();
    jira.seed({ key: "PILOT-1", type: "Task", status: "In Progress", summary: "dummy", description: "" });
    orch = buildOrchestrator(
      loadConfig({ DATABASE_URL: t.url, AGENT_IMAGE: `agent@sha256:${"d".repeat(64)}`, AGENT_GATEWAY_URL: "http://adlc-gateway:3001" }),
      { clock, logger: silent, executor: exec, issues: jira },
    );
    notifications = new NotificationRepository(orch.db);
    email = new FakeEmail();
    notifier = new NotifierService(notifications, email, ROTA, CALENDAR, "https://portal.example.invalid", clock, silent);
  });
  afterEach(async () => {
    await orch.close();
    await t.close();
  });

  it("AT-P0-02 forced failure → Jira Needs Human + email and inbox to on-duty → backup → Program Lead → acknowledged", async () => {
    // A running dummy task (claimed and launched as the dispatcher and worker would).
    const seed = await seedProjectAndDefinition(t.pool); // role "dummy"
    const run = await new AgentRunRepository(orch.db).create({ agentDefinitionId: seed.agentDefinitionId, projectId: seed.projectId, kind: "task-pipeline", taskKey: "PILOT-1" }, svc, clock.now());
    const { lease } = await new LeaseRepository(orch.db).acquire({ taskKey: "PILOT-1", runId: run.id, deadlineAt: leaseDeadline(clock.now(), "M"), now: clock.now() });
    await new GatewaySessionRepository(orch.db).issue({ runId: run.id, role: "dummy", projectId: seed.projectId, taskKey: "PILOT-1", fencingToken: lease.fencingToken, expiresAt: lease.deadlineAt }, clock.now());
    await orch.launcher?.launch(run.id);
    const container = exec.byRun(run.id);
    expect(container).toBeDefined();

    // Forced failure.
    exec.exit(container?.containerId ?? "", RUN_EXIT_CODES.failed);
    expect(await orch.supervisor?.tick()).toMatchObject([{ runId: run.id, state: "failed" }]);
    expect(jira.issues.get("PILOT-1")?.status).toBe("Needs Human");
    expect((await new AuditRepository(orch.db).list()).map((e) => e.action)).toContain("task.status");

    // On-duty member: email + portal inbox.
    await notifier.tick();
    expect(email.sent.map((m) => m.to)).toEqual([["onduty@example.invalid"]]);
    expect(email.sent[0]?.text).toContain(`/runs/${run.id}`);
    expect(await notifications.inbox("onduty@example.invalid")).toHaveLength(1);

    // Not acknowledged within 4 working hours (13:30 → 17:30 IST): the backup.
    clock.advance(4 * 3_600_000 + 60_000);
    await notifier.tick();
    expect(email.sent.at(-1)?.to).toEqual(["backup@example.invalid"]);

    // Still not acknowledged (17:31 + 4 working hours = Friday 12:31): the Program Lead.
    clock.advance(19 * 3_600_000);
    await notifier.tick();
    expect(email.sent.at(-1)?.to).toEqual(["lead@example.invalid"]);

    // The lead acknowledges in the portal; escalation stops.
    const [item] = await notifications.inbox("lead@example.invalid");
    await notifications.acknowledge(item?.id ?? "", { kind: "human", id: "program-lead" }, clock.now());
    clock.advance(48 * 3_600_000);
    expect(await notifier.tick()).toEqual({ routed: 0, escalated: 0, delivered: 0, failed: 0 });
    expect(email.sent).toHaveLength(3);
  });

  it("AT-P0-02 a second failure of the same task merges into the open notification", async () => {
    const seed = await seedProjectAndDefinition(t.pool);
    for (let i = 0; i < 2; i++) {
      const run = await new AgentRunRepository(orch.db).create({ agentDefinitionId: seed.agentDefinitionId, projectId: seed.projectId, kind: "task-pipeline", taskKey: "PILOT-1" }, svc, clock.now());
      await new LeaseRepository(orch.db).acquire({ taskKey: "PILOT-1", runId: run.id, deadlineAt: leaseDeadline(clock.now(), "S"), now: clock.now() });
      await orch.launcher?.launch(run.id);
      exec.exit(exec.byRun(run.id)?.containerId ?? "", 1);
      await orch.supervisor?.tick();
    }
    await notifier.tick();
    expect(email.sent).toHaveLength(1);
  });
});
