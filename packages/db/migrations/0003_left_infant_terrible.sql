CREATE TYPE "content"."social_platform" AS ENUM('instagram', 'facebook');--> statement-breakpoint
DROP INDEX "content"."social_accounts_owner_idx";--> statement-breakpoint
DROP INDEX "content"."social_accounts_platform_idx";--> statement-breakpoint
ALTER TABLE "content"."social_accounts" ALTER COLUMN "platform" SET DATA TYPE "content"."social_platform" USING "platform"::"content"."social_platform";--> statement-breakpoint
ALTER TABLE "content"."social_accounts" ALTER COLUMN "token_expires_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "social_accounts_owner_platform_idx" ON "content"."social_accounts" USING btree ("owner_id","platform");--> statement-breakpoint
CREATE INDEX "social_accounts_status_expires_idx" ON "content"."social_accounts" USING btree ("status","token_expires_at");