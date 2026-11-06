import { stateHash, type Actor, type BudgetScope } from "@adlc/domain";
import { and, eq, sql } from "drizzle-orm";
import { AuditRepository } from "./audit-repository.js";
import type { DbExecutor } from "./client.js";
import { budgetLedger } from "./schema.js";

export type BudgetLedgerRow = typeof budgetLedger.$inferSelect;

export interface BudgetKey {
  scope: BudgetScope;
  scopeKey: string;
}

/** Usage ledger (FR-ORC-011). Usage is added atomically; cap changes are audited. */
export class BudgetLedgerRepository {
  constructor(private readonly db: DbExecutor) {}

  /** Adds usage to every key in one transaction and returns the updated rows (input order). */
  async add(keys: readonly BudgetKey[], tokens: number, costUsd: number, now: Date): Promise<BudgetLedgerRow[]> {
    return this.db.transaction(async (tx) => {
      const out: BudgetLedgerRow[] = [];
      for (const k of keys) {
        const [row] = await tx
          .insert(budgetLedger)
          .values({ scope: k.scope, scopeKey: k.scopeKey, tokens, costUsd: costUsd.toFixed(4), updatedAt: now })
          .onConflictDoUpdate({
            target: [budgetLedger.scope, budgetLedger.scopeKey],
            set: {
              tokens: sql`${budgetLedger.tokens} + excluded.tokens`,
              costUsd: sql`${budgetLedger.costUsd} + excluded.cost_usd`,
              updatedAt: now,
            },
          })
          .returning();
        if (!row) throw new Error("upsert returned no row");
        out.push(row);
      }
      return out;
    });
  }

  async setCap(key: BudgetKey, cap: { capUsd: number | null; capTokens: number | null }, actor: Actor, reason: string, now: Date): Promise<BudgetLedgerRow> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(budgetLedger).where(and(eq(budgetLedger.scope, key.scope), eq(budgetLedger.scopeKey, key.scopeKey))).for("update");
      const values = { capUsd: cap.capUsd === null ? null : cap.capUsd.toFixed(4), capTokens: cap.capTokens };
      const [row] = await tx
        .insert(budgetLedger)
        .values({ ...key, ...values, updatedAt: now })
        .onConflictDoUpdate({ target: [budgetLedger.scope, budgetLedger.scopeKey], set: { ...values, updatedAt: now } })
        .returning();
      if (!row) throw new Error("upsert returned no row");
      await new AuditRepository(tx).append({
        actor,
        action: "budget.cap",
        target: `budget:${key.scope}:${key.scopeKey}`,
        reason,
        beforeHash: before ? stateHash({ capUsd: before.capUsd, capTokens: before.capTokens }) : null,
        afterHash: stateHash({ capUsd: row.capUsd, capTokens: row.capTokens }),
        correlation: {},
      });
      return row;
    });
  }

  async get(key: BudgetKey): Promise<BudgetLedgerRow | null> {
    const [row] = await this.db.select().from(budgetLedger).where(and(eq(budgetLedger.scope, key.scope), eq(budgetLedger.scopeKey, key.scopeKey)));
    return row ?? null;
  }
}
