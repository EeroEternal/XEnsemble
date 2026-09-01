const crypto = require('crypto');
const { eq, and, desc, inArray } = require('drizzle-orm');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { getRuntime } = require('../runtime/registry');
const { RuntimeError } = require('../runtime/interfaces');
const { ensureProjectRuntime } = require('../runtime/RuntimeService');
const { recordEvent } = require('../events/recordEvent');
const { singleflight } = require('../runtime/singleflight');
const { createCheckpoint } = require('../repositories/RepositoryEnvironmentService');
const previewRegistry = require('../runtime/localPreviewRegistry');
const { resolveRuntimeProvider } = require('../config/runtimeProvider');
const { tryRecoverPreview, checkPreviewEntryHealth } = require('../workspace/ensurePreview');

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

function generateRawToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function hashToken(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

function verifyToken(raw, hash) {
    if (!raw || !hash) return false;
    const rawHash = hashToken(raw);
    try {
        return crypto.timingSafeEqual(Buffer.from(rawHash, 'hex'), Buffer.from(hash, 'hex'));
    } catch {
        return false;
    }
}

async function issuePreviewToken(deploymentId) {
    const raw = generateRawToken();
    const tokenHash = hashToken(raw);
    await db.update(schema.deployments)
        .set({ previewTokenHash: tokenHash, updatedAt: Date.now() })
        .where(eq(schema.deployments.id, deploymentId));
    return raw;
}

async function clearPreviewToken(deploymentId) {
    await db.update(schema.deployments)
        .set({ previewTokenHash: null, updatedAt: Date.now() })
        .where(eq(schema.deployments.id, deploymentId));
}

function formatDeployment(row) {
    return {
        id: row.id,
        user_id: row.userId,
        project_id: row.projectId,
        runtime_id: row.runtimeId,
        session_id: row.sessionId,
        kind: row.kind,
        status: row.status,
        stage: row.stage,
        stage_message: row.stageMessage,
        public_url: row.publicUrl,
        internal_ref: row.internalRef,
        revision: row.revision,
        mode: row.mode,
        expires_at: row.expiresAt,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        last_error_code: row.lastErrorCode,
        last_error_message: row.lastErrorMessage,
    };
}

async function listForProject(userId, projectId) {
    const rows = await db.select().from(schema.deployments)
        .where(and(
            eq(schema.deployments.userId, userId),
            eq(schema.deployments.projectId, projectId),
        ))
        .orderBy(desc(schema.deployments.createdAt));
    return rows.map(formatDeployment);
}

async function getForUser(userId, deploymentId) {
    const rows = await db.select().from(schema.deployments)
        .where(and(
            eq(schema.deployments.id, deploymentId),
            eq(schema.deployments.userId, userId),
        ));
    return rows[0] || null;
}

async function createPreview(userId, project, opts = {}) {
    const ensureOpts = opts.runtimeId ? { runtimeId: opts.runtimeId } : {};
    const { runtime } = await ensureProjectRuntime(project, ensureOpts);
    const now = Date.now();
    const id = `dep_${crypto.randomBytes(8).toString('hex')}`;

    const checkpoint = await createCheckpoint(project, { status: 'ready' }, userId);
    const revision = `checkpoint:${checkpoint.id}`;

    // BoxLite 部署 revision 持久化：为该 checkpoint 拍 blink 快照
    const prov = resolveRuntimeProvider();
    if (prov === 'boxlite') {
        try {
            const ready = await ensureProjectRuntime(project, ensureOpts);
            const ref = ready.runtime && ready.runtime.runtimeRef;
            const rtt = getRuntime();
            if (ref && typeof rtt.provider.checkpoint === 'function') {
                await rtt.provider.checkpoint(ref, checkpoint.id);
                await db.update(schema.workspaceCheckpoints)
                    .set({ storageRef: `blink:${checkpoint.id}` })
                    .where(eq(schema.workspaceCheckpoints.id, checkpoint.id));
            }
        } catch (_) {}
    }

    await db.insert(schema.deployments).values({
        id,
        userId,
        projectId: project.id,
        runtimeId: runtime.id,
        kind: 'preview',
        status: 'pending',
        revision,
        expiresAt: now + PREVIEW_TTL_MS,
        createdAt: now,
        updatedAt: now,
        createdBy: userId,
    });

    await recordEvent({
        userId,
        projectId: project.id,
        subjectType: 'deployment',
        subjectId: id,
        type: 'created',
        data: { kind: 'preview', revision },
    });

    const row = await getForUser(userId, id);
    const previewToken = await issuePreviewToken(id);
    return { ...formatDeployment(row), preview_token: previewToken };
}

async function getByPreviewToken(deploymentId, rawToken) {
    const rows = await db.select().from(schema.deployments)
        .where(eq(schema.deployments.id, deploymentId));
    const row = rows[0];
    if (!row) return null;
    if (!verifyToken(rawToken, row.previewTokenHash)) return null;
    return row;
}

async function startPreview(userId, project, deployment) {
    return singleflight(`preview:start:${deployment.id}`, async () => {
        let ensureOpts = {};
        if (deployment.runtimeId) {
            ensureOpts = { runtimeId: deployment.runtimeId };
        }
        if (deployment.revision && deployment.revision.startsWith('checkpoint:')) {
            const ckId = deployment.revision.split(':')[1];
            ensureOpts = { ...ensureOpts, checkpointId: ckId };
        }
        const { runtime, workspacePath } = await ensureProjectRuntime(project, ensureOpts);
        const now = Date.now();
        const rt = getRuntime();

        await db.update(schema.deployments).set({
            status: 'building',
            runtimeId: runtime.id,
            updatedAt: now,
            lastErrorCode: null,
            lastErrorMessage: null,
        }).where(eq(schema.deployments.id, deployment.id));

        try {
            const result = await rt.preview.startPreview(
                { ...project, workspacePath },
                { revision: deployment.revision, deploymentId: deployment.id },
            );
            await db.update(schema.deployments).set({
                status: 'running',
                publicUrl: result.publicUrl ?? null,
                internalRef: result.internalRef ?? null,
                updatedAt: Date.now(),
            }).where(eq(schema.deployments.id, deployment.id));

            await recordEvent({
                userId,
                projectId: project.id,
                subjectType: 'deployment',
                subjectId: deployment.id,
                type: 'ready',
                data: { publicUrl: result.publicUrl },
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const code = err instanceof RuntimeError ? String(err.statusCode) : 'preview_unavailable';
            await db.update(schema.deployments).set({
                status: 'failed',
                lastErrorCode: code,
                lastErrorMessage: message,
                updatedAt: Date.now(),
            }).where(eq(schema.deployments.id, deployment.id));

            await recordEvent({
                userId,
                projectId: project.id,
                subjectType: 'deployment',
                subjectId: deployment.id,
                type: 'failed',
                data: { code, message },
            });
            throw err;
        }

        const row = await getForUser(userId, deployment.id);
        const previewToken = await issuePreviewToken(deployment.id);
        return { ...formatDeployment(row), preview_token: previewToken };
    });
}

async function stopPreview(userId, deployment) {
    const rt = getRuntime();
    try {
        await rt.preview.stopPreview(deployment);
    } catch (_) {
        /* Local MVP：stop 可能未实现，仍标记 stopped */
    }
    const now = Date.now();
    await db.update(schema.deployments).set({
        status: 'stopped',
        previewTokenHash: null,
        updatedAt: now,
        stoppedBy: userId,
    }).where(eq(schema.deployments.id, deployment.id));

    // 状态对齐：一键部署（twoStage）会为同一 project+session 同时写入 kind='deploy'（进度）与
    // kind='preview'（隧道）两条记录。停止其中一条时，另一条若仍是 running 会永久卡在运行态
    // （前端误判"部署中"，且并发配额把残留记录算作占用）。这里把同 project+session 的所有
    // running/building 记录一并标记 stopped，保证右上角状态与实际隧道一致。
    try {
        const conds = [
            eq(schema.deployments.userId, userId),
            eq(schema.deployments.projectId, deployment.projectId),
            inArray(schema.deployments.status, ['running', 'building']),
        ];
        if (deployment.sessionId) conds.push(eq(schema.deployments.sessionId, deployment.sessionId));
        await db.update(schema.deployments).set({
            status: 'stopped',
            updatedAt: now,
            stoppedBy: userId,
        }).where(and(...conds));
    } catch (e) {
        console.error('[deployment] failed to sync sibling deployment statuses:', e.message);
    }

    await recordEvent({
        userId,
        projectId: deployment.projectId,
        subjectType: 'deployment',
        subjectId: deployment.id,
        type: 'stopped',
        data: {},
    });

    const row = await getForUser(userId, deployment.id);
    return formatDeployment(row);
}

async function remove(userId, deploymentId) {
    const row = await getForUser(userId, deploymentId);
    if (row && row.status === 'running') {
        await stopPreview(userId, row);
    }
    await db.delete(schema.deployments)
        .where(and(
            eq(schema.deployments.id, deploymentId),
            eq(schema.deployments.userId, userId),
        ));
}

/** 创建 preview deployment 并立即 start（Console 一键部署）。 */
async function deployAndStartPreview(userId, project, opts = {}) {
    const dep = await createPreview(userId, project, opts);
    const row = await getForUser(userId, dep.id);
    return startPreview(userId, project, row);
}

/**
 * 幂等 ensure-preview：健康则复用，失活则重启，无 deployment 则创建并启动。
 */
async function ensurePreview(userId, project) {
    return singleflight(`preview:ensure:${project.id}`, async () => {
        let ensureOpts = {};
        const rows = await db.select().from(schema.deployments)
            .where(and(
                eq(schema.deployments.userId, userId),
                eq(schema.deployments.projectId, project.id),
                eq(schema.deployments.kind, 'preview'),
            ))
            .orderBy(desc(schema.deployments.createdAt));

        let deployment = rows.find((r) => r.status === 'running')
            || rows.find((r) => r.status === 'building')
            || rows.find((r) => r.status === 'pending')
            || rows.find((r) => r.status === 'failed')
            || rows.find((r) => r.status === 'stopped');

        if (!deployment) {
            const result = await deployAndStartPreview(userId, project);
            return { ...result, ensured: 'created' };
        }

        if (deployment.revision && deployment.revision.startsWith('checkpoint:')) {
            ensureOpts = { checkpointId: deployment.revision.split(':')[1] };
        }
        const { workspacePath } = await ensureProjectRuntime(project, ensureOpts);

        if (deployment.status === 'pending' || deployment.status === 'failed') {
            const result = await startPreview(userId, project, deployment);
            return { ...result, ensured: 'started' };
        }

        if (deployment.status === 'building') {
            const row = await getForUser(userId, deployment.id);
            const previewToken = await issuePreviewToken(deployment.id);
            return { ...formatDeployment(row), preview_token: previewToken, ensured: 'building' };
        }

        if (deployment.status === 'stopped') {
            const result = await startPreview(userId, project, deployment);
            return { ...result, ensured: 'restarted' };
        }

        let entry = previewRegistry.get(deployment.id);
        if (!entry) {
            entry = await tryRecoverPreview(deployment, workspacePath);
        }

        const healthy = entry && await checkPreviewEntryHealth(entry);
        if (healthy) {
            previewRegistry.set(deployment.id, entry, { publicUrl: deployment.publicUrl });
            const row = await getForUser(userId, deployment.id);
            const previewToken = await issuePreviewToken(deployment.id);
            return { ...formatDeployment(row), preview_token: previewToken, ensured: 'reused' };
        }

        await stopPreview(userId, deployment);
        const row = await getForUser(userId, deployment.id);
        const result = await startPreview(userId, project, row);
        return { ...result, ensured: 'restarted' };
    });
}

module.exports = {
    formatDeployment,
    listForProject,
    getForUser,
    getByPreviewToken,
    issuePreviewToken,
    createPreview,
    startPreview,
    stopPreview,
    deployAndStartPreview,
    ensurePreview,
    remove,
};
