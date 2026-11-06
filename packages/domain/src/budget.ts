/**
 * Budget levels (FR-ORC-011): per-task token caps stop the run, the per-project daily cap
 * pauses claims, and the monthly budget alerts at 80 %.
 */

export const BUDGET_ALERT_RATIO = 0.8;

export type BudgetLevel = "ok" | "alert" | "exhausted";

/** A null cap means "no cap configured" and is always ok. */
export function budgetLevel(used: number, cap: number | null): BudgetLevel {
  if (cap === null) return "ok";
  if (used >= cap) return "exhausted";
  return used >= cap * BUDGET_ALERT_RATIO ? "alert" : "ok";
}

/** UTC bucket keys for the ledger (CLAUDE.md §6: store UTC). */
export function dayBucket(projectId: string, at: Date): string {
  return `${projectId}:${at.toISOString().slice(0, 10)}`;
}

export function monthBucket(projectId: string, at: Date): string {
  return `${projectId}:${at.toISOString().slice(0, 7)}`;
}
