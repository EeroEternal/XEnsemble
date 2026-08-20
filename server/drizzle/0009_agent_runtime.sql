-- Add agentId column to runtimes table for per-agent VM isolation.
-- Each (project, agent) pair gets its own runtime/VM instead of sharing one.
ALTER TABLE "runtimes" ADD COLUMN "agent_id" text;

-- Unique constraint: one runtime per (project, agent) pair.
-- agentId can be NULL for legacy/default runtimes created before this migration.
CREATE UNIQUE INDEX IF NOT EXISTS "runtimes_project_agent_idx" ON "runtimes" ("project_id", "agent_id");
