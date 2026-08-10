CREATE TYPE "content"."category_key" AS ENUM('technology', 'fashion_apparel', 'food_beverage', 'fitness_wellness', 'sports', 'entertainment', 'beauty_personal_care', 'home_lifestyle', 'finance', 'travel_hospitality', 'education', 'other');--> statement-breakpoint
CREATE TYPE "content"."pool_run_scope" AS ENUM('category', 'national');--> statement-breakpoint
CREATE TYPE "content"."pool_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "content"."pool_intelligence_items" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"category" "content"."intelligence_category" NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"urgency" "content"."intelligence_urgency" NOT NULL,
	"score" jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."pool_intelligence_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" "content"."pool_run_scope" NOT NULL,
	"category" "content"."category_key",
	"status" "content"."pool_run_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."pool_trend_items" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"topic" text NOT NULL,
	"category" "content"."trend_category" NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"recommendation" text NOT NULL,
	"content_type" "content"."trend_content_type" NOT NULL,
	"score" jsonb NOT NULL,
	"signal_count" integer NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggested_request" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."pool_trend_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" "content"."pool_run_scope" NOT NULL,
	"category" "content"."category_key",
	"status" "content"."pool_run_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."pool_trend_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"source" text NOT NULL,
	"signal_type" text NOT NULL,
	"topic" text,
	"title" text NOT NULL,
	"snippet" text NOT NULL,
	"strength" real NOT NULL,
	"source_url" text NOT NULL,
	"published_at" text,
	"pool_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content"."brand_contexts" ADD COLUMN "category_key" "content"."category_key";--> statement-breakpoint
ALTER TABLE "content"."brand_contexts" ADD COLUMN "category_key_classified_for" text;--> statement-breakpoint
ALTER TABLE "content"."intelligence_items" ADD COLUMN "pool_item_id" text;--> statement-breakpoint
ALTER TABLE "content"."trend_opportunities" ADD COLUMN "pool_item_id" text;--> statement-breakpoint
ALTER TABLE "content"."pool_intelligence_items" ADD CONSTRAINT "pool_intelligence_items_run_id_pool_intelligence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "content"."pool_intelligence_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."pool_trend_items" ADD CONSTRAINT "pool_trend_items_run_id_pool_trend_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "content"."pool_trend_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."pool_trend_signals" ADD CONSTRAINT "pool_trend_signals_run_id_pool_trend_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "content"."pool_trend_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."pool_trend_signals" ADD CONSTRAINT "pool_trend_signals_pool_item_id_pool_trend_items_id_fk" FOREIGN KEY ("pool_item_id") REFERENCES "content"."pool_trend_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pool_intelligence_items_run_idx" ON "content"."pool_intelligence_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "pool_intelligence_items_category_idx" ON "content"."pool_intelligence_items" USING btree ("category");--> statement-breakpoint
CREATE INDEX "pool_intelligence_runs_scope_category_created_idx" ON "content"."pool_intelligence_runs" USING btree ("scope","category","created_at");--> statement-breakpoint
CREATE INDEX "pool_intelligence_runs_expires_idx" ON "content"."pool_intelligence_runs" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pool_intelligence_runs_one_active_per_bucket_idx" ON "content"."pool_intelligence_runs" USING btree ("scope","category") WHERE "content"."pool_intelligence_runs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "pool_trend_items_run_idx" ON "content"."pool_trend_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "pool_trend_items_category_idx" ON "content"."pool_trend_items" USING btree ("category");--> statement-breakpoint
CREATE INDEX "pool_trend_runs_scope_category_created_idx" ON "content"."pool_trend_runs" USING btree ("scope","category","created_at");--> statement-breakpoint
CREATE INDEX "pool_trend_runs_expires_idx" ON "content"."pool_trend_runs" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pool_trend_runs_one_active_per_bucket_idx" ON "content"."pool_trend_runs" USING btree ("scope","category") WHERE "content"."pool_trend_runs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "pool_trend_signals_run_idx" ON "content"."pool_trend_signals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "pool_trend_signals_item_idx" ON "content"."pool_trend_signals" USING btree ("pool_item_id");--> statement-breakpoint
ALTER TABLE "content"."intelligence_items" ADD CONSTRAINT "intelligence_items_pool_item_id_pool_intelligence_items_id_fk" FOREIGN KEY ("pool_item_id") REFERENCES "content"."pool_intelligence_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."trend_opportunities" ADD CONSTRAINT "trend_opportunities_pool_item_id_pool_trend_items_id_fk" FOREIGN KEY ("pool_item_id") REFERENCES "content"."pool_trend_items"("id") ON DELETE set null ON UPDATE no action;