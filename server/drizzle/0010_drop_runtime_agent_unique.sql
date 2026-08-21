-- Drop the unique constraint that enforced one runtime per (project, agent) pair.
-- Now each session gets its own runtime (and thus its own VM + worktree),
-- even for the same agent in the same project.
DROP INDEX IF EXISTS "runtimes_project_agent_idx";
