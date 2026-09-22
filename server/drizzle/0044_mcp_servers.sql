-- P1 MCP support: user-managed MCP servers injected into the agent's config at
-- session start (Claude Code project-scoped .mcp.json for now, stdio transport).
CREATE TABLE IF NOT EXISTS "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"description" text,
	"transport" text NOT NULL DEFAULT 'stdio',
	"command" text,
	"args" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"env" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"enabled" boolean NOT NULL DEFAULT true,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'mcp_servers_owner_user_id_users_id_fk'
		  AND conrelid = 'mcp_servers'::regclass
	) THEN
		ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'mcp_servers_project_id_projects_id_fk'
		  AND conrelid = 'mcp_servers'::regclass
	) THEN
		ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "unq_mcp_owner_project_name" ON "mcp_servers" ("owner_user_id", COALESCE("project_id", ''), "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_servers_owner" ON "mcp_servers" ("owner_user_id", "enabled");
