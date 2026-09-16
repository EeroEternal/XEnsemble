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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "routing_decisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" bigint NOT NULL,
	"session_id" text,
	"user_id" text,
	"agent_id" text,
	"project_id" text,
	"seq" integer NOT NULL,
	"reevaluated" boolean DEFAULT false NOT NULL,
	"trigger" text NOT NULL,
	"demand" jsonb,
	"sticky_model" text,
	"sticky_provider" text,
	"candidates" jsonb,
	"chosen_model" text,
	"chosen_provider" text,
	"cost_estimate" jsonb,
	"prompt_tokens" integer,
	"cached_tokens" integer,
	"completion_tokens" integer,
	"latency_ms" integer,
	"status_code" integer,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_routing_decisions_session_seq" ON "routing_decisions" ("session_id","seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_routing_decisions_user_created" ON "routing_decisions" ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_routing_decisions_created" ON "routing_decisions" ("created_at");
