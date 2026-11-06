import { budgetLevel, dayBucket, monthBucket, type BudgetLevel } from "@adlc/domain";
import type { BudgetKey, BudgetLedgerRepository, BudgetLedgerRow } from "@adlc/db";

export interface BudgetLevels {
  /** Per-task token cap: exhausted stops the run after its current step. */
  task: BudgetLevel;
  /** Per-project daily spend cap: exhausted pauses new claims for the project. */
  day: BudgetLevel;
  /** Monthly budget: alert at 80 % (notification wiring: P0-WP10). */
  month: BudgetLevel;
}

export const budgetKeys = (projectId: string, taskKey: string, at: Date): [BudgetKey, BudgetKey, BudgetKey] => [
  { scope: "task", scopeKey: taskKey },
  { scope: "day", scopeKey: dayBucket(projectId, at) },
  { scope: "month", scopeKey: monthBucket(projectId, at) },
];

const tokenLevel = (r: BudgetLedgerRow | null): BudgetLevel => (r ? budgetLevel(r.tokens, r.capTokens) : "ok");
const costLevel = (r: BudgetLedgerRow | null): BudgetLevel =>
  r ? budgetLevel(Number(r.costUsd), r.capUsd === null ? null : Number(r.capUsd)) : "ok";

/** Budgets (FR-ORC-011): usage is recorded per task, project-day and project-month (UTC). */
export class BudgetService {
  /** Records usage through `ledger` (pass a fenced-transaction ledger for task-scoped writes). */
  static async record(
    ledger: BudgetLedgerRepository,
    usage: { projectId: string; taskKey: string; tokens: number; costUsd: number },
    now: Date,
  ): Promise<BudgetLevels> {
    const [task, day, month] = await ledger.add(budgetKeys(usage.projectId, usage.taskKey, now), usage.tokens, usage.costUsd, now);
    return { task: tokenLevel(task ?? null), day: costLevel(day ?? null), month: costLevel(month ?? null) };
  }

  constructor(private readonly ledger: BudgetLedgerRepository) {}

  /** A project may take new claims unless its daily cap is exhausted. */
  async canClaim(projectId: string, now: Date): Promise<boolean> {
    return costLevel(await this.ledger.get({ scope: "day", scopeKey: dayBucket(projectId, now) })) !== "exhausted";
  }
}
