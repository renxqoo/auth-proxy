ALTER TABLE "registration_tokens" ADD COLUMN "single_use" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "registration_tokens" ADD COLUMN "used" boolean DEFAULT false NOT NULL;