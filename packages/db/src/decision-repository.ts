import { assertDecisionInvariants, decisionMachine, formatDecisionId, stateHash, type Actor, type DecisionStatus } from "@adlc/domain";
import type { DecisionInput } from "@adlc/schemas";
import { and, desc, eq, sql } from "drizzle-orm";
import { AuditRepository } from "./audit-repository.js";
import type { DbExecutor } from "./client.js";
import { decision } from "./schema.js";

export type DecisionRow = typeof decision.$inferSelect;

export class DecisionNotFoundError extends Error {
  override name = "DecisionNotFoundError";
}

const decisionHash = (d: DecisionRow) => stateHash({ id: d.id, status: d.status, outcome: d.outcome, decidedBy: d.decidedBy });

/** Decisions (spec.md §5, SDD §8.6). Timeboxes and escalation are the Decision engine (Phase 2). */
export class DecisionRepository {
  constructor(private readonly db: DbExecutor) {}

  async raise(input: DecisionInput, actor: Actor, now: Date): Promise<DecisionRow> {
    assertDecisionInvariants(input);
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ n: string }>(sql`select nextval('decision_number_seq') as n`);
      const id = formatDecisionId(Number(rows[0]?.n));
      const [row] = await tx
        .insert(decision)
        .values({
          id,
          projectId: input.projectId,
          taskKey: input.taskKey ?? null,
          class: input.class,
          route: input.route,
          question: input.question,
          options: input.options,
          owner: input.owner,
          raisedBy: `${actor.kind}:${actor.id}`,
          timeboxMinutes: input.timeboxMinutes,
          dueAt: new Date(now.getTime() + input.timeboxMinutes * 60_000),
          reversible: input.reversible,
          autoResolve: input.autoResolve,
          createdAt: now,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      await new AuditRepository(tx).append({
        actor,
        action: "decision.raise",
        target: `decision:${id}`,
        reason: `${input.class} Decision routed ${input.route} to ${input.owner}`,
        beforeHash: null,
        afterHash: decisionHash(row),
        correlation: { projectId: input.projectId, taskKey: input.taskKey },
      });
      return row;
    });
  }

  async get(id: string): Promise<DecisionRow> {
    const [row] = await this.db.select().from(decision).where(eq(decision.id, id));
    if (!row) throw new DecisionNotFoundError(`${id} not found`);
    return row;
  }

  async list(projectId: string, status?: DecisionStatus, limit = 50): Promise<DecisionRow[]> {
    return this.db
      .select()
      .from(decision)
      .where(and(eq(decision.projectId, projectId), status ? eq(decision.status, status) : undefined))
      .orderBy(desc(decision.createdAt))
      .limit(limit);
  }

  /** Records an outcome. Who may answer which class is the caller's policy (gateway, portal). */
  async answer(id: string, outcome: string, actor: Actor, now: Date): Promise<DecisionRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(decision).where(eq(decision.id, id)).for("update");
      if (!row) throw new DecisionNotFoundError(`${id} not found`);
      decisionMachine.assertTransition(row.status as DecisionStatus, "decided");
      const [updated] = await tx
        .update(decision)
        .set({ status: "decided", outcome, decidedBy: `${actor.kind}:${actor.id}`, decidedAt: now })
        .where(eq(decision.id, id))
        .returning();
      if (!updated) throw new Error("update returned no row");
      await new AuditRepository(tx).append({
        actor,
        action: "decision.answer",
        target: `decision:${id}`,
        reason: `decided: ${outcome.slice(0, 200)}`,
        beforeHash: decisionHash(row),
        afterHash: decisionHash(updated),
        correlation: { projectId: row.projectId, taskKey: row.taskKey ?? undefined },
      });
      return updated;
    });
  }
}
