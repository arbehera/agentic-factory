import { chainAuditEvent, GENESIS_HASH, verifyAuditChain, type AuditEventContent, type ChainedAuditEvent, type ChainVerification } from "@adlc/domain";
import { auditEventInputSchema } from "@adlc/schemas";
import { and, asc, desc, gte, lte, sql } from "drizzle-orm";
import { ADVISORY_LOCKS } from "./advisory-locks.js";
import { auditEvent } from "./audit-table.js";
import type { DbExecutor } from "./client.js";

type Row = typeof auditEvent.$inferSelect;

function toEvent(r: Row): ChainedAuditEvent {
  return {
    seq: r.seq,
    ts: r.ts.toISOString(),
    actor: { kind: r.actorKind as ChainedAuditEvent["actor"]["kind"], id: r.actorId },
    action: r.action,
    target: r.target,
    reason: r.reason,
    beforeHash: r.beforeHash,
    afterHash: r.afterHash,
    correlation: r.correlation,
    prevHash: r.prevHash,
    hash: r.hash,
  };
}

/** Append-only, hash-chained audit log (hard rule 11, NFR-006). */
export class AuditRepository {
  constructor(private readonly db: DbExecutor) {}

  /**
   * Validates and appends one event. Appends are serialised so the chain stays linear. Inside a
   * caller's transaction this is a savepoint, so the event commits or rolls back with the change.
   */
  async append(input: AuditEventContent, now: Date = new Date()): Promise<ChainedAuditEvent> {
    const content = auditEventInputSchema.parse(input);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCKS.auditChain})`);
      const [last] = await tx.select({ hash: auditEvent.hash }).from(auditEvent).orderBy(desc(auditEvent.seq)).limit(1);
      const { rows } = await tx.execute<{ seq: string }>(sql`select nextval('audit_event_seq') as seq`);
      const seq = Number(rows[0]?.seq);
      const event = chainAuditEvent(content, seq, now, last?.hash ?? GENESIS_HASH);
      await tx.insert(auditEvent).values({
        seq,
        ts: now,
        actorKind: event.actor.kind,
        actorId: event.actor.id,
        action: event.action,
        target: event.target,
        reason: event.reason,
        beforeHash: event.beforeHash,
        afterHash: event.afterHash,
        correlation: event.correlation,
        prevHash: event.prevHash,
        hash: event.hash,
      });
      return event;
    });
  }

  async list(range: { fromSeq?: number; toSeq?: number } = {}): Promise<ChainedAuditEvent[]> {
    const conds = [
      range.fromSeq === undefined ? undefined : gte(auditEvent.seq, range.fromSeq),
      range.toSeq === undefined ? undefined : lte(auditEvent.seq, range.toSeq),
    ];
    const rows = await this.db.select().from(auditEvent).where(and(...conds)).orderBy(asc(auditEvent.seq));
    return rows.map(toEvent);
  }

  /**
   * Events from `fromSeq` on, read under the chain lock so no append still in flight can commit
   * below the cut afterwards (the WORM export, ADR-0015).
   */
  async listSealable(fromSeq: number): Promise<ChainedAuditEvent[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCKS.auditChain})`);
      return new AuditRepository(tx).list({ fromSeq });
    });
  }

  /** Audit events correlated with a run, oldest first (FR-POR-001 run detail). */
  async forRun(runId: string, limit = 500): Promise<ChainedAuditEvent[]> {
    const rows = await this.db
      .select()
      .from(auditEvent)
      .where(sql`${auditEvent.correlation}->>'runId' = ${runId}`)
      .orderBy(asc(auditEvent.seq))
      .limit(limit);
    return rows.map(toEvent);
  }

  /** Verifies the stored chain from genesis, or from an export anchor. */
  async verify(anchor?: { hash: string; afterSeq: number }): Promise<ChainVerification> {
    const events = await this.list(anchor ? { fromSeq: anchor.afterSeq + 1 } : {});
    return verifyAuditChain(events, anchor?.hash ?? GENESIS_HASH);
  }

  /** Creates this and next month's audit partitions (idempotent; leader maintenance, ADR-0005). */
  async ensurePartitions(now: Date): Promise<void> {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    await this.db.execute(sql`select adlc_ensure_audit_partition(${now.toISOString().slice(0, 10)}::date)`);
    await this.db.execute(sql`select adlc_ensure_audit_partition(${next.toISOString().slice(0, 10)}::date)`);
  }
}
