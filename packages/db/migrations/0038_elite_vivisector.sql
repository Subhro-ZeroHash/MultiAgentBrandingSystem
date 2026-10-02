ALTER TABLE "core"."users" ADD COLUMN "privacy_policy_version" text;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "privacy_accepted_at" timestamp with time zone;