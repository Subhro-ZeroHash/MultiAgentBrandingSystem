CREATE TABLE "content"."video_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"thumbnail_url" text NOT NULL,
	"reference_video_url" text NOT NULL,
	"scene_direction" text DEFAULT '' NOT NULL,
	"camera" text,
	"style" text DEFAULT 'lifestyle_in_use' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
