const { eq, and, lt, inArray } = require('drizzle-orm');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { getRuntime } = require('../runtime/registry');
const { recordEvent } = require('../events/recordEvent');
const previewRegistry = require('../runtime/localPreviewRegistry');
const { probePreviewHealthy } = require('../runtime/previewHealth');
const { getPreviewPort } = require('../workspace/previewPorts');
const { projectDir } = require('../workspace');
const { cleanupStale } = require('../deployments/activeDeploys');

const SCAN_MS = 60_000;
// activeDeploys 残留清理阈值：大于部署总超时（45 分钟）的合理缓冲，
// 部署进程异常退出（卡死/被杀）时 finally 可能未执行，超时残留应被清掉
const ACTIVE_DEPLOY_STALE_MS = 60 * 60 * 1000;
// deploy 记录卡在 building/pending 的清理阈值：超过该时长仍非终态视为异常退出
// （finally 未执行），定期标 failed 回收，避免残留干扰前端状态/占用额度
const STALE_DEPLOY_BUILDING_MS = 30 * 60 * 1000;

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
        // 用"HTTP 内容探测"而非仅 TCP 端口：tunnel 的 browserPort 在宿主监听即可
        // probe 通过，但到沙箱的隧道/应用可能已断（返回 Tunnel not ready）→ 那是孤儿，
        // 应标 stopped，避免右上角出现"stop preview"但实际没有预览。
        if (persisted?.port && await probePreviewHealthy('127.0.0.1', persisted.port)) {
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

// 孤儿 preview 回收间隔：比其它定期任务更短（影响右上角观感——"stop preview 但无预览"要尽快消失）
const RECONCILE_MS = 15 * 1000;

function startPreviewLifecycle() {
    reconcileStaleRunningPreviews().catch((err) => {
        console.error('[lifecycle] reconcile failed', err);
    });
    // 孤儿 running preview 回收更快：registry 无 + HTTP 探测不通/Tunnel not ready 的
    // 尽快标 stopped，避免右上角"stop preview 但无预览"
    setInterval(() => {
        reconcileStaleRunningPreviews().catch((err) => console.error('[lifecycle] reconcile failed', err));
    }, RECONCILE_MS);
    setInterval(() => {
        expirePreviews().catch((err) => console.error('[lifecycle] expire failed', err));
        // 定期清理 activeDeploys 中"超时仍残留"的进行中部署 entry（部署进程异常退出时
        // finally 可能未执行），避免 countByUser 偏大误报超限
        try { cleanupStale(ACTIVE_DEPLOY_STALE_MS); } catch (err) { console.error('[lifecycle] cleanupStale failed', err); }
        // 定期回收卡在 building/pending 超过阈值的 deploy 记录（异常退出残留）
        reclaimStaleBuildingDeploys().catch((err) => console.error('[lifecycle] reclaim building failed', err));
    }, SCAN_MS);
}

// 回收长时间卡在 building/pending 的 deploy 记录：部署进程异常退出时 finally 可能未执行，
// 记录卡 building，会干扰 usePreview 选择（假转圈）与并发计数。超过阈值标 failed。
async function reclaimStaleBuildingDeploys() {
    const staleBefore = Date.now() - STALE_DEPLOY_BUILDING_MS;
    const rows = await db.select({ id: schema.deployments.id }).from(schema.deployments)
        .where(and(
            eq(schema.deployments.kind, 'deploy'),
            inArray(schema.deployments.status, ['building', 'pending']),
            lt(schema.deployments.updatedAt, staleBefore),
        ));
    for (const r of rows) {
        await db.update(schema.deployments)
            .set({ status: 'failed', lastErrorMessage: '部署进程异常退出，已回收', updatedAt: Date.now() })
            .where(eq(schema.deployments.id, r.id));
    }
}

module.exports = { startPreviewLifecycle, reconcileStaleRunningPreviews, expirePreviews };
