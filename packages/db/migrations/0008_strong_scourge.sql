CREATE TYPE "content"."scheduled_campaign_status" AS ENUM('active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "content"."scheduled_post_status" AS ENUM('pending_generation', 'pending_approval', 'approved', 'rejected', 'posted', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "content"."push_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"expo_push_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."scheduled_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"product_id" text NOT NULL,
	"campaign_type" "content"."campaign_type" NOT NULL,
	"style_template" "content"."style_template" NOT NULL,
	"output_format" "content"."output_format" NOT NULL,
	"total_days" integer NOT NULL,
	"posts_per_day" integer NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"status" "content"."scheduled_campaign_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."scheduled_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"product_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" "content"."scheduled_post_status" DEFAULT 'pending_generation' NOT NULL,
	"generation_job_id" text,
	"selected_asset_id" text,
	"account_id" text,
	"caption" text,
	"ig_media_id" text,
	"error" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content"."push_tokens" ADD CONSTRAINT "push_tokens_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "core"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."scheduled_campaigns" ADD CONSTRAINT "scheduled_campaigns_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."scheduled_campaigns" ADD CONSTRAINT "scheduled_campaigns_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "content"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."scheduled_posts" ADD CONSTRAINT "scheduled_posts_campaign_id_scheduled_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "content"."scheduled_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."scheduled_posts" ADD CONSTRAINT "scheduled_posts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."scheduled_posts" ADD CONSTRAINT "scheduled_posts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "content"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."scheduled_posts" ADD CONSTRAINT "scheduled_posts_generation_job_id_generation_jobs_id_fk" FOREIGN KEY ("generation_job_id") REFERENCES "content"."generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."scheduled_posts" ADD CONSTRAINT "scheduled_posts_selected_asset_id_creative_assets_id_fk" FOREIGN KEY ("selected_asset_id") REFERENCES "content"."creative_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."scheduled_posts" ADD CONSTRAINT "scheduled_posts_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "content"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_tokens_owner_idx" ON "content"."push_tokens" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_tokens_token_idx" ON "content"."push_tokens" USING btree ("expo_push_token");--> statement-breakpoint
CREATE INDEX "scheduled_campaigns_brand_created_idx" ON "content"."scheduled_campaigns" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "scheduled_posts_brand_scheduled_idx" ON "content"."scheduled_posts" USING btree ("brand_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "scheduled_posts_campaign_idx" ON "content"."scheduled_posts" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "scheduled_posts_status_idx" ON "content"."scheduled_posts" USING btree ("status");