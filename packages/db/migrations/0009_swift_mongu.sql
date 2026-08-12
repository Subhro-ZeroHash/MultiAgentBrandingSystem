ALTER TYPE "content"."scheduled_campaign_status" ADD VALUE 'paused' BEFORE 'completed';--> statement-breakpoint
ALTER TYPE "content"."scheduled_post_status" ADD VALUE 'publishing' BEFORE 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_posts_generation_job_idx" ON "content"."scheduled_posts" USING btree ("generation_job_id");