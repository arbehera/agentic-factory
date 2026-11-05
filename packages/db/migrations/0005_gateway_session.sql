CREATE TABLE "gateway_session" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"role" text NOT NULL,
	"project_id" uuid NOT NULL,
	"task_key" text,
	"fencing_token" bigint,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "gateway_session_fence_chk" CHECK (("gateway_session"."task_key" is null) = ("gateway_session"."fencing_token" is null))
);
--> statement-breakpoint
ALTER TABLE "gateway_session" ADD CONSTRAINT "gateway_session_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_session" ADD CONSTRAINT "gateway_session_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gateway_session_run_idx" ON "gateway_session" USING btree ("run_id");