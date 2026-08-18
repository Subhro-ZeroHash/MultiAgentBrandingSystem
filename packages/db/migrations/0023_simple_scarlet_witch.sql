CREATE TYPE "content"."directive_intent" AS ENUM('redirect', 'refine', 'approve', 'question', 'unclear');--> statement-breakpoint
CREATE TYPE "content"."directive_role" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "content"."directive_status" AS ENUM('pending', 'researching', 'planning', 'applied', 'failed');--> statement-breakpoint
CREATE TYPE "content"."plan_item_status" AS ENUM('proposed', 'approved', 'rejected', 'generating', 'ready', 'scheduled', 'published', 'failed');--> statement-breakpoint
CREATE TYPE "content"."plan_origin" AS ENUM('scheduled', 'directive', 'manual');--> statement-breakpoint
CREATE TYPE "content"."plan_status" AS ENUM('draft', 'active', 'superseded');--> statement-breakpoint
CREATE TABLE "content"."marketing_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"status" "content"."plan_status" DEFAULT 'draft' NOT NULL,
	"origin" "content"."plan_origin" DEFAULT 'scheduled' NOT NULL,
	"horizon_days" integer DEFAULT 14 NOT NULL,
	"headline" text NOT NULL,
	"rationale" text NOT NULL,
	"focus" text,
	"evidence" jsonb DEFAULT '{"opportunityIds":[],"intelligenceItemIds":[],"notes":[],"geoScoreAtPlanning":null}'::jsonb NOT NULL,
	"supersedes_id" text,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."plan_directives" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"plan_id" text,
	"role" "content"."directive_role" NOT NULL,
	"text" text NOT NULL,
	"intent" "content"."directive_intent",
	"status" "content"."directive_status" DEFAULT 'pending' NOT NULL,
	"resulting_plan_id" text,
	"research_run_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."plan_items" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"title" text NOT NULL,
	"rationale" text NOT NULL,
	"content_type" "content"."trend_content_type" NOT NULL,
	"suggested_request" jsonb NOT NULL,
	"product_id" text,
	"opportunity_id" text,
	"planned_for" timestamp with time zone,
	"status" "content"."plan_item_status" DEFAULT 'proposed' NOT NULL,
	"generation_job_id" text,
	"approved_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content"."marketing_plans" ADD CONSTRAINT "marketing_plans_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."marketing_plans" ADD CONSTRAINT "marketing_plans_supersedes_id_marketing_plans_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "content"."marketing_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."plan_directives" ADD CONSTRAINT "plan_directives_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."plan_directives" ADD CONSTRAINT "plan_directives_plan_id_marketing_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "content"."marketing_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."plan_directives" ADD CONSTRAINT "plan_directives_resulting_plan_id_marketing_plans_id_fk" FOREIGN KEY ("resulting_plan_id") REFERENCES "content"."marketing_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."plan_directives" ADD CONSTRAINT "plan_directives_research_run_id_trend_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "content"."trend_research_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."plan_items" ADD CONSTRAINT "plan_items_plan_id_marketing_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "content"."marketing_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."plan_items" ADD CONSTRAINT "plan_items_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."plan_items" ADD CONSTRAINT "plan_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "content"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."plan_items" ADD CONSTRAINT "plan_items_opportunity_id_trend_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "content"."trend_opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."plan_items" ADD CONSTRAINT "plan_items_generation_job_id_generation_jobs_id_fk" FOREIGN KEY ("generation_job_id") REFERENCES "content"."generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marketing_plans_brand_created_idx" ON "content"."marketing_plans" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "marketing_plans_brand_status_idx" ON "content"."marketing_plans" USING btree ("brand_id","status");--> statement-breakpoint
CREATE INDEX "plan_directives_brand_created_idx" ON "content"."plan_directives" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "plan_items_plan_seq_idx" ON "content"."plan_items" USING btree ("plan_id","sequence");--> statement-breakpoint
CREATE INDEX "plan_items_brand_status_idx" ON "content"."plan_items" USING btree ("brand_id","status");