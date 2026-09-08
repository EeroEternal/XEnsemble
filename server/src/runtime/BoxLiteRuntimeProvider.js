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

/**
 * 0030（.git 搭车）：技能载体 guest 根路径。
 *
 * 背景：2026-09-03 journal 对照实验定论——libkrun 单 VM 的 virtio-fs 硬预算 = 2 个卷
 * （+ 块设备 + 网络）。worktree 会话已占满（workspace + .git），任何第 3 个 FS 卷
 * 必触发 RegisterNetDevice/RegisterBlockDevice(IrqsExhausted) → open session 500
 * "mkdir memory dir"（blink HTTP 层统一文案，真实原因看 journalctl）。0026/0028 的
 * 挂载型技能卷方案因此对 worktree 会话物理不可行（2f62fa3 回退的真实根因）。
 *
 * 方案：技能落宿主 projectDir/.git/xe-skills/（git 对内部未知目录完全无视——
 * 不出现在 git status / changes，无需 .gitignore），随现有两个卷之一进沙箱：
 * - worktree 会话：经 .git 卷暴露为 /workspace.git/xe-skills
 * - 默认会话：经 workspace 卷暴露为 /workspace/.git/xe-skills（工程为 git 仓库时）
 * 零新增挂载设备。buildSkillSymlinkScript 在 VM 引导期把 agent 的各 userSkillDirs
 * symlink 到载体路径（/root/<dir>），Agent 原生发现 + 反向安装落宿主持久化。
 * SKILL_CARRIER_ENABLED=false 可整体停用（回落工程内 .xensemble 模式）。
 */

/**
 * 0030（.git 搭车）：生成 VM 引导期的技能目录种子脚本（POSIX sh，busybox 兼容）。
 * 对 agent 声明的全部 userSkillDirs 逐个把载体内容复制到 /root/<dir>：
 * - 镜像内置的实体目录 → 若载体对应目录为空，先把镜像内容种子合并进载体
 *   （cp -a，避免 agent 随镜像自带的技能丢失），再整体复制
 * - 不再用目录级软链：Claude Code 的目录遍历对子项 lstat/Dirent 过滤，实测
 *   软链技能被静默跳过（/skills 为空）而 opencode 正常；libkrun 内
 *   mount --bind 也无权限。复制出的真目录对所有 Agent 实现一致。
 * - 实际的技能内容同步由 injectForSession 在每次 spawn 前经沙箱 exec 全量
 *   刷新 /root/<dir>（每次会话启动即最新），本脚本仅作新 VM 的初始兜底。
 * 位于 VM 本地 /root（非挂载卷），VM 销毁即失，须在每个新 VM 引导期重建；
 * VM 复用（reused）时 guest FS 保留，由 spawn 前复制保持新鲜。
 * @param {string} agentId
 * @param {string|null} carrierGuestRoot 载体 guest 根（如 /workspace.git/xe-skills）；
 *   null（载体停用 / 工程非 git 仓库 / agent 无 userSkillDirs）时不生成
 * @returns {string|null} 脚本内容
 */
function buildSkillSymlinkScript(agentId, carrierGuestRoot) {
    if (process.env.SKILL_CARRIER_ENABLED === 'false') return null;
    if (!carrierGuestRoot) return null;
    const { DEFAULT_AGENTS } = require('../agents/defaultAgents');
    const agent = agentId ? DEFAULT_AGENTS.find((a) => a.id === agentId) : null;
    const dirs = agent?.userSkillDirs || [];
    if (dirs.length === 0) return null;
    const parts = [];
    for (const dir of dirs) {
        const carrier = `${carrierGuestRoot}/${dir}`;
        const link = `/root/${dir}`;
        const linkParent = path.posix.dirname(link);
        parts.push(
            `mkdir -p ${JSON.stringify(carrier)} ${JSON.stringify(linkParent)}; `
            // 旧整层软链清理；镜像内置实体目录先种子合并进载体（载体为空时），
            // 避免 agent 自带技能丢失
            + `if [ -L ${JSON.stringify(link)} ]; then rm -f ${JSON.stringify(link)}; fi; `
            + `if [ -d ${JSON.stringify(link)} ] && [ -z "$(ls -A ${JSON.stringify(carrier)} 2>/dev/null)" ]; then `
            + `cp -a ${JSON.stringify(link)}/. ${JSON.stringify(carrier)}/ 2>/dev/null || true; fi; `
            + `mkdir -p ${JSON.stringify(link)}; `
            + `cp -a ${JSON.stringify(carrier)}/. ${JSON.stringify(link)}/ 2>/dev/null || true`,
        );
    }
    return parts.join('; ');
}

/**
 * 0030：解析本次会话的技能载体 guest 根路径。
 * - worktree 会话（gitVolume 存在）：.git 卷内 → /workspace.git/xe-skills
 * - 默认会话：workspace 卷内 → /workspace/.git/xe-skills（仅当工程为 git 仓库）
 * - 载体停用（SKILL_CARRIER_ENABLED=false）或工程非 git → null（技能走工程内回落）
 * @param {object} workspaceVolume buildWorkspaceVolume 产物
 * @param {string} hostWorkspacePath 宿主侧 workspace 路径（worktree 或 projectDir）
 * @param {string} guestWorkspacePath 沙箱内 workspace 路径
 * @returns {string|null}
 */
function resolveSkillCarrierGuestRoot(workspaceVolume, hostWorkspacePath, guestWorkspacePath) {
    if (process.env.SKILL_CARRIER_ENABLED === 'false') return null;
    if (workspaceVolume.gitVolume) {
        // worktree 会话：.git 卷必然存在（worktree 依赖 .git）
        return `${workspaceVolume.gitVolume.guest_path}/xe-skills`;
    }
    // 默认会话：仅当工程是 git 仓库（宿主 projectDir/.git 存在）才搭 workspace 卷的车
    try {
        if (fs.existsSync(path.join(hostWorkspacePath, '.git'))) {
            return `${guestWorkspacePath}/.git/xe-skills`;
        }
    } catch { /* best-effort */ }
    return null;
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
            // Read-write: git write operations (commit, add, merge) inside the VM
            // need to update index, HEAD, refs, and objects. Git's built-in file
            // locks (index.lock, ref-lock, atomic temp+rename) safely handle
            // concurrent access across worktrees that share the same .git dir.
            read_only: false,
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

        fs.mkdirSync(path.dirname(wtDir), { recursive: true });
        const branchName = `agentharness/session-${runtimeId.slice(-4)}`;
        const baseBranch = project.repoDefaultBranch || 'main';
        try {
            await execFileAsync('git', ['-C', mainDir, 'fetch', 'origin', baseBranch]);
        } catch { /* offline or no remote */ }
        try {
            await execFileAsync('git', ['-C', mainDir, 'worktree', 'add', '-b', branchName, wtDir, `origin/${baseBranch}`]);
            return wtDir;
        } catch {
            try {
                await execFileAsync('git', ['-C', mainDir, 'worktree', 'add', '-b', branchName, wtDir]);
                return wtDir;
            } catch {
                try {
                    await execFileAsync('git', ['-C', mainDir, 'worktree', 'add', '--detach', wtDir]);
                    return wtDir;
                } catch {
                    return null;
                }
            }
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
    async _initFreshSessionExecs(name, { probeCmd, guestWorkspacePath, project, hostWorkspacePath, withBootstrap, skillSymlinkScript = null }) {
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

        // 0030（.git 搭车）：技能载体 symlink 引导——把 agent 的各 userSkillDirs 链到
        // /root/<dir>（指向 .git 内的载体目录）。必须发生在 agent spawn 之前
        //（Agent 启动即扫描技能目录）。best-effort：失败不阻断会话（技能不可用但会话正常）。
        if (skillSymlinkScript && !initError) {
            try {
                await this.client.execForResult(name, 'sh', ['-c', skillSymlinkScript]);
            } catch (_) {
                // Best-effort: skill symlink setup failure does not block the session.
            }
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
        // points to a host path that doesn't exist inside the VM. Rewrite it to
        // the VM mount path so git inside the VM works. Host-side git bypasses
        // the pointer via --git-dir/--work-tree (see hostGit).
        //
        // Also set safe.directory for /workspace and /workspace.git: virtiofs
        // uses a swap UID idmap (host 0 ↔ guest 1000), so worktree gitdir files
        // written by host-side git (root) appear as UID 1000 inside the VM.
        // git's dubious-ownership check rejects this, breaking `git log` etc.
        // in the VM terminal after any host-side git op (branch switch, UI commit).
        // safe.directory skips the ownership check; /root/.gitconfig is VM-local
        // (image layer, not a mounted volume), so this is per-VM isolated.
        if (hostWorkspacePath && guestWorkspacePath) {
            try {
                await this.client.execForResult(name, 'sh', ['-c',
                    `git config --global safe.directory /workspace 2>/dev/null || true; ` +
                    `git config --global safe.directory /workspace.git 2>/dev/null || true; ` +
                    `if [ -f "${guestWorkspacePath}/.git" ]; then ` +
                    `GITDIR=$(cat "${guestWorkspacePath}/.git" | sed 's/^gitdir: //'); ` +
                    `if [ ! -d "$GITDIR" ] && [ -d /workspace.git ]; then ` +
                    `WTNAME=$(basename "$GITDIR"); ` +
                    `echo "gitdir: /workspace.git/worktrees/$WTNAME" > "${guestWorkspacePath}/.git"; ` +
                    `echo "/workspace/.git" > "/workspace.git/worktrees/$WTNAME/gitdir" 2>/dev/null || true; ` +
                    `fi; fi`,
                ]);
            } catch (_) {
                // Best-effort: if git fixup fails, host-side git still works
                // via --git-dir/--work-tree.
            }
        }

        await bootstrapPromise;
        if (!initError && bootstrapError) initError = bootstrapError;
        return { probeOk, initError };
    }

    async ensureReady(project, opts = {}) {
        const runtimeId = opts && opts.runtimeId ? opts.runtimeId : null;
        const deploymentId = opts && opts.deploymentId ? opts.deploymentId : null;
        const name = runtimeId || `p_${project.id}${deploymentId ? `_dep_${deploymentId}` : ''}_${opts.agentId || 'default'}`;
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
        // 0030（.git 搭车）：技能载体 guest 根——worktree 会话在 .git 卷内，
        // 默认会话在 workspace 卷内的 .git 下；工程非 git / 载体停用 → null。
        // symlink 引导脚本在每个新 VM 引导期执行（见 _initFreshSessionExecs）。
        const skillCarrierGuestRoot = resolveSkillCarrierGuestRoot(workspaceVolume, hostWorkspacePath, guestWorkspacePath);
        const skillSymlinkScript = buildSkillSymlinkScript(opts.agentId, skillCarrierGuestRoot);
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
                    const errMsg = String(e);
                    // Host blink-server returns 500 with this message when session is in Failed state
                    const isFailedStatus = /Invalid BoxStatus for initialization: Failed/i.test(errMsg);
                    if (/already|exists/i.test(errMsg) || isFailedStatus) {
                        // Session exists - check if it's actually healthy
                        let statusInfo = null;
                        try {
                            statusInfo = await this.client.getSessionStatus(name);
                        } catch (_) { /* status query failed */ }
                        if (statusInfo && statusInfo.running && statusInfo.status === 'Running') {
                            if (needRecreate) {
                                throw new RuntimeError(
                                    `BoxLite ensureReady failed: session "${name}" still exists after delete - cannot recreate with image ${image}`,
                                    502,
                                );
                            }
                            return { reused: true };
                        }
                        // VM is in Failed state (detected via status API or error message) - cannot be initialized, must delete and recreate
                        if (isFailedStatus || (statusInfo && statusInfo.status === 'Failed')) {
                            try { await this.client.deleteSession(name); } catch (_) {}
                            await new Promise((r) => setTimeout(r, 500));
                            await this.client.openSession(name, image, warm, openOptions);
                            return { reused: false };
                        }
                        // VM is not Running or status unknown (e.g. Stopped).
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
                name, { probeCmd, guestWorkspacePath, project, hostWorkspacePath, withBootstrap, skillSymlinkScript },
            );

            if (probeCmd && !probeOk) {
                await this.client.deleteSession(name);
                await openSession();
                // Re-run init execs on the recreated VM (a fresh VM usually
                // clears the transient race), then probe once more.
                const recreate = await this._initFreshSessionExecs(
                    name, { probeCmd: null, guestWorkspacePath, project, hostWorkspacePath, withBootstrap, skillSymlinkScript },
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
        // 记录 host workspace path → runtimeRef 映射，供 attach(runtimeRef) 查询
        // （analyzeDeploy 依赖此值做 detectStack：fallback 到 sandbox /workspace
        // 会让 index.html 误触发 detectStaticStack → plan 走 python3 -m http.server
        // → 后端永不启动 → POST 5xx）。仅 boxlite 路径写，local/k8s 不受影响。
        this._hostWorkspacePaths.set(name, workspaceVolume.host_path);
        // skillCarrierGuestRoot：技能载体 guest 根，供 spawn 前把宿主载体复制为
        // VM 内真目录时使用（见 injectForSession 的 runtimeExec 分支）。
        return {
            runtimeRef: name,
            workspacePath: guestWorkspacePath,
            image,
            mountKey,
            hostWorkspacePath,
            skillCarrierGuestRoot: skillCarrierGuestRoot || null,
        };
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
        return new BoxLiteStreamHandle(ws, streamRef, {
            preferSeqFrames: true,
            client: this.client,
            reattachMaxAttempts: options.reattachMaxAttempts,
        });
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
module.exports.buildSkillSymlinkScript = buildSkillSymlinkScript;
module.exports.resolveSkillCarrierGuestRoot = resolveSkillCarrierGuestRoot;
