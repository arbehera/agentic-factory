-- Hand-written migration (ADR-0005): append-only, hash-chained audit log, range-partitioned by
-- month on ts (NFR-006). Hash chaining is computed in @adlc/domain; this file provides storage,
-- partitioning and the append-only guarantee.
CREATE SEQUENCE "audit_event_seq" AS bigint START WITH 1;
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"seq" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"actor_kind" text NOT NULL CHECK ("actor_kind" IN ('agent-run', 'human', 'service')),
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"reason" text NOT NULL CHECK ("reason" <> ''),
	"before_hash" text CHECK ("before_hash" ~ '^[0-9a-f]{64}$'),
	"after_hash" text CHECK ("after_hash" ~ '^[0-9a-f]{64}$'),
	"correlation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text NOT NULL CHECK ("prev_hash" ~ '^[0-9a-f]{64}$'),
	"hash" text NOT NULL CHECK ("hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audit_event_pk" PRIMARY KEY ("seq", "ts")
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
-- Catches rows outside any monthly partition so an insert never fails for lack of a partition.
CREATE TABLE "audit_event_default" PARTITION OF "audit_event" DEFAULT;
--> statement-breakpoint
-- Creates the partition for the month containing p_month (idempotent). The orchestrator's
-- maintenance job calls it ahead of each month (P0-WP3).
CREATE FUNCTION adlc_ensure_audit_partition(p_month date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
	v_start date := date_trunc('month', p_month::timestamp)::date;
	v_name text := format('audit_event_%s', to_char(v_start, 'YYYY_MM'));
BEGIN
	IF to_regclass(v_name) IS NULL THEN
		EXECUTE format(
			'CREATE TABLE %I PARTITION OF audit_event FOR VALUES FROM (%L) TO (%L)',
			-- Bounds are UTC midnights as timestamptz literals (with offset), independent of session TimeZone.
			v_name, v_start::timestamp AT TIME ZONE 'UTC', (v_start + interval '1 month') AT TIME ZONE 'UTC'
		);
	END IF;
	RETURN v_name;
END $$;
--> statement-breakpoint
CREATE FUNCTION adlc_reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_event is append-only (% rejected)', TG_OP USING ERRCODE = 'restrict_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER "audit_event_no_update_delete" BEFORE UPDATE OR DELETE ON "audit_event"
	FOR EACH ROW EXECUTE FUNCTION adlc_reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER "audit_event_no_truncate" BEFORE TRUNCATE ON "audit_event"
	FOR EACH STATEMENT EXECUTE FUNCTION adlc_reject_audit_mutation();
--> statement-breakpoint
SELECT adlc_ensure_audit_partition((now() AT TIME ZONE 'UTC')::date);
--> statement-breakpoint
SELECT adlc_ensure_audit_partition(((now() AT TIME ZONE 'UTC') + interval '1 month')::date);
