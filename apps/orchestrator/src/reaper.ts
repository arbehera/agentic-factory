import { leaseExpiryReason } from "@adlc/domain";
import type { AgentRunRepository, LeaseRepository } from "@adlc/db";
import type { Clock } from "@adlc/control-plane";
import { retireRun } from "./runs.js";

export interface ReapedLease {
  taskKey: string;
  runId: string;
  reason: string;
}

/**
 * Lease reaper (leader only, FR-ORC-008). Expired leases are removed so the task can be claimed
 * again, and their runs are retired. The next executor resumes from the task's WIP branch (P0-WP4).
 */
export class Reaper {
  constructor(
    private readonly leases: LeaseRepository,
    private readonly runs: AgentRunRepository,
    private readonly clock: Clock,
  ) {}

  async tick(): Promise<ReapedLease[]> {
    const now = this.clock.now();
    const reaped = await this.leases.reapExpired(now);
    const out: ReapedLease[] = [];
    for (const l of reaped) {
      const reason = `lease expired: ${leaseExpiryReason(l)}`;
      await retireRun(this.runs, l.runId, reason, now);
      out.push({ taskKey: l.taskKey, runId: l.runId, reason });
    }
    return out;
  }
}
