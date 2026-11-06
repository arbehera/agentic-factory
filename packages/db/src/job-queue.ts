import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { job } from "./schema.js";

export type JobRow = typeof job.$inferSelect;

export class JobLockLostError extends Error {
  override name = "JobLockLostError";
}

/**
 * PostgreSQL job queue (hard rule 8). Claiming uses `FOR UPDATE SKIP LOCKED`, so concurrent
 * workers never block each other or take the same job. Locks are leases: a worker that dies
 * loses its jobs when `locked_until` passes. Time is passed in (NFR-008).
 */
export class JobQueue {
  constructor(private readonly db: Db) {}

  /** Enqueues a job; with a dedupe key, enqueueing the same job again is a no-op. True if inserted. */
  async enqueue(input: { kind: string; payload: Record<string, unknown>; dedupeKey?: string; runAfter: Date; maxAttempts?: number }): Promise<boolean> {
    const inserted = await this.db
      .insert(job)
      .values({ kind: input.kind, payload: input.payload, dedupeKey: input.dedupeKey ?? null, runAfter: input.runAfter, maxAttempts: input.maxAttempts ?? 3 })
      .onConflictDoNothing({ target: job.dedupeKey })
      .returning({ id: job.id });
    return inserted.length > 0;
  }

  /** Claims the oldest ready job of the given kinds, or returns null. */
  async claim(workerId: string, kinds: readonly string[], now: Date, lockMs: number): Promise<JobRow | null> {
    return this.db.transaction(async (tx) => {
      const [next] = await tx
        .select({ id: job.id })
        .from(job)
        .where(
          and(
            sql`${job.kind} in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})`,
            isNull(job.doneAt),
            isNull(job.failedAt),
            lte(job.runAfter, now),
            or(isNull(job.lockedUntil), lt(job.lockedUntil, now)),
            lt(job.attempts, job.maxAttempts),
          ),
        )
        .orderBy(asc(job.runAfter), asc(job.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!next) return null;
      const [claimed] = await tx
        .update(job)
        .set({ lockedBy: workerId, lockedUntil: new Date(now.getTime() + lockMs), attempts: sql`${job.attempts} + 1` })
        .where(eq(job.id, next.id))
        .returning();
      return claimed ?? null;
    });
  }

  async complete(id: number, workerId: string, now: Date): Promise<void> {
    await this.mustOwn(id, workerId, { doneAt: now, lockedBy: null, lockedUntil: null });
  }

  /** Records a failure: retried after `retryInMs` until max attempts, then marked failed. */
  async fail(id: number, workerId: string, error: string, now: Date, retryInMs: number): Promise<"retry" | "failed"> {
    const [row] = await this.db.select().from(job).where(eq(job.id, id));
    const exhausted = !row || row.attempts >= row.maxAttempts;
    await this.mustOwn(id, workerId, {
      lastError: error.slice(0, 2000),
      lockedBy: null,
      lockedUntil: null,
      ...(exhausted ? { failedAt: now } : { runAfter: new Date(now.getTime() + retryInMs) }),
    });
    return exhausted ? "failed" : "retry";
  }

  async get(id: number): Promise<JobRow | null> {
    const [row] = await this.db.select().from(job).where(eq(job.id, id));
    return row ?? null;
  }

  private async mustOwn(id: number, workerId: string, set: Partial<typeof job.$inferInsert>): Promise<void> {
    const updated = await this.db.update(job).set(set).where(and(eq(job.id, id), eq(job.lockedBy, workerId))).returning({ id: job.id });
    if (updated.length === 0) throw new JobLockLostError(`job ${id} is no longer locked by ${workerId}`);
  }
}
