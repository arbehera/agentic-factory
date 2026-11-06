import { AgentRunRepository, BudgetLedgerRepository, StaleFencingTokenError, type LeaseRepository } from "@adlc/db";
import { BudgetService, type BudgetLevels } from "./budget-service.js";
import type { Clock } from "./clock.js";
import type { KillSwitch } from "./kill-switch.js";

export type RunDirective = "continue" | "stop-after-step";

export interface Heartbeat {
  runId: string;
  projectId: string;
  taskKey: string;
  fencingToken: bigint;
  /** Usage since the previous heartbeat. */
  usage: { tokens: number; costUsd: number };
}

export interface HeartbeatReply {
  expiresAt: Date;
  directive: RunDirective;
  budgets: BudgetLevels;
}

/**
 * Heartbeats (FR-ORC-008, 011, 012). Renews the lease for the current fencing token only, then
 * records liveness and usage inside a fenced transaction. A stale or expired lease throws: the
 * executor must stop. The reply tells the run to stop after its step if the kill switch is
 * engaged or its task budget is exhausted.
 */
export class HeartbeatService {
  constructor(
    private readonly leases: LeaseRepository,
    private readonly killSwitch: KillSwitch,
    private readonly clock: Clock,
  ) {}

  async beat(hb: Heartbeat): Promise<HeartbeatReply> {
    const now = this.clock.now();
    const ref = { taskKey: hb.taskKey, fencingToken: hb.fencingToken };
    const lease = await this.leases.renew(ref, now);
    if (lease.runId !== hb.runId) throw new StaleFencingTokenError(`lease on ${hb.taskKey} belongs to run ${lease.runId}, not ${hb.runId}`);
    const budgets = await this.leases.withFence(ref, now, async (tx) => {
      await new AgentRunRepository(tx).heartbeat(hb.runId, now);
      return BudgetService.record(new BudgetLedgerRepository(tx), { projectId: hb.projectId, taskKey: hb.taskKey, ...hb.usage }, now);
    });
    const stop = budgets.task === "exhausted" || (await this.killSwitch.isEngaged());
    return { expiresAt: lease.expiresAt, directive: stop ? "stop-after-step" : "continue", budgets };
  }
}
