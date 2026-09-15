ALTER TYPE "content"."social_platform" ADD VALUE 'google';--> statement-breakpoint
ALTER TABLE "content"."social_accounts" ADD COLUMN "refresh_token" text;