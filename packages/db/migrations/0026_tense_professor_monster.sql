CREATE TABLE "content"."post_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"ig_comment_id" text NOT NULL,
	"ig_media_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"social_account_id" text,
	"text" text,
	"username" text,
	"like_count" integer,
	"commented_at" timestamp with time zone,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content"."post_insights" DROP CONSTRAINT "post_insights_scheduled_post_id_scheduled_posts_id_fk";
--> statement-breakpoint
ALTER TABLE "content"."post_insights" ALTER COLUMN "scheduled_post_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "content"."post_insights" ADD COLUMN "ig_media_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "content"."post_insights" ADD COLUMN "social_account_id" text;--> statement-breakpoint
ALTER TABLE "content"."post_insights" ADD COLUMN "caption" text;--> statement-breakpoint
ALTER TABLE "content"."post_insights" ADD COLUMN "permalink" text;--> statement-breakpoint
ALTER TABLE "content"."post_insights" ADD COLUMN "media_type" text;--> statement-breakpoint
ALTER TABLE "content"."post_insights" ADD COLUMN "posted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content"."post_comments" ADD CONSTRAINT "post_comments_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."post_comments" ADD CONSTRAINT "post_comments_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "content"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_comments_ig_comment_id_idx" ON "content"."post_comments" USING btree ("ig_comment_id");--> statement-breakpoint
CREATE INDEX "post_comments_media_idx" ON "content"."post_comments" USING btree ("ig_media_id");--> statement-breakpoint
CREATE INDEX "post_comments_brand_commented_idx" ON "content"."post_comments" USING btree ("brand_id","commented_at");--> statement-breakpoint
ALTER TABLE "content"."post_insights" ADD CONSTRAINT "post_insights_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "content"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."post_insights" ADD CONSTRAINT "post_insights_scheduled_post_id_scheduled_posts_id_fk" FOREIGN KEY ("scheduled_post_id") REFERENCES "content"."scheduled_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_insights_media_fetched_idx" ON "content"."post_insights" USING btree ("ig_media_id","fetched_at");