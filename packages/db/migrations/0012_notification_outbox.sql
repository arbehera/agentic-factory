ALTER TABLE "notification" ALTER COLUMN "recipients" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "notification" ALTER COLUMN "channel" SET DEFAULT 'inbox+email';--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "audience" text NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "title" text NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "body" text NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "link" text NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "routed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "sent_level" integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_open_dedupe_uq" ON "notification" USING btree ("dedupe_key") WHERE "notification"."ack_at" is null;