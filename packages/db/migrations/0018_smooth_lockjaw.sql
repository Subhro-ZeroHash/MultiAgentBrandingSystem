CREATE TYPE "content"."trend_opportunity_status" AS ENUM('new', 'saved', 'ignored', 'working_on');--> statement-breakpoint
CREATE TABLE "content"."trend_opportunities" (
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
	"status" "content"."trend_opportunity_status" DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."trend_signals" (
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
	"opportunity_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "content"."trend_ideas" CASCADE;--> statement-breakpoint
ALTER TABLE "content"."trend_opportunities" ADD CONSTRAINT "trend_opportunities_run_id_trend_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "content"."trend_research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."trend_signals" ADD CONSTRAINT "trend_signals_run_id_trend_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "content"."trend_research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."trend_signals" ADD CONSTRAINT "trend_signals_opportunity_id_trend_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "content"."trend_opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trend_opportunities_run_idx" ON "content"."trend_opportunities" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "trend_signals_run_idx" ON "content"."trend_signals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "trend_signals_opportunity_idx" ON "content"."trend_signals" USING btree ("opportunity_id");--> statement-breakpoint
DROP TYPE "content"."trend_idea_status";