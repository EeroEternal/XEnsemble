const crypto = require('crypto');
const { eq, and } = require('drizzle-orm');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { getRuntime } = require('./registry');
const { RuntimeError } = require('./interfaces');
const { singleflight } = require('./singleflight');
const { recordEvent } = require('../events/recordEvent');
const { resolveBoxImage } = require('./agentBoxImages');
const { resolveRuntimeProvider } = require('../config/runtimeProvider');
const workspace = require('../workspace');

const PROVIDER = resolveRuntimeProvider();

const DEFAULT_DISK_SIZE_GB = Number(process.env.XENSEMBLE_DEFAULT_DISK_SIZE_GB) || 2;

function resolveVmResources(opts) {
    const resources = {};
    if (opts.vmResources) {
        const parsed = typeof opts.vmResources === 'string' ? JSON.parse(opts.vmResources) : opts.vmResources;
        if (parsed?.disk_size_gb) resources.disk_size_gb = parsed.disk_size_gb;
        if (parsed?.cpus) resources.cpus = parsed.cpus;
        if (parsed?.memory_mib) resources.memory_mib = parsed.memory_mib;
    }
    if (!resources.disk_size_gb) {
        resources.disk_size_gb = DEFAULT_DISK_SIZE_GB;
    }
    if (opts.componentDiskSizeMb) {
        resources.disk_size_gb += Math.ceil(opts.componentDiskSizeMb / 1024);
    }
    return Object.keys(resources).length > 0 ? resources : null;
}

// Short-TTL cache for attach-only ensureProjectRuntime results.
// Keyed by runtimeId; avoids a DB SELECT on every git/FS API call.
const RUNTIME_CACHE_TTL_MS = 5_000;
const runtimeCache = new Map();

function getCachedRuntime(runtimeId) {
    const cached = runtimeCache.get(runtimeId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
    }
    if (cached) runtimeCache.delete(runtimeId);
    return null;
}

function setCachedRuntime(runtimeId, value) {
    runtimeCache.set(runtimeId, {
        value,
        expiresAt: Date.now() + RUNTIME_CACHE_TTL_MS,
    });
}

function invalidateRuntimeCache(runtimeId) {
    if (runtimeId) {
        runtimeCache.delete(runtimeId);
    } else {
        runtimeCache.clear();
    }
}

function parseRuntimeSpecs(raw) {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function runtimeKey(projectId, runtimeId) {
    return `${projectId}:${runtimeId || 'default'}`;
}

function runtimeFlightKey(projectId, runtimeId, opts = {}) {
    // When runtimeId is null (new runtime creation), include agentId in the key
    // to prevent coalescing concurrent provisioning for different agents.
    const base = runtimeId
        ? runtimeKey(projectId, runtimeId)
        : `${projectId}:${opts.agentId || 'default'}`;
    // Do not coalesce agent provisioning with passive attach (git status polls, workspace FS, …).
    if (opts.agentId || opts.forceRecreate || opts.image) return `${base}:provision`;
    return `${base}:attach`;
}

function isAttachOnlyRuntimeCall(opts = {}) {
    return !opts.agentId
        && !opts.forceRecreate
        && !opts.image
        && !opts.baseSnapshotId
        && !opts.checkpointId;
}

/**
 * 确保 project 有 default runtime 记录并完成 provider provision / restore。
 * opts.baseSnapshotId / opts.checkpointId 预留给云 provider 恢复 repo snapshot 或 session checkpoint。
 * @returns {Promise<{ runtime: object, workspacePath: string, recoverable: boolean }>}
 */
async function ensureProjectRuntime(project, opts = {}) {
    let targetRuntimeId = opts.runtimeId;

    // Active caller with agentId: always create a new runtime for each session.
    // This ensures each session gets its own VM + worktree, even for the same agent.
    if (!targetRuntimeId && opts.agentId) {
        const created = await getOrCreateRuntimeForAgent(project, opts.agentId);
        targetRuntimeId = created.runtime.id;
    }

    // Passive caller fallback: use defaultRuntimeId
    if (!targetRuntimeId) {
        targetRuntimeId = project.defaultRuntimeId;
    }

    // Passive callers only need the persisted runtime row; re-entering ensureReady races with session start.
    if (isAttachOnlyRuntimeCall(opts) && targetRuntimeId) {
        // Check the short-TTL cache first to avoid a DB SELECT on every git/FS call.
        const cached = getCachedRuntime(targetRuntimeId);
        if (cached) return cached;

        const rows = await db.select().from(schema.runtimes)
            .where(and(
                eq(schema.runtimes.id, targetRuntimeId),
                eq(schema.runtimes.projectId, project.id),
            ));
        const runtimeRow = rows[0];
        // Prefer project.serverPath: it is corrected to the guest workspace path
        // (e.g. /workspace) during provisioning, whereas runtimes.endpoint retains
        // the stale HOST path written at runtime creation. Using the host path as
        // the spawn working_dir makes the sandbox chdir fail (blink 500
        // "failed to spawn command in sandbox").
        const workspacePath = project.serverPath || runtimeRow?.endpoint;
        if (runtimeRow?.status === 'ready' && runtimeRow.runtimeRef && workspacePath) {
            const result = {
                runtime: runtimeRow,
                workspacePath,
                recoverable: false,
            };
            setCachedRuntime(targetRuntimeId, result);
            return result;
        }
    }

    return singleflight(runtimeFlightKey(project.id, targetRuntimeId, opts), async () => {
        // Invalidate the cache since we're about to (re)provision.
        if (targetRuntimeId) invalidateRuntimeCache(targetRuntimeId);
        const rt = getRuntime();

        let runtimeRow = null;
        if (targetRuntimeId) {
            const rows = await db.select().from(schema.runtimes)
                .where(and(
                    eq(schema.runtimes.id, targetRuntimeId),
                    eq(schema.runtimes.projectId, project.id),
                ));
            if (rows.length === 0) {
                throw new RuntimeError('Runtime not found for this project', 404);
            }
            runtimeRow = rows[0];
        } else {
            const created = await getOrCreateDefaultRuntime(project);
            runtimeRow = created.runtime;
        }

        const storedSpecs = parseRuntimeSpecs(runtimeRow.specs);
        const isBoxLite = PROVIDER === 'boxlite';
        let image = null;
        if (isBoxLite) {
            // Keep the provisioned agent image for attach-only callers (git status, workspace FS, …).
            // Without this, resolveBoxImage() falls back to box-base and ensureReady tears down a live agent sandbox.
            if (opts.agentId || opts.image) {
                image = await resolveBoxImage({
                    agentId: opts.agentId,
                    image: opts.image,
                });
            } else if (storedSpecs.image) {
                image = storedSpecs.image;
            } else {
                image = await resolveBoxImage({});
            }

            let componentDiskSizeMb = 0;
            if (opts.customImageId) {
                const { getComponentDiskSizeMb } = require('./customImageCatalog');
                const imgRows = await db.select().from(schema.customImages)
                    .where(eq(schema.customImages.id, opts.customImageId));
                if (imgRows.length > 0) {
                    const components = typeof imgRows[0].components === 'string'
                        ? JSON.parse(imgRows[0].components)
                        : imgRows[0].components || [];
                    for (const c of components) {
                        componentDiskSizeMb += getComponentDiskSizeMb(c.component_id, c.version);
                    }
                }
            }

            opts.componentDiskSizeMb = componentDiskSizeMb;
        }

        const provision = await rt.provider.ensureReady(project, {
            runtimeId: runtimeRow.id,
            forceRecreate: !!opts.forceRecreate,
            ...(isBoxLite ? {
                agentId: opts.agentId,
                image,
                storedImage: storedSpecs.image || null,
                storedMount: storedSpecs.workspace_mount || null,
                resources: resolveVmResources({
                    vmResources: opts.agentVmResources || null,
                    componentDiskSizeMb: opts.componentDiskSizeMb || 0,
                }),
            } : {}),
            baseSnapshotId: opts.baseSnapshotId,
            checkpointId: opts.checkpointId,
        });
        const workspacePath = provision.workspacePath;
        const now = Date.now();
        const nextSpecs = { ...storedSpecs };
        if (isBoxLite && provision.hostWorkspacePath) {
            nextSpecs.host_workspace_path = provision.hostWorkspacePath;
        }
        if (isBoxLite && (provision.image || image)) {
            nextSpecs.image = provision.image || image;
        }

        if (isBoxLite && provision.mountKey) {
            nextSpecs.mount_key = provision.mountKey;
            nextSpecs.workspace_mount = provision.mountKey;
        }
        const specsJson = Object.keys(nextSpecs).length > 0 ? JSON.stringify(nextSpecs) : runtimeRow.specs;

        if (
            runtimeRow.runtimeRef !== provision.runtimeRef
            || runtimeRow.specs !== specsJson
            || runtimeRow.endpoint !== provision.workspacePath
        ) {
            await db.update(schema.runtimes).set({
                runtimeRef: provision.runtimeRef,
                specs: specsJson,
                status: 'ready',
                endpoint: provision.workspacePath,
                updatedAt: now,
            }).where(eq(schema.runtimes.id, runtimeRow.id));
            runtimeRow = {
                ...runtimeRow,
                runtimeRef: provision.runtimeRef,
                specs: specsJson,
                status: 'ready',
                endpoint: provision.workspacePath,
            };
        }

        if (project.serverPath !== workspacePath) {
            await db.update(schema.projects).set({ serverPath: workspacePath })
                .where(eq(schema.projects.id, project.id));
            // Invalidate project cache so the next getProjectForUser sees the updated serverPath.
            try {
                const { invalidateProjectCache } = require('../projects/getProjectForUser');
                invalidateProjectCache(project.id);
            } catch { /* circular dep guard */ }
        }

        const attach = await rt.provider.attach(provision.runtimeRef);
        const hostWorkspacePath = attach?.hostWorkspacePath || (() => {
            try {
                const specs = JSON.parse(runtimeRow.specs || '{}');
                return specs.host_workspace_path || null;
            } catch { return null; }
        })();
        return {
            runtime: runtimeRow,
            workspacePath,
            hostWorkspacePath,
            recoverable: Boolean(attach?.recoverable),
        };
    });
}

async function getOrCreateDefaultRuntime(project) {
    if (project.defaultRuntimeId) {
        const rows = await db.select().from(schema.runtimes)
            .where(eq(schema.runtimes.id, project.defaultRuntimeId));
        if (rows.length > 0) {
            return {
                runtime: rows[0],
                workspacePath: rows[0].endpoint || project.serverPath,
                recoverable: false,
            };
        }
    }

    // Reuse an existing default runtime row for this project if one is already
    // recorded (avoids accumulating orphan runtimes when defaultRuntimeId drifted).
    const existing = await db.select().from(schema.runtimes)
        .where(and(
            eq(schema.runtimes.projectId, project.id),
            eq(schema.runtimes.role, 'default'),
        ));
    if (existing.length > 0) {
        const row = existing[0];
        if (project.defaultRuntimeId !== row.id) {
            await db.update(schema.projects).set({ defaultRuntimeId: row.id })
                .where(eq(schema.projects.id, project.id));
        }
        return {
            runtime: row,
            workspacePath: row.endpoint || project.serverPath,
            recoverable: false,
        };
    }

    // Create the default runtime as a metadata-only row. We deliberately do NOT
    // provision a VM here: the caller (ensureProjectRuntime) will run ensureReady
    // once with the correct agent image. Provisioning here without an agentId would
    // pin the runtime to box-base and trigger a delete+rebuild (losing state) on the
    // first agent session.
    const runtimeId = `rt_${crypto.randomBytes(6).toString('hex')}`;
    const workspacePath = workspace.createProjectDirectory(project.userId, project.id);
    const now = Date.now();

    await db.insert(schema.runtimes).values({
        id: runtimeId,
        projectId: project.id,
        provider: PROVIDER,
        runtimeRef: PROVIDER === 'boxlite' ? runtimeId : 'local',
        role: 'default',
        status: 'ready',
        endpoint: workspacePath,
        createdAt: now,
        updatedAt: now,
    });

    await db.update(schema.projects).set({
        defaultRuntimeId: runtimeId,
        serverPath: workspacePath,
    }).where(eq(schema.projects.id, project.id));

    await recordEvent({
        userId: project.userId,
        projectId: project.id,
        subjectType: 'runtime',
        subjectId: runtimeId,
        type: 'ready',
        data: { provider: PROVIDER, role: 'default' },
    });

    const runtimeRow = {
        id: runtimeId,
        projectId: project.id,
        provider: PROVIDER,
        runtimeRef: PROVIDER === 'boxlite' ? runtimeId : 'local',
        role: 'default',
        status: 'ready',
        endpoint: workspacePath,
        specs: null,
    };

    return {
        runtime: runtimeRow,
        workspacePath,
        recoverable: false,
    };
}

async function getOrCreateRuntimeForAgent(project, agentId) {
    // Always create a new runtime row — each session gets its own VM + worktree.
    // The unique constraint on (project_id, agent_id) has been removed to allow
    // multiple runtimes for the same agent in the same project.
    const runtimeId = `rt_${crypto.randomBytes(6).toString('hex')}`;
    const workspacePath = workspace.createProjectDirectory(project.userId, project.id);
    const now = Date.now();

    await db.insert(schema.runtimes).values({
        id: runtimeId,
        projectId: project.id,
        agentId,
        provider: PROVIDER,
        runtimeRef: PROVIDER === 'boxlite' ? runtimeId : 'local',
        role: 'agent',
        status: 'ready',
        endpoint: workspacePath,
        createdAt: now,
        updatedAt: now,
    });

    return {
        runtime: { id: runtimeId, agentId, projectId: project.id, runtimeRef: PROVIDER === 'boxlite' ? runtimeId : 'local', endpoint: workspacePath, status: 'ready' },
        workspacePath,
        recoverable: false,
    };
}

function formatRuntime(row) {
    if (!row) return null;
    return {
        id: row.id,
        project_id: row.projectId,
        agent_id: row.agentId || null,
        provider: row.provider,
        runtime_ref: row.runtimeRef,
        role: row.role,
        status: row.status,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
    };
}

module.exports = {
    ensureProjectRuntime,
    getOrCreateDefaultRuntime,
    getOrCreateRuntimeForAgent,
    formatRuntime,
    invalidateRuntimeCache,
};
