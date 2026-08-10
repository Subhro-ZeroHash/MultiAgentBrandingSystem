CREATE TYPE "content"."intelligence_category" AS ENUM('government_policy', 'brand_news', 'industry_news', 'competitor', 'local');--> statement-breakpoint
CREATE TYPE "content"."intelligence_item_status" AS ENUM('new', 'read', 'saved', 'dismissed');--> statement-breakpoint
CREATE TYPE "content"."intelligence_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "content"."intelligence_urgency" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "content"."trend_idea_status" AS ENUM('new', 'saved', 'ignored', 'working_on');--> statement-breakpoint
CREATE TABLE "content"."ai_research_queries" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."intelligence_items" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"category" "content"."intelligence_category" NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"why_it_matters" text NOT NULL,
	"urgency" "content"."intelligence_urgency" NOT NULL,
	"score" jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "content"."intelligence_item_status" DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."intelligence_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"status" "content"."intelligence_run_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content"."trend_ideas" ADD COLUMN "status" "content"."trend_idea_status" DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "content"."ai_research_queries" ADD CONSTRAINT "ai_research_queries_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."intelligence_items" ADD CONSTRAINT "intelligence_items_run_id_intelligence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "content"."intelligence_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."intelligence_runs" ADD CONSTRAINT "intelligence_runs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_research_queries_brand_created_idx" ON "content"."ai_research_queries" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "intelligence_items_run_idx" ON "content"."intelligence_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "intelligence_items_run_category_idx" ON "content"."intelligence_items" USING btree ("run_id","category");--> statement-breakpoint
CREATE INDEX "intelligence_runs_brand_created_idx" ON "content"."intelligence_runs" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "intelligence_runs_status_idx" ON "content"."intelligence_runs" USING btree ("status");