import { stateHash, type Actor } from "@adlc/domain";
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { AuditRepository } from "./audit-repository.js";
import type { DbExecutor } from "./client.js";
import { notification } from "./schema.js";

export type NotificationRow = typeof notification.$inferSelect;

export class NotificationNotFoundError extends Error {
  override name = "NotificationNotFoundError";
}

export interface RaiseNotification {
  projectId?: string;
  event: string;
  severity: string;
  audience: string;
  title: string;
  body: string;
  link: string;
  /** Duplicates of an unacknowledged event with this key merge into it. */
  dedupeKey: string;
}

/** Notification outbox and inbox (FR-NOT-001/002). */
export class NotificationRepository {
  constructor(private readonly db: DbExecutor) {}

  /** Records an event; returns the open notification it merged into, if it was a duplicate. */
  async raise(n: RaiseNotification, now: Date): Promise<{ row: NotificationRow; merged: boolean }> {
    const [created] = await this.db
      .insert(notification)
      .values({ ...n, projectId: n.projectId ?? null, createdAt: now })
      .onConflictDoNothing({ target: notification.dedupeKey, where: sql`${notification.ackAt} is null` })
      .returning();
    if (created) return { row: created, merged: false };
    const [open] = await this.db.select().from(notification).where(and(eq(notification.dedupeKey, n.dedupeKey), isNull(notification.ackAt)));
    if (!open) throw new Error(`dedupe conflict on ${n.dedupeKey} but no open notification`);
    return { row: open, merged: true };
  }

  async get(id: string): Promise<NotificationRow> {
    const [row] = await this.db.select().from(notification).where(eq(notification.id, id));
    if (!row) throw new NotificationNotFoundError(`notification ${id} not found`);
    return row;
  }

  /** Events not yet given recipients and a deadline. */
  async unrouted(limit = 100): Promise<NotificationRow[]> {
    return this.db.select().from(notification).where(isNull(notification.routedAt)).orderBy(asc(notification.createdAt)).limit(limit);
  }

  async route(id: string, recipients: string[], dueAt: Date, now: Date): Promise<NotificationRow> {
    const [row] = await this.db.update(notification).set({ recipients, dueAt, routedAt: now }).where(and(eq(notification.id, id), isNull(notification.routedAt))).returning();
    return row ?? (await this.get(id));
  }

  /** Routed, unacknowledged notifications whose current level has not been delivered yet. */
  async undelivered(limit = 100): Promise<NotificationRow[]> {
    return this.db
      .select()
      .from(notification)
      .where(and(isNotNull(notification.routedAt), isNull(notification.ackAt), lt(notification.sentLevel, notification.escalationLevel)))
      .orderBy(asc(notification.createdAt))
      .limit(limit);
  }

  async markSent(id: string, level: number, now: Date): Promise<void> {
    await this.db.update(notification).set({ sentLevel: level, sentAt: now }).where(eq(notification.id, id));
  }

  /** Unacknowledged notifications past their deadline. */
  async overdue(now: Date, limit = 100): Promise<NotificationRow[]> {
    return this.db
      .select()
      .from(notification)
      .where(and(isNull(notification.ackAt), isNotNull(notification.dueAt), lte(notification.dueAt, now)))
      .orderBy(asc(notification.dueAt))
      .limit(limit);
  }

  /** Moves to the next escalation level with new recipients and a new deadline (only if still open and due). */
  async escalate(id: string, level: number, recipients: string[], dueAt: Date, now: Date): Promise<NotificationRow | null> {
    const [row] = await this.db
      .update(notification)
      .set({ escalationLevel: level, recipients, dueAt })
      .where(and(eq(notification.id, id), isNull(notification.ackAt), lte(notification.dueAt, now)))
      .returning();
    return row ?? null;
  }

  /** Portal inbox: notifications currently addressed to `recipient`. */
  async inbox(recipient: string, opts: { openOnly: boolean } = { openOnly: true }, limit = 100): Promise<NotificationRow[]> {
    return this.db
      .select()
      .from(notification)
      .where(and(sql`${notification.recipients} @> ${JSON.stringify([recipient])}::jsonb`, opts.openOnly ? isNull(notification.ackAt) : undefined))
      .orderBy(desc(notification.createdAt))
      .limit(limit);
  }

  /** A human acknowledges: escalation stops. Recorded in the audit log (hard rule 11). */
  async acknowledge(id: string, actor: Actor, now: Date): Promise<NotificationRow> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(notification).where(eq(notification.id, id)).for("update");
      if (!before) throw new NotificationNotFoundError(`notification ${id} not found`);
      if (before.ackAt) return before;
      const [row] = await tx.update(notification).set({ ackBy: `${actor.kind}:${actor.id}`, ackAt: now }).where(eq(notification.id, id)).returning();
      if (!row) throw new Error("update returned no row");
      await new AuditRepository(tx).append({
        actor,
        action: "notification.ack",
        target: `notification:${id}`,
        reason: `acknowledged ${before.event} at escalation level ${before.escalationLevel}`,
        beforeHash: stateHash({ ackAt: null }),
        afterHash: stateHash({ ackAt: now.toISOString(), ackBy: row.ackBy }),
        correlation: before.projectId ? { projectId: before.projectId } : {},
      });
      return row;
    });
  }

  /** Acknowledgement time, when acknowledged (SDD §16.3: acknowledgement times are recorded). */
  async acknowledgedSince(since: Date): Promise<NotificationRow[]> {
    return this.db.select().from(notification).where(and(isNotNull(notification.ackAt), gt(notification.ackAt, since)));
  }
}
