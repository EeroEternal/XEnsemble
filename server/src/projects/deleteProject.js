const fs = require('fs');
const { eq, inArray, sql } = require('drizzle-orm');
const { db } = require('../db/index');
const schema = require('../db/schema');
const sessionManager = require('../session/SessionManager');
const { WorkspaceShellManager } = require('../session/workspaceShell');
const deploymentService = require('../deployments/DeploymentService');
const workspace = require('../workspace');

async function deleteProjectForUser(userId, project, opts = {}) {
    const projectId = project.id;
    const log = opts.log || null;

    // Invalidate the project cache immediately so concurrent callers (e.g. the
    // clone IIFE's ensureProjectRuntime -> getOrCreateDefaultRuntime) don't see
    // a stale "alive" project and INSERT new runtime rows that would cause an
    // FK violation on the projects delete below.
    try {
        const { invalidateProjectCache } = require('./getProjectForUser');
        invalidateProjectCache(projectId);
    } catch { /* circular dep guard */ }

    // Fetch sessions, deployments, and runtimes in parallel (3 SELECTs -> 1 round-trip).
    const [sessionRows, deploymentRows, runtimeRows] = await Promise.all([
        db.select().from(schema.sessions).where(eq(schema.sessions.projectId, projectId)),
        db.select().from(schema.deployments).where(eq(schema.deployments.projectId, projectId)),
        db.select().from(schema.runtimes).where(eq(schema.runtimes.projectId, projectId)),
    ]);

    // Phase 1: Kill in-memory session handles + shell managers (synchronous).
    const sessionIds = sessionRows.map((r) => r.id);
    for (const row of sessionRows) {
        try { sessionManager.deleteSession(row.id); }
        catch (err) { if (log?.warn) log.warn({ err, sessionId: row.id }, '[projects] deleteSession failed during project delete'); }
    }
    try { WorkspaceShellManager.deleteByProjectId(projectId); }
    catch (err) { if (log?.warn) log.warn({ err, projectId }, '[projects] WorkspaceShellManager.deleteByProjectId failed'); }

    // Phase 2: Stop running deployments (stop process + UPDATE status).
    // Individual row deletion is handled by the bulk DELETE in Phase 4 Round 1.
    for (const dep of deploymentRows) {
        if (dep.status === 'running') {
            try { await deploymentService.stopPreview(userId, dep); }
            catch (err) { if (log?.warn) log.warn({ err, deploymentId: dep.id }, '[projects] stopPreview failed during project delete'); }
        }
    }

    // Phase 3: Destroy runtime VMs (blink-server stop + delete).
    // destroy 失败必须记录：静默忽略会留下孤儿 VM，其 workspace 目录随后被删后会导致
    // boxlite 初始化 panic（见 orphan-VM 故障）。失败的 runtime 记录保留，便于后续对账清理。
    const { getRuntime } = require('../runtime/registry');
    const rt = getRuntime();
    const failedRuntimeRefs = [];
    for (const rrow of runtimeRows) {
        if (rrow.runtimeRef) {
            try {
                await rt.provider.destroy(rrow.runtimeRef);
            } catch (err) {
                failedRuntimeRefs.push(rrow.runtimeRef);
                if (log?.warn) {
                    log.warn({ err, projectId, runtimeRef: rrow.runtimeRef },
                        '[projects] failed to destroy runtime VM during project delete (orphan VM may remain)');
                }
            }
        }
    }

    // Phase 4: Delete all DB rows in 4 parallel rounds (FK dependency chain).
    //
    // Dependency graph (child -> parent, must delete child first):
    //   Round 1: 9 child tables (only reference projects or sessions, not each other)
    //   Round 2: repo_snapshots (after workspace_checkpoints) + sessions (after workspace_checkpoints + session_configs/streams)
    //   Round 3: runtimes (after sessions + deployments, both have runtime_id FK)
    //   Round 4: projects (after all children)
    //
    // All DELETEs are idempotent (0 rows affected on retry). On FK violation retry,
    // do a fresh SELECT sessions to catch concurrent inserts.
    const MAX_DELETE_RETRIES = 3;
    let lastDeleteErr = null;
    for (let attempt = 1; attempt <= MAX_DELETE_RETRIES; attempt += 1) {
        try {
            // On first attempt, use sessionIds from Phase 1 (saves 1 SELECT).
            // On retry, do a fresh SELECT to catch concurrent session inserts.
            const sidList = attempt === 1
                ? sessionIds
                : (await db.select({ id: schema.sessions.id }).from(schema.sessions)
                    .where(eq(schema.sessions.projectId, projectId))).map((s) => s.id);

            // Round 1: 9 parallel DELETEs (all independent child tables).
            await Promise.all([
                db.delete(schema.workspaceCheckpoints).where(eq(schema.workspaceCheckpoints.projectId, projectId)),
                db.delete(schema.devEnvironmentProfiles).where(eq(schema.devEnvironmentProfiles.projectId, projectId)),
                db.delete(schema.mergeRequests).where(eq(schema.mergeRequests.projectId, projectId)),
                db.delete(schema.projectBranches).where(eq(schema.projectBranches.projectId, projectId)),
                db.delete(schema.deployments).where(eq(schema.deployments.projectId, projectId)),
                db.delete(schema.events).where(eq(schema.events.projectId, projectId)),
                db.execute(sql`DELETE FROM pull_requests WHERE project_id = ${projectId}`),
                db.execute(sql`DELETE FROM auto_deploy_runs WHERE project_id = ${projectId}`),
                db.execute(sql`DELETE FROM deploy_verify_states WHERE project_id = ${projectId}`),
                sidList.length > 0
                    ? db.delete(schema.sessionConfigs).where(inArray(schema.sessionConfigs.sessionId, sidList))
                    : Promise.resolve(),
                sidList.length > 0
                    ? db.delete(schema.sessionStreams).where(inArray(schema.sessionStreams.sessionId, sidList))
                    : Promise.resolve(),
            ]);

            // Round 2: repo_snapshots (after workspace_checkpoints) + sessions (after session_configs/streams).
            await Promise.all([
                db.delete(schema.repoSnapshots).where(eq(schema.repoSnapshots.projectId, projectId)),
                db.delete(schema.sessions).where(eq(schema.sessions.projectId, projectId)),
            ]);

            // Round 3: runtimes (after sessions + deployments, both reference runtimes.id).
            await db.delete(schema.runtimes).where(eq(schema.runtimes.projectId, projectId));

            // Round 4: projects (after all children).
            await db.delete(schema.projects).where(eq(schema.projects.id, projectId));

            lastDeleteErr = null;
            break;
        } catch (err) {
            lastDeleteErr = err;
            if (attempt < MAX_DELETE_RETRIES) {
                if (log?.warn) log.warn({ err, projectId, attempt }, '[projects] delete retrying after FK violation');
                await new Promise((r) => setTimeout(r, 200 * attempt));
            }
        }
    }
    if (lastDeleteErr) throw lastDeleteErr;

    // Best-effort filesystem cleanup. The DB rows are already deleted above,
    // so failing here would report a 500 to the user even though the project
    // is gone from the DB. Common failure causes:
    // - VM still has the workspace mounted (destroy failed earlier)
    // - git pack files are read-only
    // - stale file handles from a recently killed process
    const dir = workspace.projectDir(userId, projectId);
    if (fs.existsSync(dir)) {
        try {
            await fs.promises.rm(dir, { recursive: true, force: true });
        } catch (err) {
            if (log?.warn) {
                log.warn({ err, projectId, dir }, '[projects] fs.rm failed during project delete (directory will be orphaned)');
            }
        }
    }

    return { failedRuntimeRefs };
}

module.exports = { deleteProjectForUser };
