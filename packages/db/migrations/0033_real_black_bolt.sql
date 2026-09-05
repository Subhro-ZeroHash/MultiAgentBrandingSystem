CREATE TABLE "content"."notification_history" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content"."notification_history" ADD CONSTRAINT "notification_history_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "core"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."notification_history" ADD CONSTRAINT "notification_history_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_history_owner_created_idx" ON "content"."notification_history" USING btree ("owner_id","created_at");