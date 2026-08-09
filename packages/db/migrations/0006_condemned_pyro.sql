CREATE TABLE "scopes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scopes_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "allowed_scopes" text[] DEFAULT '{}' NOT NULL;