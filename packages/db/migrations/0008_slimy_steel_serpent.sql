ALTER TABLE "apps" ADD COLUMN "redirect_uris" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "grant_types" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "token_endpoint_auth_method" text DEFAULT 'client_secret_basic' NOT NULL;