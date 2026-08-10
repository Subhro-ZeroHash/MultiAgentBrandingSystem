ALTER TABLE "core"."brands" ADD COLUMN "tone" jsonb DEFAULT '["friendly"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."brands" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "core"."brands" ADD COLUMN "languages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."brands" ADD COLUMN "platforms" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."brands" ADD COLUMN "banned_topics" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "content"."products" ADD COLUMN "selling_points" jsonb DEFAULT '[]'::jsonb NOT NULL;