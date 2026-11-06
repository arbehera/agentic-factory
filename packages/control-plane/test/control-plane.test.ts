import { leaseDeadline, LEASE_TTL_MS, type Actor } from "@adlc/domain";
import { AgentRunRepository, BudgetLedgerRepository, ControlFlagRepository, createDb, LeaseExpiredError, LeaseRepository, runMigrations, StaleFencingTokenError, type Db } from "@adlc/db";
import { freshDatabase, seedProjectAndDefinition, skipIntegration, type TestDatabase } from "@adlc/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetKeys, BudgetService, HeartbeatService, KillSwitch, KillSwitchError, ManualClock, systemClock } from "../src/index.js";

const human: Actor = { kind: "human", id: "operator-1" };
const svc: Actor = { kind: "service", id: "adlc-orchestrator" };

describe.skipIf(skipIntegration)("P0-WP3 control-plane services", () => {
  let t: TestDatabase;
  let db: Db;
  let clock: ManualClock;
  let seed: { projectId: string; agentDefinitionId: string };
  let kill: KillSwitch;
  let heartbeats: HeartbeatService;
  let leases: LeaseRepository;

  async function leasedRun(taskKey: string) {
    const run = await new AgentRunRepository(db).create({ agentDefinitionId: seed.agentDefinitionId, projectId: seed.projectId, kind: "task-pipeline", taskKey }, svc, clock.now());
    const { lease } = await leases.acquire({ taskKey, runId: run.id, deadlineAt: leaseDeadline(clock.now(), "S"), now: clock.now() });
    return { runId: run.id, projectId: seed.projectId, taskKey, fencingToken: lease.fencingToken };
  }

  beforeAll(async () => {
    t = await freshDatabase({ migrate: (pool) => runMigrations(createDb(pool)) });
    db = createDb(t.pool);
    clock = new ManualClock(new Date("2026-11-05T08:00:00.000Z"));
    seed = await seedProjectAndDefinition(t.pool);
    kill = new KillSwitch(new ControlFlagRepository(db), clock);
    leases = new LeaseRepository(db);
    heartbeats = new HeartbeatService(leases, kill, clock);
  });
  afterAll(async () => {
    await t.close();
  });

  it("FR-ORC-012 kill switch: anyone may engage with a reason; only a human may release", async () => {
    expect(await kill.isEngaged()).toBe(false);
    await expect(kill.engage(svc, "  ")).rejects.toBeInstanceOf(KillSwitchError);
    await kill.engage(svc, "budget guard");
    expect(await kill.isEngaged()).toBe(true);
    await expect(kill.release(svc, "auto")).rejects.toThrow(/only a human/);
    await expect(kill.release(human, "")).rejects.toThrow(/reason/);
    await kill.release(human, "resolved");
    expect(await kill.isEngaged()).toBe(false);
  });

  it("FR-ORC-008 heartbeat renews the lease, records usage, and answers continue", async () => {
    const hb = await leasedRun("CP-1");
    clock.advance(5 * 60_000);
    const reply = await heartbeats.beat({ ...hb, usage: { tokens: 10, costUsd: 0.01 } });
    expect(reply).toMatchObject({ directive: "continue", budgets: { task: "ok", day: "ok", month: "ok" } });
    expect(reply.expiresAt).toEqual(new Date(clock.now().getTime() + LEASE_TTL_MS));
    expect((await new BudgetLedgerRepository(db).get(budgetKeys(hb.projectId, "CP-1", clock.now())[0]))?.tokens).toBe(10);
  });

  it("FR-ORC-012 heartbeat answers stop-after-step while the kill switch is engaged", async () => {
    const hb = await leasedRun("CP-2");
    await kill.engage(human, "drill");
    expect((await heartbeats.beat({ ...hb, usage: { tokens: 0, costUsd: 0 } })).directive).toBe("stop-after-step");
    await kill.release(human, "drill over");
  });

  it("FR-ORC-011 heartbeat answers stop-after-step when the task token cap is exhausted; the daily cap blocks claims", async () => {
    const hb = await leasedRun("CP-3");
    const ledger = new BudgetLedgerRepository(db);
    const [taskKey, dayKey] = budgetKeys(hb.projectId, "CP-3", clock.now());
    await ledger.setCap(taskKey, { capUsd: null, capTokens: 100 }, human, "cap", clock.now());
    await ledger.setCap(dayKey, { capUsd: 1, capTokens: null }, human, "cap", clock.now());
    expect(await heartbeats.beat({ ...hb, usage: { tokens: 100, costUsd: 1 } })).toMatchObject({ directive: "stop-after-step", budgets: { task: "exhausted", day: "exhausted" } });
    const budgets = new BudgetService(ledger);
    expect(await budgets.canClaim(hb.projectId, clock.now())).toBe(false);
    expect(await budgets.canClaim("00000000-0000-0000-0000-000000000000", clock.now())).toBe(true);
  });

  it("FR-ORC-008 heartbeat rejects a stale token, a foreign run and an expired lease", async () => {
    const hb = await leasedRun("CP-4");
    await expect(heartbeats.beat({ ...hb, fencingToken: hb.fencingToken - 1n, usage: { tokens: 0, costUsd: 0 } })).rejects.toBeInstanceOf(StaleFencingTokenError);
    await expect(heartbeats.beat({ ...hb, runId: "00000000-0000-0000-0000-000000000000", usage: { tokens: 0, costUsd: 0 } })).rejects.toBeInstanceOf(StaleFencingTokenError);
    clock.advance(LEASE_TTL_MS);
    await expect(heartbeats.beat({ ...hb, usage: { tokens: 0, costUsd: 0 } })).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it("clocks: the manual clock advances and copies; the system clock is real time", () => {
    const c = new ManualClock(new Date(0));
    const a = c.now();
    a.setTime(99);
    c.advance(5);
    expect(c.now().getTime()).toBe(5);
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
  });
});
