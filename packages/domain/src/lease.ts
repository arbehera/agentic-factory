import type { TaskComplexity } from "./vocabulary.js";

/**
 * Execution-lease timing (FR-ORC-008, SDD §8.4). A lease lives 15 minutes (three heartbeats);
 * each 5-minute heartbeat renews it, but never past the task's wall-clock deadline. A crashed
 * executor is therefore detected within 15 minutes, and a stuck one stops at its budget.
 */

export const LEASE_TTL_MS = 15 * 60_000;
export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

export const WALL_CLOCK_BUDGET_MS: Readonly<Record<TaskComplexity, number>> = {
  S: 1 * 3_600_000,
  M: 4 * 3_600_000,
  L: 8 * 3_600_000,
};

export interface LeaseTiming {
  expiresAt: Date;
  deadlineAt: Date;
}

export function leaseDeadline(acquiredAt: Date, complexity: TaskComplexity): Date {
  return new Date(acquiredAt.getTime() + WALL_CLOCK_BUDGET_MS[complexity]);
}

/** Expiry after a grant or renewal at `now`: now + TTL, capped by the deadline. */
export function nextExpiry(now: Date, deadlineAt: Date): Date {
  return new Date(Math.min(now.getTime() + LEASE_TTL_MS, deadlineAt.getTime()));
}

export function isLeaseLive(lease: LeaseTiming, now: Date): boolean {
  return now.getTime() < lease.expiresAt.getTime();
}

export type RenewalOutcome = { kind: "renewed"; expiresAt: Date } | { kind: "expired" };

/** A lease can only be renewed while live; an expired lease is gone and must be re-acquired. */
export function renewLease(lease: LeaseTiming, now: Date): RenewalOutcome {
  if (!isLeaseLive(lease, now)) return { kind: "expired" };
  return { kind: "renewed", expiresAt: nextExpiry(now, lease.deadlineAt) };
}

export type LeaseExpiryReason = "wall-clock-budget" | "heartbeat-missed";

/** Why a lease expired: it ran into its deadline, or heartbeats stopped before that. */
export function leaseExpiryReason(lease: LeaseTiming): LeaseExpiryReason {
  return lease.expiresAt.getTime() >= lease.deadlineAt.getTime() ? "wall-clock-budget" : "heartbeat-missed";
}
