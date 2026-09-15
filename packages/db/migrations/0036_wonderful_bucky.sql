ALTER TABLE "core"."users" ADD COLUMN "reset_code_hash" text;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "reset_code_expires_at" timestamp with time zone;