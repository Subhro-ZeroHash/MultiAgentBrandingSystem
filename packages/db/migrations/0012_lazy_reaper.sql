CREATE TYPE "content"."trend_category" AS ENUM('industry_topic', 'event_festival', 'social_trend');--> statement-breakpoint
CREATE TYPE "content"."trend_content_type" AS ENUM('post', 'reel', 'story', 'campaign');--> statement-breakpoint
CREATE TYPE "content"."trend_research_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "content"."trend_ideas" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"category" "content"."trend_category" NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"recommendation" text NOT NULL,
	"content_type" "content"."trend_content_type" NOT NULL,
	"score" jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggested_request" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."trend_research_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"status" "content"."trend_research_status" DEFAULT 'queued' NOT NULL,
	"location_override" text,
	"focus" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content"."trend_ideas" ADD CONSTRAINT "trend_ideas_run_id_trend_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "content"."trend_research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."trend_research_runs" ADD CONSTRAINT "trend_research_runs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trend_ideas_run_idx" ON "content"."trend_ideas" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "trend_research_runs_brand_created_idx" ON "content"."trend_research_runs" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "trend_research_runs_status_idx" ON "content"."trend_research_runs" USING btree ("status");