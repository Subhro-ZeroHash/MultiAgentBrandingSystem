CREATE TYPE "content"."asset_edit_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "content"."variant_kind" AS ENUM('trend', 'website', 'clean');--> statement-breakpoint
CREATE TABLE "content"."asset_edits" (
	"id" text PRIMARY KEY NOT NULL,
	"root_asset_id" text NOT NULL,
	"source_asset_id" text NOT NULL,
	"instruction" text NOT NULL,
	"status" "content"."asset_edit_status" DEFAULT 'queued' NOT NULL,
	"result_asset_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "content"."creative_assets" ADD COLUMN "variant_kind" "content"."variant_kind";--> statement-breakpoint
ALTER TABLE "content"."creative_assets" ADD COLUMN "root_asset_id" text;--> statement-breakpoint
ALTER TABLE "content"."asset_edits" ADD CONSTRAINT "asset_edits_root_asset_id_creative_assets_id_fk" FOREIGN KEY ("root_asset_id") REFERENCES "content"."creative_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."asset_edits" ADD CONSTRAINT "asset_edits_source_asset_id_creative_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "content"."creative_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."asset_edits" ADD CONSTRAINT "asset_edits_result_asset_id_creative_assets_id_fk" FOREIGN KEY ("result_asset_id") REFERENCES "content"."creative_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_edits_root_idx" ON "content"."asset_edits" USING btree ("root_asset_id");--> statement-breakpoint
ALTER TABLE "content"."creative_assets" ADD CONSTRAINT "creative_assets_root_asset_id_creative_assets_id_fk" FOREIGN KEY ("root_asset_id") REFERENCES "content"."creative_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creative_assets_root_idx" ON "content"."creative_assets" USING btree ("root_asset_id");