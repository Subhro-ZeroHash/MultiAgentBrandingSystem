CREATE TYPE "content"."trend_action_tier" AS ENUM('immediate_action', 'recommended', 'monitor', 'ignore');--> statement-breakpoint
ALTER TABLE "content"."automation_settings" ADD COLUMN "auto_trigger_high_score_opportunities" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "content"."trend_opportunities" ADD COLUMN "product_id" text;--> statement-breakpoint
ALTER TABLE "content"."trend_opportunities" ADD COLUMN "action_tier" "content"."trend_action_tier";--> statement-breakpoint
UPDATE "content"."trend_opportunities" SET "action_tier" = CASE
  WHEN (("score"->>'overall')::numeric) >= 92 THEN 'immediate_action'
  WHEN (("score"->>'overall')::numeric) >= 75 THEN 'recommended'
  WHEN (("score"->>'overall')::numeric) >= 50 THEN 'monitor'
  ELSE 'ignore'
END::"content"."trend_action_tier";--> statement-breakpoint
ALTER TABLE "content"."trend_opportunities" ALTER COLUMN "action_tier" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "content"."trend_opportunities" ADD COLUMN "auto_triggered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "content"."trend_opportunities" ADD COLUMN "auto_triggered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content"."trend_opportunities" ADD COLUMN "generation_job_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "content"."trend_opportunities" ADD CONSTRAINT "trend_opportunities_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "content"."products"("id") ON DELETE set null ON UPDATE no action;