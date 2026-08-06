CREATE TABLE "refresh_token_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"refresh_jti" text NOT NULL,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_history_jti_unique" ON "refresh_token_history" USING btree ("refresh_jti");--> statement-breakpoint
CREATE INDEX "refresh_history_session" ON "refresh_token_history" USING btree ("session_id");