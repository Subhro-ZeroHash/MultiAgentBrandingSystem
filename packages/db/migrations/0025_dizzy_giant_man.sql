CREATE TABLE "content"."post_insights" (
	"id" text PRIMARY KEY NOT NULL,
	"scheduled_post_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"like_count" integer,
	"comments_count" integer,
	"reach" integer,
	"saved" integer,
	"raw" jsonb,
	"error" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content"."post_insights" ADD CONSTRAINT "post_insights_scheduled_post_id_scheduled_posts_id_fk" FOREIGN KEY ("scheduled_post_id") REFERENCES "content"."scheduled_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."post_insights" ADD CONSTRAINT "post_insights_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_insights_scheduled_post_fetched_idx" ON "content"."post_insights" USING btree ("scheduled_post_id","fetched_at");--> statement-breakpoint
CREATE INDEX "post_insights_brand_fetched_idx" ON "content"."post_insights" USING btree ("brand_id","fetched_at");