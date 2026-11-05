ALTER TABLE "gateway_session" ADD COLUMN "review_repo" text;--> statement-breakpoint
ALTER TABLE "gateway_session" ADD COLUMN "review_pr_number" integer;--> statement-breakpoint
ALTER TABLE "gateway_session" ADD COLUMN "review_head_sha" text;--> statement-breakpoint
ALTER TABLE "reviewer_verdict" ADD CONSTRAINT "reviewer_verdict_model_call_uq" UNIQUE("model_call_id");--> statement-breakpoint
ALTER TABLE "gateway_session" ADD CONSTRAINT "gateway_session_review_chk" CHECK (("gateway_session"."review_repo" is null) = ("gateway_session"."review_pr_number" is null) and ("gateway_session"."review_pr_number" is null) = ("gateway_session"."review_head_sha" is null));