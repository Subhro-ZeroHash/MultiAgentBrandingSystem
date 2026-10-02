CREATE TABLE "content"."instagram_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"ig_account_id" text NOT NULL,
	"field" text NOT NULL,
	"event_key" text,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "instagram_webhook_events_event_key_idx" ON "content"."instagram_webhook_events" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "instagram_webhook_events_account_received_idx" ON "content"."instagram_webhook_events" USING btree ("ig_account_id","received_at");