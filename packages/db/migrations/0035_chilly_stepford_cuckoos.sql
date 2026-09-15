CREATE TYPE "content"."google_review_status" AS ENUM('needs_reply', 'draft_ready', 'approved', 'published', 'dismissed');--> statement-breakpoint
CREATE TABLE "content"."google_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"social_account_id" text NOT NULL,
	"external_review_id" text NOT NULL,
	"reviewer_name" text NOT NULL,
	"rating" integer NOT NULL,
	"review_text" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"draft_reply" text,
	"status" "content"."google_review_status" DEFAULT 'needs_reply' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content"."google_reviews" ADD CONSTRAINT "google_reviews_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."google_reviews" ADD CONSTRAINT "google_reviews_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "content"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "google_reviews_brand_status_idx" ON "content"."google_reviews" USING btree ("brand_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "google_reviews_account_external_idx" ON "content"."google_reviews" USING btree ("social_account_id","external_review_id");