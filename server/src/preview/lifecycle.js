const { eq, and, lt } = require('drizzle-orm');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { getRuntime } = require('../runtime/registry');
const { recordEvent } = require('../events/recordEvent');
const previewRegistry = require('../runtime/localPreviewRegistry');
const { probePort } = require('../runtime/previewHealth');
const { getPreviewPort } = require('../workspace/previewPorts');
const { projectDir } = require('../workspace');
const { cleanupStale } = require('../deployments/activeDeploys');

const SCAN_MS = 60_000;
// activeDeploys 残留清理阈值：大于部署总超时（45 分钟）的合理缓冲，
// 部署进程异常退出（卡死/被杀）时 finally 可能未执行，超时残留应被清掉
const ACTIVE_DEPLOY_STALE_MS = 60 * 60 * 1000;

async function resolveWorkspacePath(row) {
    const projects = await db.select({ serverPath: schema.projects.serverPath })
        .from(schema.projects)
        .where(eq(schema.projects.id, row.projectId));
    const serverPath = projects[0]?.serverPath;
    if (serverPath) return serverPath;
    return projectDir(row.userId, row.projectId);
}

/** server 重启后尝试从 `.agents/ports.json` 恢复；否则将 DB 中 running preview 标为 stopped */
async function reconcileStaleRunningPreviews() {
    const rows = await db.select().from(schema.deployments)
        .where(and(
            eq(schema.deployments.kind, 'preview'),
            eq(schema.deployments.status, 'running'),
        ));

    for (const row of rows) {
        if (previewRegistry.get(row.id)) continue;

        const workspacePath = await resolveWorkspacePath(row);
        const persisted = getPreviewPort(workspacePath, row.id);
        if (persisted?.port && await probePort('127.0.0.1', persisted.port)) {
            previewRegistry.set(row.id, {
                port: persisted.port,
                child: null,
                workspacePath,
                startedAt: persisted.started_at || Date.now(),
                recovered: true,
            }, { publicUrl: row.publicUrl || persisted.public_url });
            continue;
        }

        await db.update(schema.deployments).set({
            status: 'stopped',
            lastErrorMessage: 'Preview process lost after control plane restart',
            updatedAt: Date.now(),
        }).where(eq(schema.deployments.id, row.id));
    }
}

async function expirePreviews() {
    const now = Date.now();
    const rows = await db.select().from(schema.deployments)
        .where(and(
            eq(schema.deployments.kind, 'preview'),
            eq(schema.deployments.status, 'running'),
            lt(schema.deployments.expiresAt, now),
        ));

    const rt = getRuntime();
    for (const row of rows) {
        try {
            await rt.preview.stopPreview(row);
        } catch (_) { /* ignore */ }
        await db.update(schema.deployments).set({
            status: 'expired',
            previewTokenHash: null,
            updatedAt: now,
        }).where(eq(schema.deployments.id, row.id));

        await recordEvent({
            userId: row.userId,
            projectId: row.projectId,
            subjectType: 'deployment',
            subjectId: row.id,
            type: 'expired',
            data: {},
        });
    }
}

function startPreviewLifecycle() {
    reconcileStaleRunningPreviews().catch((err) => {
        console.error('[lifecycle] reconcile failed', err);
    });
    setInterval(() => {
        // 定期清理孤儿 running preview（registry 无 + probe 不通的），
        // 避免残留 preview 占用并发额度导致误报"已达并发上限"
        reconcileStaleRunningPreviews().catch((err) => console.error('[lifecycle] reconcile failed', err));
        expirePreviews().catch((err) => console.error('[lifecycle] expire failed', err));
        // 定期清理 activeDeploys 中"超时仍残留"的进行中部署 entry（部署进程异常退出时
        // finally 可能未执行），避免 countByUser 偏大误报超限
        try { cleanupStale(ACTIVE_DEPLOY_STALE_MS); } catch (err) { console.error('[lifecycle] cleanupStale failed', err); }
    }, SCAN_MS);
}

module.exports = { startPreviewLifecycle, reconcileStaleRunningPreviews, expirePreviews };
