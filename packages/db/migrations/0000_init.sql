CREATE SCHEMA "core";
--> statement-breakpoint
CREATE SCHEMA "content";
--> statement-breakpoint
CREATE SCHEMA "geo";
--> statement-breakpoint
CREATE TYPE "core"."tone_of_voice" AS ENUM('friendly', 'premium', 'playful', 'traditional');--> statement-breakpoint
CREATE TYPE "content"."campaign_type" AS ENUM('offer', 'launch', 'festival', 'generic');--> statement-breakpoint
CREATE TYPE "content"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "content"."output_format" AS ENUM('instagram_post', 'story_reel_cover', 'facebook_banner', 'poster_a4');--> statement-breakpoint
CREATE TYPE "content"."style_template" AS ENUM('festive', 'minimal_luxury', 'bold_discount', 'flat_lay_product_hero');--> statement-breakpoint
CREATE TYPE "geo"."answer_engine" AS ENUM('chatgpt', 'perplexity', 'gemini', 'claude', 'copilot', 'ai_overviews');--> statement-breakpoint
CREATE TYPE "geo"."entity_type" AS ENUM('brand', 'competitor');--> statement-breakpoint
CREATE TYPE "geo"."prompt_intent" AS ENUM('discovery', 'comparison', 'brand_direct', 'transactional', 'informational');--> statement-breakpoint
CREATE TYPE "geo"."sentiment" AS ENUM('positive', 'neutral', 'negative');--> statement-breakpoint
CREATE TABLE "core"."brands" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"logo_url" text,
	"colors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tone_of_voice" "core"."tone_of_voice" DEFAULT 'friendly' NOT NULL,
	"category" text,
	"audience" text,
	"website_url" text,
	"social_handles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."cost_events" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text,
	"system" text NOT NULL,
	"reference_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"operation" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_input_tokens" integer,
	"image_count" integer,
	"cost_micro_usd" bigint NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."copy_packs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"platform" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"headline" text NOT NULL,
	"caption" text NOT NULL,
	"hashtags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cta" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."creative_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"thumbnail_storage_key" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"is_selected" boolean DEFAULT false NOT NULL,
	"qa_result" jsonb,
	"edits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"job_id" text,
	"external_ref" text,
	"balance_after" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."generation_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"product_id" text,
	"idempotency_key" text NOT NULL,
	"status" "content"."job_status" DEFAULT 'queued' NOT NULL,
	"stage" text,
	"campaign_type" "content"."campaign_type" NOT NULL,
	"style_template" "content"."style_template" NOT NULL,
	"output_format" "content"."output_format" NOT NULL,
	"request" jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "content"."product_images" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"cleaned_storage_key" text,
	"width" integer,
	"height" integer,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."products" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_minor" integer,
	"currency" text DEFAULT 'INR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo"."competitors" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo"."mentions" (
	"id" text PRIMARY KEY NOT NULL,
	"probe_run_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"entity_type" "geo"."entity_type" NOT NULL,
	"entity_id" text NOT NULL,
	"entity_name" text NOT NULL,
	"position" integer NOT NULL,
	"sentiment" "geo"."sentiment" DEFAULT 'neutral' NOT NULL,
	"excerpt" text NOT NULL,
	"cited_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo"."probe_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"prompt_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"engine" "geo"."answer_engine" NOT NULL,
	"model" text NOT NULL,
	"answer_text" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"latency_ms" integer,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo"."tracked_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"text" text NOT NULL,
	"intent" "geo"."prompt_intent" NOT NULL,
	"locale" text,
	"engines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schedule" text DEFAULT '0 6 * * 1' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo"."visibility_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"engine" "geo"."answer_engine",
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"presence_rate" real NOT NULL,
	"average_position" real,
	"share_of_voice" real NOT NULL,
	"citation_rate" real NOT NULL,
	"sentiment_score" real NOT NULL,
	"geo_score" integer NOT NULL,
	"prompts_probed" integer DEFAULT 0 NOT NULL,
	"runs_probed" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."brands" ADD CONSTRAINT "brands_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "core"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."cost_events" ADD CONSTRAINT "cost_events_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."copy_packs" ADD CONSTRAINT "copy_packs_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "content"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."creative_assets" ADD CONSTRAINT "creative_assets_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "content"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."credit_ledger" ADD CONSTRAINT "credit_ledger_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "content"."generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."generation_jobs" ADD CONSTRAINT "generation_jobs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."generation_jobs" ADD CONSTRAINT "generation_jobs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "content"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "content"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."products" ADD CONSTRAINT "products_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."competitors" ADD CONSTRAINT "competitors_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."mentions" ADD CONSTRAINT "mentions_probe_run_id_probe_runs_id_fk" FOREIGN KEY ("probe_run_id") REFERENCES "geo"."probe_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."mentions" ADD CONSTRAINT "mentions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."probe_runs" ADD CONSTRAINT "probe_runs_prompt_id_tracked_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "geo"."tracked_prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."probe_runs" ADD CONSTRAINT "probe_runs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."tracked_prompts" ADD CONSTRAINT "tracked_prompts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."visibility_snapshots" ADD CONSTRAINT "visibility_snapshots_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brands_owner_idx" ON "core"."brands" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "cost_events_brand_created_idx" ON "core"."cost_events" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "cost_events_system_idx" ON "core"."cost_events" USING btree ("system");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "core"."users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "copy_packs_job_idx" ON "content"."copy_packs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "creative_assets_job_idx" ON "content"."creative_assets" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "credit_ledger_user_created_idx" ON "content"."credit_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "generation_jobs_brand_created_idx" ON "content"."generation_jobs" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "generation_jobs_status_idx" ON "content"."generation_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "product_images_product_idx" ON "content"."product_images" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "products_brand_idx" ON "content"."products" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "competitors_brand_idx" ON "geo"."competitors" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "mentions_run_idx" ON "geo"."mentions" USING btree ("probe_run_id");--> statement-breakpoint
CREATE INDEX "mentions_brand_entity_idx" ON "geo"."mentions" USING btree ("brand_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "probe_runs_prompt_run_idx" ON "geo"."probe_runs" USING btree ("prompt_id","run_at");--> statement-breakpoint
CREATE INDEX "probe_runs_brand_run_idx" ON "geo"."probe_runs" USING btree ("brand_id","run_at");--> statement-breakpoint
CREATE INDEX "probe_runs_engine_idx" ON "geo"."probe_runs" USING btree ("engine");--> statement-breakpoint
CREATE INDEX "tracked_prompts_brand_idx" ON "geo"."tracked_prompts" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "tracked_prompts_active_idx" ON "geo"."tracked_prompts" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "visibility_snapshots_brand_period_idx" ON "geo"."visibility_snapshots" USING btree ("brand_id","period_start");