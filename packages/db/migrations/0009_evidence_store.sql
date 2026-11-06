CREATE TABLE "model_call" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"request_hash" text NOT NULL,
	"response_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewer_verdict" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"reviewer_role" text NOT NULL,
	"reviewer_run_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"summary" text NOT NULL,
	"model_call_id" text NOT NULL,
	"verdict_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviewer_verdict_head_role_uq" UNIQUE("repo","pr_number","head_sha","reviewer_role"),
	CONSTRAINT "reviewer_verdict_value_chk" CHECK ("reviewer_verdict"."verdict" in ('approve', 'request-changes')),
	CONSTRAINT "reviewer_verdict_sha_chk" CHECK ("reviewer_verdict"."head_sha" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
ALTER TABLE "evidence_record" ADD COLUMN "repo" text NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_record" ADD COLUMN "author_role" text NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_record" ADD COLUMN "envelope" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "model_call" ADD CONSTRAINT "model_call_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_verdict" ADD CONSTRAINT "reviewer_verdict_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_verdict" ADD CONSTRAINT "reviewer_verdict_reviewer_run_id_agent_run_id_fk" FOREIGN KEY ("reviewer_run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_verdict" ADD CONSTRAINT "reviewer_verdict_model_call_id_model_call_id_fk" FOREIGN KEY ("model_call_id") REFERENCES "public"."model_call"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_call_run_idx" ON "model_call" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_head_uq" ON "evidence_record" USING btree ("repo","pr_number","head_sha") WHERE "evidence_record"."merge_group_sha" is null;