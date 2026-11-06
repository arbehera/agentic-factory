import { isLeaseLive, nextExpiry, renewLease, stateHash, type Actor } from "@adlc/domain";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { LEASE_LOCK_NAMESPACE } from "./advisory-locks.js";
import { AuditRepository } from "./audit-repository.js";
import type { Db, DbTx } from "./client.js";
import { lease } from "./schema.js";

export type LeaseRow = typeof lease.$inferSelect;

/** The lease is held by a live executor; the caller must not dispatch the task. */
export class LeaseHeldError extends Error {
  override name = "LeaseHeldError";
}
/** The fencing token is not the task's current one: the caller lost its lease (FR-ORC-008). */
export class StaleFencingTokenError extends Error {
  override name = "StaleFencingTokenError";
}
/** The caller still holds the current token, but the lease has expired; it must stop. */
export class LeaseExpiredError extends Error {
  override name = "LeaseExpiredError";
}

export interface FenceRef {
  taskKey: string;
  fencingToken: bigint;
}

const ORCHESTRATOR: Actor = { kind: "service", id: "adlc-orchestrator" };
const leaseHash = (l: LeaseRow) => stateHash({ taskKey: l.taskKey, runId: l.runId, fencingToken: l.fencingToken.toString() });

/**
 * Execution leases with fencing (FR-ORC-008). Tokens come from one global sequence, so every
 * grant gets a token greater than any before it. Time is always passed in (NFR-008).
 * Grants, releases and expiries are audited; renewals are liveness and are not (ADR-0009).
 */
export class LeaseRepository {
  constructor(private readonly db: Db) {}

  /**
   * Grants the lease for `taskKey` to `runId`. An expired lease still on the row is displaced and
   * returned, so the caller can mark its run lost. A live lease throws LeaseHeldError.
   */
  async acquire(args: { taskKey: string; runId: string; deadlineAt: Date; now: Date }): Promise<{ lease: LeaseRow; displaced: LeaseRow | null }> {
    const { taskKey, runId, deadlineAt, now } = args;
    return this.db.transaction(async (tx) => {
      // Serialise concurrent acquirers of the same task, including when no row exists yet.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${LEASE_LOCK_NAMESPACE + taskKey}, 0))`);
      const [current] = await tx.select().from(lease).where(eq(lease.taskKey, taskKey)).for("update");
      if (current && isLeaseLive(current, now)) {
        throw new LeaseHeldError(`${taskKey} is leased by run ${current.runId} until ${current.expiresAt.toISOString()}`);
      }
      if (current) await tx.delete(lease).where(eq(lease.taskKey, taskKey));
      const [granted] = await tx
        .insert(lease)
        .values({ taskKey, runId, acquiredAt: now, expiresAt: nextExpiry(now, deadlineAt), deadlineAt })
        .returning();
      if (!granted) throw new Error("insert returned no row");
      await new AuditRepository(tx).append({
        actor: ORCHESTRATOR,
        action: "lease.acquire",
        target: `task:${taskKey}`,
        reason: current ? `granted to run ${runId}; displaced expired lease of run ${current.runId}` : `granted to run ${runId}`,
        beforeHash: current ? leaseHash(current) : null,
        afterHash: leaseHash(granted),
        correlation: { taskKey, runId },
      });
      return { lease: granted, displaced: current ?? null };
    });
  }

  /** Heartbeat renewal: extends the lease up to its deadline, only for the current token. */
  async renew(ref: FenceRef, now: Date): Promise<LeaseRow> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockCurrent(tx, ref, now, "update");
      const outcome = renewLease(current, now);
      if (outcome.kind === "expired") throw new LeaseExpiredError(`lease on ${ref.taskKey} expired`);
      const [renewed] = await tx.update(lease).set({ expiresAt: outcome.expiresAt }).where(eq(lease.taskKey, ref.taskKey)).returning();
      if (!renewed) throw new Error("update returned no row");
      return renewed;
    });
  }

  /** Ends the execution lease (S10 or a clean stop). Only the current holder may release it. */
  async release(ref: FenceRef, reason: string, now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      const current = await this.lockCurrent(tx, ref, now, "update", { allowExpired: true });
      await tx.delete(lease).where(eq(lease.taskKey, ref.taskKey));
      await new AuditRepository(tx).append({
        actor: ORCHESTRATOR,
        action: "lease.release",
        target: `task:${ref.taskKey}`,
        reason,
        beforeHash: leaseHash(current),
        afterHash: null,
        correlation: { taskKey: ref.taskKey, runId: current.runId },
      });
    });
  }

  /**
   * Runs a task-scoped write only if `ref` is the current, live lease (FR-ORC-008). The lease row
   * is share-locked until the write commits, so no takeover can interleave with it.
   */
  async withFence<T>(ref: FenceRef, now: Date, write: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await this.lockCurrent(tx, ref, now, "share");
      return write(tx);
    });
  }

  /** Deletes and returns leases that expired by `now` (leader only; SKIP LOCKED avoids blocking). */
  async reapExpired(now: Date, limit = 100): Promise<LeaseRow[]> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select({ taskKey: lease.taskKey })
        .from(lease)
        .where(lte(lease.expiresAt, now))
        .limit(limit)
        .for("update", { skipLocked: true });
      if (due.length === 0) return [];
      const reaped = await tx.delete(lease).where(inArray(lease.taskKey, due.map((d) => d.taskKey))).returning();
      const audit = new AuditRepository(tx);
      for (const l of reaped) {
        await audit.append({
          actor: ORCHESTRATOR,
          action: "lease.expire",
          target: `task:${l.taskKey}`,
          reason: `expired at ${l.expiresAt.toISOString()}`,
          beforeHash: leaseHash(l),
          afterHash: null,
          correlation: { taskKey: l.taskKey, runId: l.runId },
        });
      }
      return reaped;
    });
  }

  async get(taskKey: string): Promise<LeaseRow | null> {
    const [row] = await this.db.select().from(lease).where(eq(lease.taskKey, taskKey));
    return row ?? null;
  }

  private async lockCurrent(
    tx: DbTx,
    ref: FenceRef,
    now: Date,
    mode: "update" | "share",
    opts: { allowExpired?: boolean } = {},
  ): Promise<LeaseRow> {
    const [current] = await tx
      .select()
      .from(lease)
      .where(and(eq(lease.taskKey, ref.taskKey), eq(lease.fencingToken, ref.fencingToken)))
      .for(mode);
    if (!current) throw new StaleFencingTokenError(`fencing token ${ref.fencingToken} is not current for ${ref.taskKey}`);
    if (!opts.allowExpired && !isLeaseLive(current, now)) throw new LeaseExpiredError(`lease on ${ref.taskKey} expired`);
    return current;
  }
}
