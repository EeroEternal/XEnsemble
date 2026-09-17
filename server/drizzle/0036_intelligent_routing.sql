CREATE TABLE IF NOT EXISTS "session_route_sticky" (
	"session_id" text PRIMARY KEY NOT NULL,
	"chosen_model" text NOT NULL,
	"chosen_provider" text NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"expires_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_route_sticky" ADD CONSTRAINT "session_route_sticky_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
