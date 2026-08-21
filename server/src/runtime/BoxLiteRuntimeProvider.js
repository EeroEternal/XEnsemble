const { RuntimeProvider, RuntimeError } = require('./interfaces');
const BoxLiteClient = require('./BoxLiteClient');
const { resolveBoxImage } = require('./agentBoxImages');
const { resolveBoxliteSessionNetwork } = require('./boxliteNetwork');
const BoxLiteExecAdapter = require('./BoxLiteExecAdapter');
const workspace = require('../workspace');
const { BoxLiteStreamHandle } = BoxLiteExecAdapter;
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

function buildWorkspaceMountKey(hostPath, guestPath) {
    return `${hostPath}=>${guestPath}`;
}

function resolveAgentProbeCommand(agentId) {
    if (!agentId) return null;
    const { DEFAULT_AGENTS } = require('../agents/defaultAgents');
    const agent = DEFAULT_AGENTS.find((entry) => entry.id === agentId);
    return agent?.cmd || null;
}

async function probeAgentCommand(client, sessionName, cmd, workspacePath) {
    if (!cmd) return true;
    const result = await client.execForResult(
        sessionName,
        'sh',
        ['-lc', `PATH="$HOME/.local/bin:/usr/local/bin:$PATH" command -v ${JSON.stringify(cmd)} >/dev/null 2>&1`],
        {},
        workspacePath || '/',
    );
    return result.exitCode === 0;
}

class BoxLiteRuntimeProvider extends RuntimeProvider {
    constructor() {
        super();
        this.client = new BoxLiteClient();
        this._hostWorkspacePaths = new Map();
    }

    workspacePath() {
        return process.env.XENSEMBLE_WORKSPACE_PATH
            || process.env.WORKSPACE_PATH
            || '/workspace';
    }

    hostWorkspacePath(project) {
        return workspace.projectDir(project.userId, project.id);
    }

    buildWorkspaceVolume(project, worktreePath) {
        const guestPath = this.workspacePath();
        const hostPath = worktreePath || this.hostWorkspacePath(project);
        const gitVolume = worktreePath ? {
            host_path: path.join(this.hostWorkspacePath(project), '.git'),
            guest_path: '/workspace.git',
            read_only: true,
        } : null;
        return {
            host_path: hostPath,
            guest_path: guestPath,
            read_only: false,
            mountKey: buildWorkspaceMountKey(hostPath, guestPath) + (gitVolume ? `+${gitVolume.guest_path}` : ''),
            gitVolume,
        };
    }

    async _ensureWorktree(project, runtimeId) {
        const mainDir = this.hostWorkspacePath(project);
        const gitDir = path.join(mainDir, '.git');
        if (!fs.existsSync(gitDir)) return null;

        const wtDir = workspace.worktreeDir(project.userId, project.id, runtimeId);
        if (fs.existsSync(path.join(wtDir, '.git'))) return wtDir;

        try {
            fs.mkdirSync(path.dirname(wtDir), { recursive: true });
            await execFileAsync('git', ['-C', mainDir, 'worktree', 'add', '--detach', wtDir]);
            // Do NOT rewrite the .git pointer file — it must remain as the host
            // path so that host-side git operations (commit, push, status, …)
            // work correctly. VM-side git is handled by mounting the main .git
            // directory at /workspace.git and having the VM pass --git-dir.
            return wtDir;
            return wtDir;
        } catch {
            return null;
        }
    }

    async _removeWorktree(project, runtimeId) {
        const mainDir = this.hostWorkspacePath(project);
        const wtDir = workspace.worktreeDir(project.userId, project.id, runtimeId);
        if (!fs.existsSync(wtDir)) return;

        try {
            await execFileAsync('git', ['-C', mainDir, 'worktree', 'remove', '--force', wtDir]);
        } catch {
            try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }

        try {
            const wtRoot = path.dirname(wtDir);
            if (fs.existsSync(wtRoot) && fs.readdirSync(wtRoot).length === 0) {
                fs.rmdirSync(wtRoot);
            }
        } catch { /* best-effort */ }
    }

    async ensureWorkspacePath(runtimeRef, workspacePath) {
        const MAX_RETRIES = 3;
        let lastErr = null;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const result = await this.client.execForResult(
                    runtimeRef,
                    'sh',
                    ['-lc', `mkdir -p ${JSON.stringify(workspacePath)}`],
                    {},
                    '/'
                );
                if (result.exitCode !== 0) {
                    throw new RuntimeError(`BoxLite ensureReady failed: create workspace path failed with exit code ${result.exitCode}`, 502);
                }
                return;
            } catch (e) {
                lastErr = e;
                if (attempt < MAX_RETRIES && /spawn failed/i.test(e.message)) {
                    await new Promise((r) => setTimeout(r, attempt * 1000));
                    continue;
                }
                throw e;
            }
        }
        throw lastErr;
    }

    /**
     * Run the post-boot init execs for a freshly-opened boxlite session.
     *
     * boxlite execs (ensureWorkspacePath -> optional agent probe -> best-effort
     * cache cleanup) are run SEQUENTIALLY. Concurrent exec calls against a
     * just-booted VM trigger a guest zygote race
     * ("received unexpected message: InitReady, expected: IntermediateReady(0)")
     * that surfaces upstream as "failed to spawn command in sandbox" (HTTP 500).
     *
     * ensureAgentBootstrap is host-side filesystem only (no boxlite exec) and is
     * overlapped with the serialized execs to avoid adding latency.
     *
     * @returns {Promise<{probeOk: boolean, initError: Error|null}>}
     */
    async _initFreshSessionExecs(name, { probeCmd, guestWorkspacePath, project, hostWorkspacePath, withBootstrap }) {
        let bootstrapError = null;
        const bootstrapPromise = withBootstrap
            ? (async () => {
                try {
                    const { ensureAgentBootstrap } = require('../workspace/agentBootstrap');
                    await ensureAgentBootstrap(project, hostWorkspacePath);
                } catch (e) { bootstrapError = e; }
            })()
            : Promise.resolve();

        let initError = null;
        try {
            await this.ensureWorkspacePath(name, guestWorkspacePath);
        } catch (e) {
            initError = e;
        }

        let probeOk = true;
        if (probeCmd && !initError) {
            probeOk = await probeAgentCommand(this.client, name, probeCmd, guestWorkspacePath)
                .catch(() => false);
        }

        try {
            await this.client.execForResult(name, 'sh', ['-c',
                'for d in /root/.npm/_cacache /root/.cache /tmp; do rm -rf "$d"/* 2>/dev/null || true; done',
            ]);
        } catch (_) {
            // Best-effort: cache cleanup failure does not block the session.
        }

        // Fix git worktree .git pointer for VM access: the worktree's .git file
        // points to a host path that doesn't exist inside the VM. Create a
        // symlink so git inside the VM can resolve the worktree metadata.
        if (hostWorkspacePath && guestWorkspacePath) {
            try {
                await this.client.execForResult(name, 'sh', ['-c',
                    `if [ -f "${guestWorkspacePath}/.git" ]; then ` +
                    `GITDIR=$(cat "${guestWorkspacePath}/.git" | sed 's/^gitdir: //'); ` +
                    `WTPATH=$(echo "$GITDIR" | sed 's|/[^/]*$||'); ` +
                    `if [ ! -d "$GITDIR" ] && [ -d /workspace.git ]; then ` +
                    `WTNAME=$(basename "$WTPATH"); ` +
                    `echo "gitdir: /workspace.git/worktrees/$WTNAME" > "${guestWorkspacePath}/.git"; ` +
                    `echo "/workspace/.git" > "/workspace.git/worktrees/$WTNAME/gitdir" 2>/dev/null || true; ` +
                    `fi; fi`,
                ]);
            } catch (_) {
                // Best-effort: if git fixup fails, host-side git still works.
            }
        }

        await bootstrapPromise;
        if (!initError && bootstrapError) initError = bootstrapError;
        return { probeOk, initError };
    }

    async ensureReady(project, opts = {}) {
        const runtimeId = opts && opts.runtimeId ? opts.runtimeId : null;
        const name = runtimeId || `p_${project.id}_${opts.agentId || 'default'}`;
        const image = await resolveBoxImage({
            agentId: opts.agentId,
            image: opts.image,
        });
        const warm = !!opts.warm;
        // For non-default runtimes, create a git worktree so each session
        // gets its own working tree (independent branch / uncommitted state).
        // Since each session gets its own runtimeId, the worktree is per-session.
        let worktreePath = null;
        if (runtimeId && project.defaultRuntimeId && runtimeId !== project.defaultRuntimeId) {
            worktreePath = await this._ensureWorktree(project, runtimeId);
        }
        const workspaceVolume = this.buildWorkspaceVolume(project, worktreePath);
        const { host_path: hostWorkspacePath, guest_path: guestWorkspacePath, mountKey } = workspaceVolume;
        workspace.createProjectDirectory(project.userId, project.id);
        const storedImage = opts.storedImage || null;
        const storedMount = opts.storedMount || null;
        const imageMismatch = storedImage !== image;
        const recreateForImage = imageMismatch && (opts.forceRecreate || opts.agentId);
        const needRecreate = recreateForImage || storedMount !== mountKey;
        if (needRecreate) {
            try {
                await this.client.deleteSession(name);
                await new Promise((r) => setTimeout(r, 300));
            } catch (_) {
                // Ignore — openSession will detect the stale session below.
            }
        }
        const openOptions = {
            volumes: [
                {
                    host_path: workspaceVolume.host_path,
                    guest_path: workspaceVolume.guest_path,
                    read_only: workspaceVolume.read_only,
                },
                ...(workspaceVolume.gitVolume ? [{
                    host_path: workspaceVolume.gitVolume.host_path,
                    guest_path: workspaceVolume.gitVolume.guest_path,
                    read_only: workspaceVolume.gitVolume.read_only,
                }] : []),
            ],
            network: resolveBoxliteSessionNetwork(opts.network),
            resources: {
                disk_size_gb: Number(process.env.BOXLITE_DISK_SIZE_GB || 20),
                // 大前端（如 xensemble 自身）在默认 4GB 沙箱里 vite build 会 OOM；默认给 6GB。
                memory_mib: Number(process.env.BOXLITE_MEMORY_MIB || 6144),
                cpus: Number(process.env.BOXLITE_CPUS || 4),
                ...(opts.resources || {}),
            },
        };
        const openSession = async () => {
            const TRANSIENT_RE = /mkdir.*memory|memory dir|resource busy|temporarily|try again/i;
            const MAX_ATTEMPTS = 4;
            let lastErr = null;
            let reused = false;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
                try {
                    await this.client.openSession(name, image, warm, openOptions);
                    return { reused: false };
                } catch (e) {
                    if (/already|exists/i.test(String(e))) {
                        // Session exists - check if it's actually healthy
                        let statusInfo = null;
                        try {
                            statusInfo = await this.client.getSessionStatus(name);
                        } catch (_) { /* status query failed - try openSession below */ }
                        if (statusInfo && statusInfo.running && statusInfo.status === 'Running') {
                            if (needRecreate) {
                                throw new RuntimeError(
                                    `BoxLite ensureReady failed: session "${name}" still exists after delete - cannot recreate with image ${image}`,
                                    502,
                                );
                            }
                            return { reused: true };
                        }
                        // VM is not Running or status unknown.
                        // Try openSession again - blink-server may resume a Stopped VM.
                        // Only delete+recreate if openSession still fails.
                        try {
                            await this.client.openSession(name, image, warm, openOptions);
                            return { reused: false };
                        } catch (e2) {
                            if (!/already|exists/i.test(String(e2))) {
                                throw new RuntimeError(`BoxLite ensureReady failed: ${e2.message}`, 502);
                            }
                        }
                        // openSession still says "already exists" - VM is stuck.
                        // Delete and recreate as last resort.
                        try { await this.client.deleteSession(name); } catch (_) {}
                        await new Promise((r) => setTimeout(r, 500));
                        try {
                            await this.client.openSession(name, image, warm, openOptions);
                            return { reused: false };
                        } catch (e3) {
                            if (!/already|exists/i.test(String(e3))) {
                                throw new RuntimeError(`BoxLite ensureReady failed: ${e3.message}`, 502);
                            }
                            throw new RuntimeError(
                                `BoxLite ensureReady failed: session "${name}" still exists after delete - cannot recreate`,
                                502,
                            );
                        }
                    }
                    if (/mkdir.*memory/i.test(String(e))) {
                        const info = await this.client.getSessionStatus(name);
                        if (info && info.running) return { reused: true };
                    }
                    lastErr = e;
                    if (attempt < MAX_ATTEMPTS && TRANSIENT_RE.test(String(e))) {
                        await new Promise((r) => setTimeout(r, attempt * 500));
                        continue;
                    }
                    if (TRANSIENT_RE.test(String(e)) && !/resource busy/i.test(String(e))) {
                        try { await this.client.deleteSession(name); } catch (_) {}
                        await new Promise((r) => setTimeout(r, 1000));
                        try {
                            await this.client.openSession(name, image, warm, openOptions);
                            return { reused: false };
                        } catch (e2) {
                            if (/already|exists/i.test(String(e2))) {
                                throw new RuntimeError(
                                    `BoxLite ensureReady failed: session "${name}" still exists after delete+recreate retry`,
                                    502,
                                );
                            }
                            lastErr = e2;
                        }
                    }
                    throw new RuntimeError(`BoxLite ensureReady failed: ${lastErr.message}`, 502);
                }
            }
        };
        const { reused } = await openSession();

        if (!reused) {
            const probeCmd = resolveAgentProbeCommand(opts.agentId);
            const withBootstrap = !!opts.agentId;

            // boxlite execs are run sequentially (see _initFreshSessionExecs) to
            // avoid the guest zygote race that occurs when multiple exec calls
            // hit a freshly-booted VM concurrently. ensureAgentBootstrap is
            // host-side FS only and is overlapped inside _initFreshSessionExecs.
            const { probeOk, initError } = await this._initFreshSessionExecs(
                name, { probeCmd, guestWorkspacePath, project, hostWorkspacePath, withBootstrap },
            );

            if (probeCmd && !probeOk) {
                await this.client.deleteSession(name);
                await openSession();
                // Re-run init execs on the recreated VM (a fresh VM usually
                // clears the transient race), then probe once more.
                const recreate = await this._initFreshSessionExecs(
                    name, { probeCmd: null, guestWorkspacePath, project, hostWorkspacePath, withBootstrap },
                );
                if (recreate.initError) throw recreate.initError;
                if (!(await probeAgentCommand(this.client, name, probeCmd, guestWorkspacePath))) {
                    throw new RuntimeError(
                        `BoxLite ensureReady failed: agent command "${probeCmd}" is missing from sandbox image ${image}`,
                        502,
                    );
                }
            } else if (initError) {
                throw initError;
            }
        }

        if (opts && (opts.checkpointId || opts.baseSnapshotId)) {
            const snap = opts.checkpointId || opts.baseSnapshotId;
            try {
                await this.client.restoreCheckpoint(name, snap);
            } catch (_) {
                // snapshot may not exist yet or first provision; continue
            }
        }
        return { runtimeRef: name, workspacePath: guestWorkspacePath, image, mountKey, hostWorkspacePath };
    }

    async attach(runtimeRef) {
        return { runtimeRef, recoverable: false, hostWorkspacePath: this._hostWorkspacePaths.get(runtimeRef) || null };
    }

    supportsHibernate() {
        return true;
    }

    async attachSession(sessionId, streamRef, options = {}) {
        const after = Number.isInteger(options.after) && options.after >= 0 ? options.after : 0;
        const ws = this.client.createExecutionAttachWebSocketFromStreamRef(streamRef, { seq: 1, after });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('boxlite attach timeout')), 15000);
            ws.once('open', () => { clearTimeout(timer); resolve(); });
            ws.once('error', (e) => { clearTimeout(timer); reject(e); });
        });
        return new BoxLiteStreamHandle(ws, streamRef, { preferSeqFrames: true, client: this.client });
    }

    async destroy(runtimeRef) {
        // Clean up worktree before destroying VM (best-effort).
        try {
            const { db } = require('../db/index');
            const schema = require('../db/schema');
            const { eq } = require('drizzle-orm');
            const rtRows = await db.select().from(schema.runtimes)
                .where(eq(schema.runtimes.id, runtimeRef));
            if (rtRows.length > 0) {
                const rt = rtRows[0];
                if (rt.agentId && rt.projectId) {
                    const pRows = await db.select().from(schema.projects)
                        .where(eq(schema.projects.id, rt.projectId));
                    if (pRows.length > 0) {
                        await this._removeWorktree(pRows[0], runtimeRef);
                    }
                }
            }
        } catch { /* best-effort */ }

        await this.client.deleteSession(runtimeRef);
    }

    async hibernate(runtimeRef) {
        await this.client.stopSession(runtimeRef);
    }

    async metrics(runtimeRef) {
        return { cpu: 0, memory: 0 };
    }

    async checkpoint(runtimeRef, snapshot) {
        if (!runtimeRef) throw new RuntimeError('runtimeRef required for checkpoint', 400);
        return this.client.createCheckpoint(runtimeRef, snapshot);
    }

    async restore(runtimeRef, snapshot) {
        if (!runtimeRef || !snapshot) throw new RuntimeError('runtimeRef and snapshot required for restore', 400);
        return this.client.restoreCheckpoint(runtimeRef, snapshot);
    }

    async export(runtimeRef) {
        if (!runtimeRef) throw new RuntimeError('runtimeRef required for export', 400);
        return this.client.exportSession(runtimeRef);
    }

    async import(archive, name) {
        return this.client.importSession(archive, name);
    }
}

module.exports = BoxLiteRuntimeProvider;
module.exports.buildWorkspaceMountKey = buildWorkspaceMountKey;
