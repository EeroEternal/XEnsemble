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
ALTER TABLE "auto_deploy_runs" ADD CONSTRAINT "auto_deploy_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_deploy_runs" ADD CONSTRAINT "auto_deploy_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_auto_deploy_runs_project" ON "auto_deploy_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_auto_deploy_runs_status" ON "auto_deploy_runs" USING btree ("status");
