CREATE TABLE "route_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"pattern" text NOT NULL,
	"scope" text,
	"method" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
