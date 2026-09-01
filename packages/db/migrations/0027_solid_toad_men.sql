DROP INDEX "content"."pool_intelligence_runs_scope_category_created_idx";--> statement-breakpoint
DROP INDEX "content"."pool_intelligence_runs_one_active_per_bucket_idx";--> statement-breakpoint
DROP INDEX "content"."pool_trend_runs_scope_category_created_idx";--> statement-breakpoint
DROP INDEX "content"."pool_trend_runs_one_active_per_bucket_idx";--> statement-breakpoint
ALTER TABLE "content"."brand_contexts" ADD COLUMN "market_code" text;--> statement-breakpoint
ALTER TABLE "content"."brand_contexts" ADD COLUMN "market_code_classified_for" text;--> statement-breakpoint
ALTER TABLE "content"."pool_intelligence_runs" ADD COLUMN "market" text DEFAULT 'IN' NOT NULL;--> statement-breakpoint
ALTER TABLE "content"."pool_trend_runs" ADD COLUMN "market" text DEFAULT 'IN' NOT NULL;--> statement-breakpoint
CREATE INDEX "pool_intelligence_runs_scope_category_created_idx" ON "content"."pool_intelligence_runs" USING btree ("scope","category","market","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pool_intelligence_runs_one_active_per_bucket_idx" ON "content"."pool_intelligence_runs" USING btree ("scope","category","market") WHERE "content"."pool_intelligence_runs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "pool_trend_runs_scope_category_created_idx" ON "content"."pool_trend_runs" USING btree ("scope","category","market","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pool_trend_runs_one_active_per_bucket_idx" ON "content"."pool_trend_runs" USING btree ("scope","category","market") WHERE "content"."pool_trend_runs"."status" IN ('queued', 'running');