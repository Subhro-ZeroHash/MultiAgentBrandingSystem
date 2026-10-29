CREATE TABLE "content"."ad_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"platform" text NOT NULL,
	"campaign_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"daily_budget" real DEFAULT 0 NOT NULL,
	"spend_to_date" real DEFAULT 0 NOT NULL,
	"roas" real DEFAULT 0 NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."ad_optimizations" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"campaign_id" text,
	"suggestion_type" text NOT NULL,
	"reasoning" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"action_payload" jsonb,
	"impact_estimate" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "content"."ad_campaigns" ADD CONSTRAINT "ad_campaigns_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."ad_optimizations" ADD CONSTRAINT "ad_optimizations_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."ad_optimizations" ADD CONSTRAINT "ad_optimizations_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "content"."ad_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_campaigns_brand_id_idx" ON "content"."ad_campaigns" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_platform_idx" ON "content"."ad_campaigns" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "ad_optimizations_brand_id_idx" ON "content"."ad_optimizations" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "ad_optimizations_campaign_id_idx" ON "content"."ad_optimizations" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "ad_optimizations_status_idx" ON "content"."ad_optimizations" USING btree ("status");