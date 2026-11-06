import { bigint, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { Correlation } from "@adlc/domain";

/**
 * Query-builder view of `audit_event`. The table itself (range partitioned by month on `ts`,
 * append-only triggers) is created by `migrations/0001_audit_event.sql`; this file is
 * deliberately not in drizzle.config's `schema`, so drizzle-kit never regenerates it.
 */
export const auditEvent = pgTable(
  "audit_event",
  {
    seq: bigint("seq", { mode: "number" }).notNull(),
    ts: timestamp("ts", { withTimezone: true, mode: "date" }).notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull(),
    reason: text("reason").notNull(),
    beforeHash: text("before_hash"),
    afterHash: text("after_hash"),
    correlation: jsonb("correlation").$type<Correlation>().notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [primaryKey({ name: "audit_event_pk", columns: [t.seq, t.ts] })],
);
