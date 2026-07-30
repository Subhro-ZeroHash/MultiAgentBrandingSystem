CREATE TYPE "core"."site_profile_status" AS ENUM('ok', 'empty_document', 'unreachable', 'failed');--> statement-breakpoint
CREATE TABLE "core"."brand_site_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"source_url" text NOT NULL,
	"status" "core"."site_profile_status" NOT NULL,
	"extraction" jsonb,
	"analysis" jsonb,
	"error" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."brand_site_profiles" ADD CONSTRAINT "brand_site_profiles_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_site_profiles_brand_idx" ON "core"."brand_site_profiles" USING btree ("brand_id");