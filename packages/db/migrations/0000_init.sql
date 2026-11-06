CREATE SEQUENCE "public"."decision_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."fencing_token_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "agent_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"role" text NOT NULL,
	"tier" text NOT NULL,
	"model_id" text NOT NULL,
	"autonomy_level" integer NOT NULL,
	"owner_role" text NOT NULL,
	"release" text NOT NULL,
	"source_sha" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_definition_version_uq" UNIQUE("name","version"),
	CONSTRAINT "agent_definition_tier_chk" CHECK ("agent_definition"."tier" in ('A', 'B'))
);
--> statement-breakpoint
CREATE TABLE "agent_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_definition_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"task_key" text,
	"component_pack" text,
	"step" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"container_id" text,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 4) DEFAULT '0' NOT NULL,
	"exit_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_kind_chk" CHECK ("agent_run"."kind" in ('speckit-command', 'task-pipeline', 'review', 'canary')),
	CONSTRAINT "agent_run_state_chk" CHECK ("agent_run"."state" in ('queued', 'starting', 'running', 'succeeded', 'failed', 'stopped', 'lost'))
);
--> statement-breakpoint
CREATE TABLE "budget_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 4) DEFAULT '0' NOT NULL,
	"cap_usd" numeric(14, 4),
	"cap_tokens" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_ledger_scope_uq" UNIQUE("scope","scope_key"),
	CONSTRAINT "budget_ledger_scope_chk" CHECK ("budget_ledger"."scope" in ('task', 'project', 'day', 'month'))
);
--> statement-breakpoint
CREATE TABLE "component_lock" (
	"project_id" uuid NOT NULL,
	"component" text NOT NULL,
	"state" text NOT NULL,
	"task_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "component_lock_pk" PRIMARY KEY("project_id","component"),
	CONSTRAINT "component_lock_state_chk" CHECK ("component_lock"."state" in ('active', 'pending-merge'))
);
--> statement-breakpoint
CREATE TABLE "decision" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"task_key" text,
	"class" text NOT NULL,
	"route" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"owner" text NOT NULL,
	"timebox_minutes" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"reversible" boolean NOT NULL,
	"auto_resolve" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"jira_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_class_chk" CHECK ("decision"."class" in ('clarification', 'consult', 'escalation', 'risk', 'gate')),
	CONSTRAINT "decision_route_chk" CHECK ("decision"."route" in ('operational', 'design', 'human')),
	CONSTRAINT "decision_id_chk" CHECK ("decision"."id" ~ '^DEC-[0-9]{4,}$'),
	CONSTRAINT "decision_status_chk" CHECK ("decision"."status" in ('open', 'escalated', 'decided', 'withdrawn')),
	CONSTRAINT "decision_gate_chk" CHECK ("decision"."class" <> 'gate' or (not "decision"."reversible" and not "decision"."auto_resolve")),
	CONSTRAINT "decision_auto_resolve_chk" CHECK (not "decision"."auto_resolve" or "decision"."class" = 'consult')
);
--> statement-breakpoint
CREATE TABLE "evidence_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"merge_group_sha" text,
	"patch_id" text NOT NULL,
	"reviewer_verdicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"check_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"envelope_ref" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"gate" text NOT NULL,
	"scope" text NOT NULL,
	"jira_gate_key" text,
	"pr_ref" text,
	"readiness_report_ref" text,
	"status" text DEFAULT 'Open' NOT NULL,
	"approved_by" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_scope_uq" UNIQUE("project_id","gate","scope"),
	CONSTRAINT "gate_id_chk" CHECK ("gate"."gate" in ('G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G-CR', 'G2Δ', 'G3Δ', 'G4Δ')),
	CONSTRAINT "gate_status_chk" CHECK ("gate"."status" in ('Open', 'Ready for Approval', 'Approved', 'Rejected'))
);
--> statement-breakpoint
CREATE TABLE "lease" (
	"task_key" text PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"fencing_token" bigint DEFAULT nextval('fencing_token_seq') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lease_expiry_chk" CHECK ("lease"."expires_at" <= "lease"."deadline_at")
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event" text NOT NULL,
	"severity" text NOT NULL,
	"recipients" jsonb NOT NULL,
	"channel" text NOT NULL,
	"dedupe_key" text,
	"sent_at" timestamp with time zone,
	"ack_by" text,
	"ack_at" timestamp with time zone,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pack_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" text NOT NULL,
	"kind" text NOT NULL,
	"semver" text NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"image_digest" text,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pack_version_uq" UNIQUE("pack_id","semver"),
	CONSTRAINT "pack_version_kind_chk" CHECK ("pack_version"."kind" in ('process', 'tech')),
	CONSTRAINT "pack_version_status_chk" CHECK ("pack_version"."status" in ('Draft', 'Qualified', 'Restricted', 'Retired')),
	CONSTRAINT "pack_version_digest_chk" CHECK ("pack_version"."image_digest" is null or "pack_version"."image_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "product_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version" text NOT NULL,
	"source_repo" text NOT NULL,
	"source_sha" text NOT NULL,
	"content_hash" text NOT NULL,
	"approved_gate_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_profile_version_uq" UNIQUE("project_id","version")
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"jira_project_key" text NOT NULL,
	"repos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"product_profile_ref" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_jira_project_key_unique" UNIQUE("jira_project_key")
);
--> statement-breakpoint
CREATE TABLE "step_record" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"step" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"wip_commit_sha" text,
	"error_signature" text,
	CONSTRAINT "step_record_status_chk" CHECK ("step_record"."status" in ('running', 'succeeded', 'failed')),
	CONSTRAINT "step_record_step_chk" CHECK ("step_record"."step" in ('S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12') or "step_record"."step" ~ '^[a-z][a-z0-9.-]*$')
);
--> statement-breakpoint
CREATE TABLE "test_target_lease" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" text NOT NULL,
	"pack" text NOT NULL,
	"run_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"health" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_link" (
	"project_id" uuid NOT NULL,
	"from_id" text NOT NULL,
	"rel" text NOT NULL,
	"to_id" text NOT NULL,
	CONSTRAINT "trace_link_pk" PRIMARY KEY("project_id","from_id","rel","to_id")
);
--> statement-breakpoint
CREATE TABLE "trace_node" (
	"project_id" uuid NOT NULL,
	"id" text NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"supersedes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "trace_node_pk" PRIMARY KEY("project_id","id")
);
--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_agent_definition_id_agent_definition_id_fk" FOREIGN KEY ("agent_definition_id") REFERENCES "public"."agent_definition"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_lock" ADD CONSTRAINT "component_lock_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision" ADD CONSTRAINT "decision_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_record" ADD CONSTRAINT "evidence_record_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate" ADD CONSTRAINT "gate_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_profile" ADD CONSTRAINT "product_profile_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_record" ADD CONSTRAINT "step_record_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_target_lease" ADD CONSTRAINT "test_target_lease_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_link" ADD CONSTRAINT "trace_link_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_node" ADD CONSTRAINT "trace_node_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_task_idx" ON "agent_run" USING btree ("task_key");--> statement-breakpoint
CREATE INDEX "agent_run_project_state_idx" ON "agent_run" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "decision_open_due_idx" ON "decision" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "evidence_pr_head_idx" ON "evidence_record" USING btree ("project_id","pr_number","head_sha");--> statement-breakpoint
CREATE INDEX "lease_expires_idx" ON "lease" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "notification_unacked_idx" ON "notification" USING btree ("ack_at","created_at");--> statement-breakpoint
CREATE INDEX "step_record_run_idx" ON "step_record" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "step_record_error_idx" ON "step_record" USING btree ("error_signature");--> statement-breakpoint
CREATE INDEX "test_target_lease_target_idx" ON "test_target_lease" USING btree ("target_id","expires_at");--> statement-breakpoint
CREATE INDEX "trace_link_to_idx" ON "trace_link" USING btree ("project_id","to_id");