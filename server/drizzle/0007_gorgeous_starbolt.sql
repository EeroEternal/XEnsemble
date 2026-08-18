CREATE TABLE "session_configs" (
	"session_id" text PRIMARY KEY NOT NULL,
	"config_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_image_builds" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"image_ref" text,
	"tag" text,
	"logs_ref" text,
	"failure_reason" text,
	"version_id" text,
	"notes" text,
	"started_at" bigint,
	"finished_at" bigint,
	"created_by" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_deploy_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"detected_type" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preview_deployment_id" text,
	"preview_url" text,
	"error" text,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
DROP TABLE "pull_requests" CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "provisioning_error" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "vm_resources" jsonb;--> statement-breakpoint
ALTER TABLE "session_configs" ADD CONSTRAINT "session_configs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_image_builds" ADD CONSTRAINT "agent_image_builds_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_image_builds" ADD CONSTRAINT "agent_image_builds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_deploy_runs" ADD CONSTRAINT "auto_deploy_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_deploy_runs" ADD CONSTRAINT "auto_deploy_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_image_builds_agent_state" ON "agent_image_builds" USING btree ("agent_id","state");--> statement-breakpoint
CREATE INDEX "idx_auto_deploy_runs_project" ON "auto_deploy_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_auto_deploy_runs_status" ON "auto_deploy_runs" USING btree ("status");