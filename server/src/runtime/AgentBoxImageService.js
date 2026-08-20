const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { eq, and, desc } = require('drizzle-orm');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { RuntimeError } = require('./interfaces');
const {
    AGENT_BOX_IMAGE_CATALOG,
    getAgentBoxInstallCommand,
    imageRegistry,
    resolveAgentBoxImageDefault,
    resolveBoxBaseImage,
} = require('./agentBoxImages');

const BUILD_LOG_DIR = process.env.CUSTOM_IMAGE_BUILD_LOG_DIR
    || path.join(process.cwd(), '.data', 'custom-image-builds');
const BUILD_TIMEOUT_MS = parseInt(process.env.CUSTOM_IMAGE_BUILD_TIMEOUT_MS || String(30 * 60 * 1000), 10);

function formatVersionRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        agent_id: row.agentId,
        image_ref: row.imageRef,
        tag: row.tag,
        digest: row.digest || null,
        status: row.status,
        is_active: Boolean(row.isActive),
        built_at: row.builtAt || null,
        notes: row.notes || null,
        created_by: row.createdBy || null,
        created_at: row.createdAt,
    };
}

function getCatalogEntry(agentId) {
    return AGENT_BOX_IMAGE_CATALOG[agentId] || null;
}

function isAgentBoxBuildable(agentId) {
    const catalog = getCatalogEntry(agentId);
    if (catalog?.buildable === false) return false;
    return Boolean(getAgentBoxInstallCommand(agentId));
}

function buildDefaultImageRef(agentId, tag) {
    const catalog = getCatalogEntry(agentId);
    const imageTag = catalog?.tag || agentId;
    const versionTag = String(tag || 'latest').trim() || 'latest';
    return `${imageRegistry()}/agent-${imageTag}:${versionTag}`;
}

function normalizeTag(tag) {
    const value = String(tag || '').trim();
    if (!value) {
        throw new RuntimeError('tag is required', 400);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
        throw new RuntimeError('tag contains invalid characters', 400);
    }
    return value;
}

function normalizeImageRef(imageRef) {
    const value = String(imageRef || '').trim();
    if (!value) {
        throw new RuntimeError('image_ref is required', 400);
    }
    if (value.includes('\0') || /\s/.test(value)) {
        throw new RuntimeError('image_ref contains invalid characters', 400);
    }
    if (value.length > 512) {
        throw new RuntimeError('image_ref is too long', 400);
    }
    return value;
}

async function listAgentBoxImageCatalog() {
    const agents = await db.select().from(schema.agents);
    // Hide agents that don't support gateway mode yet
    const HIDDEN_AGENTS = new Set(['cursor', 'amp', 'commandcode', 'minimax-cli']);
    const visibleAgents = agents.filter((a) => !HIDDEN_AGENTS.has(a.id));
    const versions = await db.select().from(schema.agentBoxImages).orderBy(desc(schema.agentBoxImages.createdAt));
    const versionsByAgent = new Map();
    for (const row of versions) {
        const list = versionsByAgent.get(row.agentId) || [];
        list.push(formatVersionRow(row));
        versionsByAgent.set(row.agentId, list);
    }

    const builds = await db.select().from(schema.agentImageBuilds)
        .orderBy(desc(schema.agentImageBuilds.createdAt));
    const latestBuildByAgent = new Map();
    for (const row of builds) {
        if (!latestBuildByAgent.has(row.agentId)) {
            latestBuildByAgent.set(row.agentId, row);
        }
    }

    return visibleAgents.map((agent) => {
        const catalog = getCatalogEntry(agent.id);
        const agentVersions = versionsByAgent.get(agent.id) || [];
        const activeVersion = agentVersions.find((entry) => entry.is_active) || null;
        const buildable = isAgentBoxBuildable(agent.id);
        const latestBuild = latestBuildByAgent.get(agent.id);
        const buildState = latestBuild ? latestBuild.state : null;
        return {
            agent_id: agent.id,
            agent_name: agent.name,
            buildable,
            build_skip_reason: catalog?.buildable === false ? (catalog.reason || 'not buildable') : null,
            suggested_image_ref: buildable ? buildDefaultImageRef(agent.id, 'latest') : null,
            default_image_ref: buildable ? resolveAgentBoxImageDefault(agent.id) : null,
            active_version: activeVersion,
            versions: agentVersions,
            build_state: buildState,
            latest_build: latestBuild ? formatBuildRow(latestBuild) : null,
        };
    });
}

async function getActiveImageRef(agentId) {
    if (!agentId) return null;
    const rows = await db.select().from(schema.agentBoxImages)
        .where(and(
            eq(schema.agentBoxImages.agentId, agentId),
            eq(schema.agentBoxImages.isActive, true),
            eq(schema.agentBoxImages.status, 'ready'),
        ));
    return rows[0]?.imageRef || null;
}

async function registerVersion({
    agentId,
    tag,
    imageRef,
    digest,
    notes,
    builtAt,
    createdBy,
    setActive = false,
}) {
    const agentRows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
    if (agentRows.length === 0) {
        throw new RuntimeError('Agent not found', 404);
    }
    if (!isAgentBoxBuildable(agentId)) {
        throw new RuntimeError('This agent does not support boxlite image builds', 400);
    }

    const normalizedTag = normalizeTag(tag);
    const resolvedImageRef = normalizeImageRef(imageRef || buildDefaultImageRef(agentId, normalizedTag));

    const now = Date.now();
    const id = `img_${crypto.randomBytes(6).toString('hex')}`;
    const payload = {
        id,
        agentId,
        imageRef: resolvedImageRef,
        tag: normalizedTag,
        digest: digest?.trim() || null,
        status: 'ready',
        isActive: false,
        builtAt: Number.isFinite(Number(builtAt)) ? Number(builtAt) : now,
        notes: notes?.trim() || null,
        createdBy: createdBy || null,
        createdAt: now,
    };

    try {
        await db.insert(schema.agentBoxImages).values(payload);
    } catch (err) {
        if (/UNIQUE constraint failed/i.test(String(err))) {
            throw new RuntimeError(`Version tag "${normalizedTag}" already exists for this agent`, 409);
        }
        throw err;
    }

    if (setActive) {
        await activateVersion(id, createdBy);
    }

    const rows = await db.select().from(schema.agentBoxImages).where(eq(schema.agentBoxImages.id, id));
    return formatVersionRow(rows[0]);
}

async function activateVersion(versionId, actorId = null) {
    const rows = await db.select().from(schema.agentBoxImages).where(eq(schema.agentBoxImages.id, versionId));
    if (rows.length === 0) {
        throw new RuntimeError('Image version not found', 404);
    }

    await db.update(schema.agentBoxImages)
        .set({ isActive: false })
        .where(eq(schema.agentBoxImages.agentId, rows[0].agentId));

    await db.update(schema.agentBoxImages)
        .set({
            isActive: true,
            status: 'ready',
        })
        .where(eq(schema.agentBoxImages.id, versionId));

    const updated = await db.select().from(schema.agentBoxImages).where(eq(schema.agentBoxImages.id, versionId));
    return formatVersionRow(updated[0]);
}

async function deprecateVersion(versionId) {
    const rows = await db.select().from(schema.agentBoxImages).where(eq(schema.agentBoxImages.id, versionId));
    if (rows.length === 0) {
        throw new RuntimeError('Image version not found', 404);
    }
    const row = rows[0];
    await db.update(schema.agentBoxImages)
        .set({
            status: 'deprecated',
            isActive: false,
        })
        .where(eq(schema.agentBoxImages.id, versionId));
    const updated = await db.select().from(schema.agentBoxImages).where(eq(schema.agentBoxImages.id, versionId));
    return formatVersionRow(updated[0]);
}

// ── Build pipeline ──

function generateTag() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

async function resolveUniqueTag(agentId, baseTag) {
    const existing = await db.select({ tag: schema.agentBoxImages.tag })
        .from(schema.agentBoxImages)
        .where(eq(schema.agentBoxImages.agentId, agentId));
    const existingTags = new Set(existing.map((r) => r.tag));
    if (!existingTags.has(baseTag)) return baseTag;
    for (let i = 2; i < 100; i += 1) {
        if (!existingTags.has(`${baseTag}-${i}`)) return `${baseTag}-${i}`;
    }
    return `${baseTag}-${Date.now()}`;
}

function renderAgentDockerfile(agentId) {
    const baseImage = resolveBoxBaseImage();
    const installCmd = getAgentBoxInstallCommand(agentId);
    if (!installCmd) throw new RuntimeError(`No install command for agent "${agentId}"`, 400);

    return `# syntax=docker/dockerfile:1.7
ARG BASE_IMAGE=${baseImage}
FROM \${BASE_IMAGE}

ENV PATH="/usr/local/bin:/root/.local/bin:/root/.cargo/bin:\${PATH}" HOME="/root" \
    KIMI_CODE_NO_AUTO_UPDATE=1 \
    DISABLE_UPDATES=1 \
    FACTORY_DROID_AUTO_UPDATE_ENABLED=false \
    OPENCLAW_NO_AUTO_UPDATE=1 \
    npm_config_registry=https://registry.npmmirror.com \
    PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN set -eux; \\
  echo ">>> ${agentId}" && \\
  ${installCmd}

RUN rm -rf /root/.npm /root/.cache /tmp/* /var/tmp/* 2>/dev/null; true \\
  && find /usr/lib/node_modules -path "*/prebuilds/win32-*" -prune -exec rm -rf {} + 2>/dev/null || true \\
  && find /usr/lib/node_modules -path "*/prebuilds/darwin-*" -prune -exec rm -rf {} + 2>/dev/null || true \\
  && find /usr/lib/node_modules -name "*.pdb" -delete 2>/dev/null || true \\
  && find /usr/lib/node_modules -maxdepth 4 -type d -name '.*-*' -exec rm -rf {} + 2>/dev/null || true \\
  && mkdir -p /root/.config/opencode /root/.qwen \\
  && echo '{"autoupdate":false}' > /root/.config/opencode/opencode.json \\
  && echo '{"general":{"enableAutoUpdate":false}}' > /root/.qwen/settings.json

WORKDIR /workspace
`;
}

let agentBuildLoopRunning = false;

async function processAgentBuildQueue() {
    if (agentBuildLoopRunning) return;
    agentBuildLoopRunning = true;
    try {
        const { globalSemaphore } = require('./CustomImageService');
        await globalSemaphore.acquire();
        const queued = await db.select().from(schema.agentImageBuilds)
            .where(eq(schema.agentImageBuilds.state, 'queued'))
            .orderBy(schema.agentImageBuilds.createdAt)
            .limit(1);
        if (queued.length === 0) {
            globalSemaphore.release();
            return;
        }
        const build = queued[0];
        await db.update(schema.agentImageBuilds)
            .set({ state: 'building', startedAt: Date.now() })
            .where(eq(schema.agentImageBuilds.id, build.id));
        setImmediate(() => executeAgentBuild(build).finally(() => {
            globalSemaphore.release();
        }));
    } catch {
        try { const { globalSemaphore } = require('./CustomImageService'); globalSemaphore.release(); } catch (_) {}
    } finally {
        agentBuildLoopRunning = false;
    }
}

async function executeAgentBuild(build) {
    const buildId = build.id;
    const agentId = build.agentId;
    let logsRef = null;
    let outputTail = '';
    const appendTail = (chunk) => { outputTail = (outputTail + chunk.toString()).slice(-2000); };

    try {
        const dockerfile = renderAgentDockerfile(agentId);
        const logFile = path.join(BUILD_LOG_DIR, `${buildId}.log`);
        const contextDir = path.join(BUILD_LOG_DIR, buildId);
        const dockerfilePath = path.join(contextDir, 'Dockerfile');
        logsRef = path.relative(BUILD_LOG_DIR, logFile);

        fs.mkdirSync(contextDir, { recursive: true });
        fs.writeFileSync(dockerfilePath, dockerfile);

        const imageRef = build.imageRef;
        const buildCmd = `docker build -t ${imageRef} -f ${dockerfilePath} ${contextDir}`;
        const pushCmd = `docker push ${imageRef}`;

        const logStream = fs.createWriteStream(logFile);
        logStream.write(`=== Build started at ${new Date().toISOString()} ===\n`);
        logStream.write(`=== Agent: ${agentId} ===\n`);
        logStream.write(`=== Image: ${imageRef} ===\n\n`);
        logStream.write(`=== Dockerfile ===\n${dockerfile}\n\n=== Build output ===\n`);

        await new Promise((resolve, reject) => {
            const proc = exec(buildCmd, { timeout: BUILD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
            proc.stdout.on('data', appendTail);
            proc.stderr.on('data', appendTail);
            proc.stdout.pipe(logStream);
            proc.stderr.pipe(logStream);
            proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker build exited with code ${code}`)));
            proc.on('error', reject);
        });
        await new Promise((resolve, reject) => {
            const proc = exec(pushCmd, { timeout: BUILD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
            proc.stdout.on('data', appendTail);
            proc.stderr.on('data', appendTail);
            proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker push exited with code ${code}`)));
            proc.on('error', reject);
        });
        logStream.end();

        const version = await registerVersion({
            agentId,
            tag: build.tag,
            imageRef,
            notes: build.notes || `Built from UI`,
            builtAt: Date.now(),
            createdBy: build.createdBy,
        });

        await db.update(schema.agentImageBuilds)
            .set({ state: 'ready', logsRef, versionId: version.id, finishedAt: Date.now() })
            .where(eq(schema.agentImageBuilds.id, buildId));

        try { fs.rmSync(contextDir, { recursive: true }); } catch { /* ok */ }
    } catch (err) {
        const tail = outputTail.trim();
        const failureReason = (tail ? `${err.message}\n${tail}` : err.message).slice(-500);
        try {
            await db.update(schema.agentImageBuilds)
                .set({ state: 'failed', logsRef, failureReason, finishedAt: Date.now() })
                .where(eq(schema.agentImageBuilds.id, buildId));
        } catch { /* best effort */ }
        try { fs.rmSync(path.join(BUILD_LOG_DIR, buildId), { recursive: true }); } catch { /* ok */ }
    }
    processAgentBuildQueue().catch(() => {});
}

async function buildImage({ agentId, tag, notes, createdBy }) {
    if (!isAgentBoxBuildable(agentId)) {
        throw new RuntimeError('This agent does not support image builds', 400);
    }
    const versionTag = tag ? normalizeTag(tag) : await resolveUniqueTag(agentId, generateTag());
    const imageRef = buildDefaultImageRef(agentId, versionTag);
    const buildId = `abld_${crypto.randomBytes(6).toString('hex')}`;
    const now = Date.now();

    await db.insert(schema.agentImageBuilds).values({
        id: buildId,
        agentId,
        state: 'queued',
        imageRef,
        tag: versionTag,
        notes: notes?.trim() || null,
        createdBy: createdBy || null,
        createdAt: now,
    });

    setImmediate(() => processAgentBuildQueue().catch(() => {}));

    const rows = await db.select().from(schema.agentImageBuilds).where(eq(schema.agentImageBuilds.id, buildId));
    return formatBuildRow(rows[0]);
}

function formatBuildRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        agent_id: row.agentId,
        state: row.state,
        image_ref: row.imageRef || null,
        tag: row.tag || null,
        logs_ref: row.logsRef || null,
        failure_reason: row.failureReason || null,
        version_id: row.versionId || null,
        notes: row.notes || null,
        started_at: row.startedAt || null,
        finished_at: row.finishedAt || null,
        created_by: row.createdBy || null,
        created_at: row.createdAt,
    };
}

async function getBuilds(agentId) {
    const rows = await db.select().from(schema.agentImageBuilds)
        .where(eq(schema.agentImageBuilds.agentId, agentId))
        .orderBy(desc(schema.agentImageBuilds.createdAt));
    return rows.map(formatBuildRow);
}

async function getBuildLogs(buildId) {
    const rows = await db.select().from(schema.agentImageBuilds)
        .where(eq(schema.agentImageBuilds.id, buildId));
    if (rows.length === 0) throw new RuntimeError('Build not found', 404);
    const build = rows[0];
    if (!build.logsRef) return { content: '', build: formatBuildRow(build) };
    const logFile = path.join(BUILD_LOG_DIR, build.logsRef);
    let content = '';
    try { content = fs.readFileSync(logFile, 'utf-8'); } catch { /* file may not exist */ }
    return { content, build: formatBuildRow(build) };
}

async function retryBuild(buildId, actorId) {
    const rows = await db.select().from(schema.agentImageBuilds)
        .where(eq(schema.agentImageBuilds.id, buildId));
    if (rows.length === 0) throw new RuntimeError('Build not found', 404);
    const build = rows[0];
    if (build.state !== 'failed') {
        throw new RuntimeError('Only failed builds can be retried', 400);
    }
    return buildImage({
        agentId: build.agentId,
        tag: build.tag,
        notes: build.notes,
        createdBy: actorId || build.createdBy,
    });
}

async function deleteBuild(buildId) {
    const rows = await db.select().from(schema.agentImageBuilds)
        .where(eq(schema.agentImageBuilds.id, buildId));
    if (rows.length === 0) throw new RuntimeError('Build not found', 404);
    const build = rows[0];
    if (build.state === 'building' || build.state === 'queued') {
        throw new RuntimeError('Cannot delete a build that is queued or in progress', 400);
    }
    if (build.logsRef) {
        try { fs.unlinkSync(path.join(BUILD_LOG_DIR, build.logsRef)); } catch { /* ok */ }
    }
    await db.delete(schema.agentImageBuilds).where(eq(schema.agentImageBuilds.id, buildId));
    return { ok: true };
}

async function deleteVersion(versionId) {
    const rows = await db.select().from(schema.agentBoxImages).where(eq(schema.agentBoxImages.id, versionId));
    if (rows.length === 0) throw new RuntimeError('Image version not found', 404);
    const row = rows[0];
    if (row.isActive) {
        throw new RuntimeError('Cannot delete the active version. Deprecate it first.', 409);
    }
    const { promisify } = require('util');
    const execAsyncFn = promisify(require('child_process').exec);
    await execAsyncFn(`docker rmi ${row.imageRef} 2>/dev/null`, { timeout: 15000 }).catch(() => {});
    await db.delete(schema.agentBoxImages).where(eq(schema.agentBoxImages.id, versionId));
    return { ok: true };
}

module.exports = {
    buildDefaultImageRef,
    formatVersionRow,
    getActiveImageRef,
    isAgentBoxBuildable,
    listAgentBoxImageCatalog,
    registerVersion,
    activateVersion,
    deprecateVersion,
    deleteVersion,
    buildImage,
    getBuilds,
    getBuildLogs,
    retryBuild,
    deleteBuild,
    resolveBoxBaseImage,
};
