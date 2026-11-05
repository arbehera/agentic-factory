CREATE TABLE "control_flag" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"reason" text NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL
);
