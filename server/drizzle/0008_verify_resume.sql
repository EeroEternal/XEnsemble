CREATE TABLE IF NOT EXISTS "deploy_verify_states" (
	"project_id" text PRIMARY KEY NOT NULL,
	"plan" jsonb NOT NULL,
	"messages" jsonb NOT NULL,
	"trail" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rounds_used" integer DEFAULT 0 NOT NULL,
	"runtime_ref" text,
	"workspace_path" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deploy_verify_states" ADD CONSTRAINT "deploy_verify_states_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
