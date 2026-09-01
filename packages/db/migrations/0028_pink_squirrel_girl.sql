CREATE TABLE "content"."video_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"thumbnail_storage_key" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"duration_seconds" real NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"is_selected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."video_generation_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"product_id" text,
	"idempotency_key" text NOT NULL,
	"status" "content"."job_status" DEFAULT 'queued' NOT NULL,
	"stage" text,
	"request" jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_generation_jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "content"."video_assets" ADD CONSTRAINT "video_assets_job_id_video_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "content"."video_generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."video_generation_jobs" ADD CONSTRAINT "video_generation_jobs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."video_generation_jobs" ADD CONSTRAINT "video_generation_jobs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "content"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_assets_job_idx" ON "content"."video_assets" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "video_generation_jobs_brand_created_idx" ON "content"."video_generation_jobs" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "video_generation_jobs_status_idx" ON "content"."video_generation_jobs" USING btree ("status");