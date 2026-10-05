CREATE TYPE "content"."inbox_channel" AS ENUM('comment', 'dm');--> statement-breakpoint
CREATE TYPE "content"."inbox_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "content"."inbox_thread_status" AS ENUM('needs_reply', 'replied', 'ignored');--> statement-breakpoint
CREATE TABLE "content"."inbox_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"ig_message_id" text NOT NULL,
	"direction" "content"."inbox_direction" NOT NULL,
	"username" text,
	"text" text,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."inbox_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"social_account_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content"."inbox_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"social_account_id" text NOT NULL,
	"channel" "content"."inbox_channel" NOT NULL,
	"external_id" text NOT NULL,
	"ig_media_id" text,
	"customer_username" text,
	"status" "content"."inbox_thread_status" DEFAULT 'needs_reply' NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"last_customer_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content"."inbox_messages" ADD CONSTRAINT "inbox_messages_thread_id_inbox_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "content"."inbox_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."inbox_settings" ADD CONSTRAINT "inbox_settings_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."inbox_settings" ADD CONSTRAINT "inbox_settings_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "content"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."inbox_threads" ADD CONSTRAINT "inbox_threads_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "core"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content"."inbox_threads" ADD CONSTRAINT "inbox_threads_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "content"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_messages_thread_message_idx" ON "content"."inbox_messages" USING btree ("thread_id","ig_message_id");--> statement-breakpoint
CREATE INDEX "inbox_messages_thread_sent_idx" ON "content"."inbox_messages" USING btree ("thread_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_settings_brand_idx" ON "content"."inbox_settings" USING btree ("brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_settings_account_idx" ON "content"."inbox_settings" USING btree ("social_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_threads_account_channel_external_idx" ON "content"."inbox_threads" USING btree ("social_account_id","channel","external_id");--> statement-breakpoint
CREATE INDEX "inbox_threads_brand_status_last_idx" ON "content"."inbox_threads" USING btree ("brand_id","status","last_message_at");