ALTER TABLE "content"."inbox_threads" ADD COLUMN "draft_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content"."inbox_threads" ADD COLUMN "draft_reply" text;--> statement-breakpoint
ALTER TABLE "content"."inbox_threads" ADD COLUMN "draft_category" text;--> statement-breakpoint
ALTER TABLE "content"."inbox_threads" ADD COLUMN "draft_language" text;--> statement-breakpoint
ALTER TABLE "content"."inbox_threads" ADD COLUMN "draft_confidence" real;--> statement-breakpoint
ALTER TABLE "content"."inbox_threads" ADD COLUMN "drafted_at" timestamp with time zone;