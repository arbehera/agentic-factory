import { LEASE_TTL_MS, type Actor } from "@adlc/domain";
import { AgentRunRepository, AuditRepository, BudgetLedgerRepository, LeaseRepository, StaleFencingTokenError } from "@adlc/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { budgetKeys } from "../src/budget-service.js";
import type { Claim } from "../src/dispatcher.js";
import { KillSwitchError } from "../src/kill-switch.js";
import { candidate, harness, skipIntegration, type Harness } from "./helpers.js";

const operator: Actor = { kind: "human", id: "operator-1" };
const FIVE_MIN = 5 * 60_000;

describe.skipIf(skipIntegration)("P0-WP3 orchestrator control plane", () => {
  let h: Harness;
  let runs: AgentRunRepository;
  const beat = (c: Claim, usage = { tokens: 0, costUsd: 0 }) =>
    h.orch.heartbeats.beat({ runId: c.runId, projectId: h.seed.projectId, taskKey: c.taskKey, fencingToken: c.fencingToken, usage });
  const claimOne = async (): Promise<Claim> => {
    const r = await h.orch.dispatcher.tick();
    const [c] = r.claimed;
    if (!c) throw new Error(`nothing claimed: ${JSON.stringify(r.skipped)}`);
    return c;
  };

  beforeEach(async () => {
    h = await harness();
    runs = new AgentRunRepository(h.orch.db);
  });
  afterEach(async () => {
    await h.close();
  });

  it("AT-P0-03 a killed executor's task is re-claimed under a new lease; the old token is rejected", async () => {
    h.source.queue = [candidate(h, "PILOT-1", "M")];
    const first = await claimOne();
    await runs.transition(first.runId, "starting", operator, "container created", h.clock.now());
    await runs.transition(first.runId, "running", operator, "started", h.clock.now());
    h.clock.advance(FIVE_MIN);
    expect((await beat(first)).directive).toBe("continue");

    // The container is killed: no more heartbeats. Within one TTL the lease expires.
    h.clock.advance(LEASE_TTL_MS);
    expect(await h.orch.reaper.tick()).toEqual([{ taskKey: "PILOT-1", runId: first.runId, reason: "lease expired: heartbeat-missed" }]);
    expect((await runs.get(first.runId))?.state).toBe("lost");

    const second = await claimOne();
    expect(second.runId).not.toBe(first.runId);
    expect(second.fencingToken > first.fencingToken).toBe(true);
    await expect(beat(first)).rejects.toBeInstanceOf(StaleFencingTokenError);
    expect((await beat(second)).directive).toBe("continue");
  });

  it("FR-ORC-008 a live lease is not claimed twice; the extra run is stopped", async () => {
    h.source.queue = [candidate(h, "PILOT-2")];
    const c = await claimOne();
    const again = await h.orch.dispatcher.tick();
    expect(again.claimed).toEqual([]);
    expect(again.skipped).toEqual([{ taskKey: "PILOT-2", reason: "task already leased" }]);
    expect(await new LeaseRepository(h.orch.db).get("PILOT-2")).toMatchObject({ runId: c.runId });
  });

  it("FR-ORC-008 an expired lease that was not reaped yet is displaced at claim time and its run retired", async () => {
    h.source.queue = [candidate(h, "PILOT-3")];
    const first = await claimOne(); // queued run, never started
    h.clock.advance(LEASE_TTL_MS + 1);
    const second = await claimOne();
    expect(second.runId).not.toBe(first.runId);
    expect((await runs.get(first.runId))?.state).toBe("stopped");
  });

  it("FR-ORC-008 heartbeats cannot extend a lease past the wall-clock budget (S = 1 h)", async () => {
    h.source.queue = [candidate(h, "PILOT-4", "S")];
    const c = await claimOne();
    await runs.transition(c.runId, "starting", operator, "x", h.clock.now());
    await runs.transition(c.runId, "running", operator, "x", h.clock.now());
    for (let i = 0; i < 11; i++) {
      h.clock.advance(FIVE_MIN);
      await beat(c);
    }
    h.clock.advance(FIVE_MIN); // t = 60 min: the deadline
    await expect(beat(c)).rejects.toThrow(/expired/);
    expect(await h.orch.reaper.tick()).toEqual([{ taskKey: "PILOT-4", runId: c.runId, reason: "lease expired: wall-clock-budget" }]);
  });

  it("FR-ORC-012 the kill switch stops all claims and tells running steps to stop; only a human releases it", async () => {
    h.source.queue = [candidate(h, "PILOT-5"), candidate(h, "PILOT-6")];
    const r = await h.orch.dispatcher.tick();
    const c = r.claimed[0];
    if (!c) throw new Error("no claim");
    h.source.queue = [candidate(h, "PILOT-7")];

    await h.orch.killSwitch.engage({ kind: "service", id: "budget-guard" }, "incident drill");
    expect(await h.orch.dispatcher.tick()).toEqual({ paused: "kill-switch", claimed: [], skipped: [] });
    expect((await beat(c)).directive).toBe("stop-after-step");

    await expect(h.orch.killSwitch.release({ kind: "service", id: "x" }, "auto")).rejects.toBeInstanceOf(KillSwitchError);
    await expect(h.orch.killSwitch.release(operator, " ")).rejects.toThrow(/reason/);
    await expect(h.orch.killSwitch.engage(operator, "")).rejects.toThrow(/reason/);
    await h.orch.killSwitch.release(operator, "drill complete");
    expect((await h.orch.dispatcher.tick()).claimed.map((x) => x.taskKey)).toEqual(["PILOT-7"]);
    expect((await beat(c)).directive).toBe("continue");

    const flagEvents = (await new AuditRepository(h.orch.db).list()).filter((e) => e.action === "control.flag");
    expect(flagEvents.map((e) => [e.actor.id, e.reason])).toEqual([
      ["budget-guard", "engaged: incident drill"],
      ["operator-1", "released: drill complete"],
    ]);
  });

  it("FR-ORC-011 the task token cap stops the run; the project daily cap pauses claims; month alerts at 80 %", async () => {
    const ledger = new BudgetLedgerRepository(h.orch.db);
    const [taskKey, dayKey, monthKey] = budgetKeys(h.seed.projectId, "PILOT-8", h.clock.now());
    await ledger.setCap(taskKey, { capUsd: null, capTokens: 10_000 }, operator, "task budget", h.clock.now());
    await ledger.setCap(dayKey, { capUsd: 20, capTokens: null }, operator, "daily cap", h.clock.now());
    await ledger.setCap(monthKey, { capUsd: 20, capTokens: null }, operator, "monthly budget", h.clock.now());

    h.source.queue = [candidate(h, "PILOT-8")];
    const c = await claimOne();
    expect(await beat(c, { tokens: 7_000, costUsd: 10 })).toMatchObject({ directive: "continue", budgets: { task: "ok", day: "ok", month: "ok" } });
    expect(await beat(c, { tokens: 1_000, costUsd: 6 })).toMatchObject({ directive: "continue", budgets: { task: "alert", day: "alert", month: "alert" } });
    expect(await beat(c, { tokens: 2_000, costUsd: 4 })).toMatchObject({ directive: "stop-after-step", budgets: { task: "exhausted", day: "exhausted" } });

    h.source.queue = [candidate(h, "PILOT-9")];
    expect(await h.orch.dispatcher.tick()).toMatchObject({ claimed: [], skipped: [{ taskKey: "PILOT-9", reason: "project daily budget exhausted" }] });
    h.clock.advance(24 * 3_600_000); // next UTC day: a fresh daily bucket
    expect((await h.orch.dispatcher.tick()).claimed.map((x) => x.taskKey)).toEqual(["PILOT-9"]);
  });

  it("FR-ORC-008 a heartbeat must come from the run that holds the lease", async () => {
    h.source.queue = [candidate(h, "PILOT-10")];
    const c = await claimOne();
    await expect(beat({ ...c, runId: "00000000-0000-0000-0000-000000000000" })).rejects.toBeInstanceOf(StaleFencingTokenError);
  });

  it("hard rule 11: every claim, expiry and control is in a verifiable audit chain", async () => {
    h.source.queue = [candidate(h, "PILOT-11")];
    await claimOne();
    h.clock.advance(LEASE_TTL_MS);
    await h.orch.reaper.tick();
    const audit = new AuditRepository(h.orch.db);
    expect((await audit.list()).map((e) => e.action)).toEqual(["run.create", "lease.acquire", "lease.expire", "run.state"]);
    expect(await audit.verify()).toMatchObject({ ok: true });
  });
});
