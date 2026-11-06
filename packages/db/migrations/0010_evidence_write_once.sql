-- Hand-written (ADR-0012): the evidence store is write-once (FR-EVD-001, SDD §15.1 "forged or
-- replayed review evidence"). Model calls, reviewer verdicts and signed evidence records can be
-- inserted but never changed or removed.
CREATE FUNCTION adlc_reject_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is write-once (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER "model_call_write_once" BEFORE UPDATE OR DELETE ON "model_call"
	FOR EACH ROW EXECUTE FUNCTION adlc_reject_evidence_mutation();
--> statement-breakpoint
CREATE TRIGGER "model_call_no_truncate" BEFORE TRUNCATE ON "model_call"
	FOR EACH STATEMENT EXECUTE FUNCTION adlc_reject_evidence_mutation();
--> statement-breakpoint
CREATE TRIGGER "reviewer_verdict_write_once" BEFORE UPDATE OR DELETE ON "reviewer_verdict"
	FOR EACH ROW EXECUTE FUNCTION adlc_reject_evidence_mutation();
--> statement-breakpoint
CREATE TRIGGER "reviewer_verdict_no_truncate" BEFORE TRUNCATE ON "reviewer_verdict"
	FOR EACH STATEMENT EXECUTE FUNCTION adlc_reject_evidence_mutation();
--> statement-breakpoint
CREATE TRIGGER "evidence_record_write_once" BEFORE UPDATE OR DELETE ON "evidence_record"
	FOR EACH ROW EXECUTE FUNCTION adlc_reject_evidence_mutation();
--> statement-breakpoint
CREATE TRIGGER "evidence_record_no_truncate" BEFORE TRUNCATE ON "evidence_record"
	FOR EACH STATEMENT EXECUTE FUNCTION adlc_reject_evidence_mutation();
