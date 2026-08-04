CREATE TYPE "content"."approval_policy" AS ENUM('assist', 'semi_automatic', 'full_autopilot');--> statement-breakpoint
CREATE TYPE "content"."context_source" AS ENUM('manual', 'website', 'inferred');--> statement-breakpoint
CREATE TYPE "content"."preference_type" AS ENUM('content_format', 'posting_time', 'visual_style', 'tone', 'topic');--> statement-breakpoint
CREATE TYPE "content"."trend_frequency" AS ENUM('daily', 'three_days', 'weekly');--> statement-breakpoint
CREATE TABLE "content"."automation_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"trend_frequency" "content"."trend_frequency" DEFAULT 'weekly' NOT NULL,
	"last_research_at" timestamp with time zone,
	"next_research_at" timestamp with time zone,
	"content_automation_enabled" boolean DEFAULT false NOT NULL,
	"auto_publish_enabled" boolean DEFAULT false NOT NULL,
	"approval_policy" "content"."approval_policy" DEFAULT 'assist' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."brand_contexts" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"industry" text,
	"location" text,
	"audience" text,
	"goals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"competitors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"positioning" text,
	"content_pillars" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"source" "content"."context_source" DEFAULT 'manual' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."brand_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"preference_type" "content"."preference_type" NOT NULL,
	"preference" jsonb NOT NULL,
	"confidence" real NOT NULL,
	"learned_from" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."context_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"agent_type" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"used_in_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content"."automation_settings" ADD CONSTRAINT "automation_settings_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."brand_contexts" ADD CONSTRAINT "brand_contexts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."brand_preferences" ADD CONSTRAINT "brand_preferences_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."brand_preferences" ADD CONSTRAINT "brand_preferences_learned_from_scheduled_posts_id_fk" FOREIGN KEY ("learned_from") REFERENCES "content"."scheduled_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."context_snapshots" ADD CONSTRAINT "context_snapshots_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."context_snapshots" ADD CONSTRAINT "context_snapshots_used_in_job_id_generation_jobs_id_fk" FOREIGN KEY ("used_in_job_id") REFERENCES "content"."generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_settings_brand_idx" ON "content"."automation_settings" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "automation_settings_due_idx" ON "content"."automation_settings" USING btree ("content_automation_enabled","next_research_at");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_contexts_brand_idx" ON "content"."brand_contexts" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "brand_preferences_brand_type_created_idx" ON "content"."brand_preferences" USING btree ("brand_id","preference_type","created_at");--> statement-breakpoint
CREATE INDEX "context_snapshots_brand_created_idx" ON "content"."context_snapshots" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "context_snapshots_job_idx" ON "content"."context_snapshots" USING btree ("used_in_job_id");