CREATE TYPE "content"."social_account_status" AS ENUM('active', 'token_expired', 'revoked');--> statement-breakpoint
CREATE TABLE "content"."social_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"platform" text NOT NULL,
	"page_id" text NOT NULL,
	"ig_business_id" text,
	"page_access_token" text NOT NULL,
	"token_expires_at" timestamp with time zone,
	"display_name" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "content"."social_account_status" DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content"."social_accounts" ADD CONSTRAINT "social_accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "core"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "social_accounts_owner_idx" ON "content"."social_accounts" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "social_accounts_platform_idx" ON "content"."social_accounts" USING btree ("platform");