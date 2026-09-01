CREATE TYPE "geo"."tracked_prompt_source" AS ENUM('suggested', 'user');--> statement-breakpoint
ALTER TABLE "geo"."tracked_prompts" ADD COLUMN "source" "geo"."tracked_prompt_source" DEFAULT 'user' NOT NULL;--> statement-breakpoint
CREATE INDEX "tracked_prompts_brand_source_active_idx" ON "geo"."tracked_prompts" USING btree ("brand_id","source","is_active");