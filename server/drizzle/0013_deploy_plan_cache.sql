CREATE TABLE IF NOT EXISTS "deploy_plan_cache" (
	"project_id" text PRIMARY KEY NOT NULL,
	"plan" jsonb NOT NULL,
	"source" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deploy_plan_cache" ADD CONSTRAINT "deploy_plan_cache_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
