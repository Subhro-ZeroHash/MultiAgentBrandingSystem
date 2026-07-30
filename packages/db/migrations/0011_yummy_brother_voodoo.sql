ALTER TABLE "core"."brand_site_profiles" ADD COLUMN "logo_storage_key" text;--> statement-breakpoint
ALTER TABLE "core"."brand_site_profiles" ADD COLUMN "style_reference_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."brand_site_profiles" ADD COLUMN "logo_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."brand_site_profiles" ADD COLUMN "style_references_applied_at" timestamp with time zone;