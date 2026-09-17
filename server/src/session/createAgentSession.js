/**
 * createAgentSession —— 创建 Agent 会话的共享服务。
 *
 * 从 POST /api/v1/session/start 的 regular-agent 分支原样抽取（纯搬移，不改逻辑），
 * 供两个调用方复用：
 *   - HTTP 路由（source='interactive'，行为与历史完全一致）
 *   - LoopTask runner（source='loop_task'，无人值守触发，豁免 sessions 配额——
 *     配额检查留在 HTTP 路由层，本服务不做配额）
 *
 * 返回语义：同步部分完成「校验 + pending 落库 + 后台供应启动」后立即返回；
 * 供应失败通过 markSessionFailed 落 failed 状态（与历史行为一致），调用方轮询
 * SessionManager.isAlive 等待就绪。
 */

const crypto = require('crypto');
const { eq, and, inArray } = require('drizzle-orm');
const { db } = require('../db/index');
const schema = require('../db/schema');
const sessionManager = require('./SessionManager');
const { broadcastSse } = require('./sseManager');
const { getRuntime } = require('../runtime/registry');
const { AgentSpawnError, RuntimeError } = require('../runtime/interfaces');
const { ensureProjectRuntime } = require('../runtime/RuntimeService');
const { issueSessionToken } = require('../llm/sessionToken');
const agentGatewayConfig = require('../admin/AgentGatewayConfig');
const { LocalGitService } = require('../git/LocalGitService');
const { getAgentResume, getAgentResumeLevel, buildStateArgs } = require('../agents/agentResume');
const { getUserSkillDirs } = require('../agents/defaultAgents');
const { applyProjectGitEnv } = require('../agents/projectGitEnv');
const { ensureSessionStateDir, prepareHomeRedirect } = require('./stateDir');
const { resolveRuntimeProvider } = require('../config/runtimeProvider');
const { injectForSession: injectSkillsForSession, isEnabled: skillInjectEnabled } = require('../skills/skillInjector');
const { getTaskRunArgs, getTaskRunRemoveArgs, isTaskRunSupported } = require('../agents/taskRunModes');
const { assembleSpawnArgs } = require('./assembleSpawnArgs');
const { registerSessionLifecycle } = require('./resumeSession');

const runtime = getRuntime();

// —— 以下助手自 server.js 原样搬移（唯一使用方就是会话创建流程）——

async function markSessionFailed(sessionId, errMsg, log) {
    // Never overwrite a user-cancelled / deleted session (exited) or an already-terminal row.
    const updated = await db.update(schema.sessions)
        .set({ status: 'failed', provisioningError: errMsg, updatedAt: Date.now() })
        .where(and(
            eq(schema.sessions.id, sessionId),
            inArray(schema.sessions.status, ['pending', 'running']),
        ))
        .returning({ id: schema.sessions.id, userId: schema.sessions.userId });
    if (!updated.length) return false;
    if (log) log({ sessionId }, `[sessions] provisioning failed: ${errMsg}`);
    try { broadcastSse({ type: 'session_status', sessionId, status: 'failed', userId: updated[0].userId }); } catch (_) {}
    return true;
}

async function isSessionStillPending(sessionId) {
    const rows = await db.select({ status: schema.sessions.status })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId));
    return Boolean(rows[0] && rows[0].status === 'pending');
}

function applyStateDirEnv(env, resumeSpec, stateDirPath) {
    if (!resumeSpec || !stateDirPath) return env;
    const path = require('path');
    let result = env;
    // Set state env var (e.g. CLAUDE_CONFIG_DIR, QWEN_HOME)
    if (resumeSpec.stateEnv && !env[resumeSpec.stateEnv]?.trim()) {
        result = { ...result, [resumeSpec.stateEnv]: stateDirPath };
    }
    // Set additional state-derived env vars (e.g. OPENCLAW_WORKSPACE_DIR -> $STATE_DIR/workspace)
    if (resumeSpec.extraStateEnvs) {
        for (const [envName, suffix] of Object.entries(resumeSpec.extraStateEnvs)) {
            if (!result[envName]?.trim()) {
                result = { ...result, [envName]: path.join(stateDirPath, suffix) };
            }
        }
    }
    // Redirect HOME for agents that store state under ~/.<name>/ (e.g. commandcode)
    if (resumeSpec.redirectHome) {
        result = { ...result, HOME: stateDirPath };
    }
    return result;
}

/**
 * @param {object} p
 * @param {{id: string, role: string}} p.user
 * @param {object} p.project 项目行（getProjectForUser 结果）
 * @param {string} p.agentId
 * @param {object|null} [p.customEnv]
 * @param {Array|null} [p.configFiles]
 * @param {string|null} [p.customImageId]
 * @param {string|null} [p.customImageRef]
 * @param {string|null} [p.terminalThemeId]
 * @param {'interactive'|'loop_task'} [p.source]
 * @param {string|null} [p.title]
 * @param {string|null} [p.taskPrompt] 一次性任务指令：设置后 Agent 以 headless 模式
 *   启动（执行完任务即退出进程，exitCode 即任务结果）。要求 Agent 支持
 *   taskRunModes（不支持时返回 agent_task_unsupported）。
 * @param {boolean} [p.taskAutoApprove] 无人值守自动批准工具调用
 * @param {object} [p.log] fastify 风格 logger（.info/.warn/.error）
 * @returns {Promise<{ok: true, sessionId: string} | {ok: false, statusCode: number, error: string, code?: string}>}
 */
async function createAgentSession({
    user,
    project,
    agentId,
    customEnv = null,
    configFiles = null,
    customImageId = null,
    customImageRef = null,
    terminalThemeId = null,
    source = 'interactive',
    title = null,
    taskPrompt = null,
    taskAutoApprove = false,
    log = console,
}) {
    const projectId = project.id;
    const userId = user.id;
    const sessionId = `sess_${crypto.randomBytes(8).toString('hex')}`;

    // 一次性模式：先校验 Agent 支持，再落 pending 行（避免留孤儿）
    if (taskPrompt && !isTaskRunSupported(agentId)) {
        return {
            ok: false,
            statusCode: 400,
            code: 'agent_task_unsupported',
            error: `Agent "${agentId}" does not support unattended task runs`,
        };
    }

    const dbAgents = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
    if (dbAgents.length === 0) return { ok: false, statusCode: 404, code: 'agent_not_found', error: 'Agent not found' };
    const agentMeta = {
        ...dbAgents[0],
        args: JSON.parse(dbAgents[0].args),
        env_required: JSON.parse(dbAgents[0].envRequired)
    };
    const resumeSpec = getAgentResume(agentMeta.id);
    const recoverable = getAgentResumeLevel(agentMeta.id) === 'L2';

    const authMode = await agentGatewayConfig.getAgentAuthMode(agentMeta.id);
    let sessionToken = null;
    if (authMode === 'gateway') {
        const gwCfg = await agentGatewayConfig.getForAgent(agentMeta.id);
        sessionToken = issueSessionToken({
            sessionId,
            userId,
            projectId,
            agentId: agentMeta.id,
            model: agentGatewayConfig.primaryModel(gwCfg),
            role: user.role,
        });
    }

    const { resolveSpawnEnv, GATEWAY_MANAGED_ENV_KEYS, resolveClaudeCodeModelEnv } = require('../agents/agentEnv');
    const customEnvInput = customEnv && typeof customEnv === 'object' ? { ...customEnv } : {};
    if (authMode === 'gateway' && customEnvInput) {
        for (const key of Object.keys(customEnvInput)) {
            if (GATEWAY_MANAGED_ENV_KEYS.includes(key)) delete customEnvInput[key];
        }
    }
    const resolved = await resolveSpawnEnv({
        userId,
        agentId: agentMeta.id,
        envRequired: agentMeta.env_required,
        sessionToken,
        projectId,
        terminalThemeId,
        warn: (msg) => log.warn(msg),
    });
    if (!resolved.env) {
        return { ok: false, statusCode: 400, error: resolved.error };
    }

    // Merge BYOK env vars + collect BYOK config files for this agent.
    const { getByokFieldValues, generateByokConfig } = require('../agents/byokFields');
    const { getUserSecrets } = require('../agents/agentEnv');
    const byokSecrets = await getUserSecrets(userId);
    const byokValues = getByokFieldValues(agentId, byokSecrets);
    let byokConfigFiles = [];
    if (Object.keys(byokValues).length) {
        const byokConfig = generateByokConfig(agentId, byokValues);
        resolved.env = { ...resolved.env, ...byokConfig.env };
        byokConfigFiles = byokConfig.configFiles || [];
    }
    // opencode TUI follows the embedded xterm theme (gateway mode has no BYOK
    // config generation, so bootstrap the theme file here for both modes).
    if (agentMeta.id === 'opencode' && !byokConfigFiles.some((f) => f.path === '/root/.config/opencode/tui.json')) {
        const { opencodeThemeConfigFile } = require('../agents/byokFields');
        byokConfigFiles = [...byokConfigFiles, opencodeThemeConfigFile()];
    }

    // Validate config files BEFORE creating the session so we can reject
    // invalid JSON without leaving an orphaned session row.
    if (configFiles?.length) {
        const { validateConfigFiles } = require('./sessionConfig');
        const { valid, invalidPaths, invalidJson } = validateConfigFiles(configFiles, agentId);
        if (!valid) {
            const errors = [];
            if (invalidPaths.length) errors.push(`Invalid config file paths: ${invalidPaths.join(', ')}`);
            if (invalidJson?.length) errors.push(`Invalid JSON in: ${invalidJson.map((j) => `${j.path} (${j.error})`).join('; ')}`);
            return { ok: false, statusCode: 400, error: errors.join('; ') };
        }
    }

    // Insert session as pending - user sees a provisioning UI immediately
    await db.insert(schema.sessions).values({
        id: sessionId,
        userId,
        projectId,
        runtimeId: null,
        agentId,
        cwd: '',
        streamRef: null,
        stateDirRef: null,
        recoverable,
        status: 'pending',
        source,
        title: title || null,
        customImageId: customImageId || null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });

    try { broadcastSse({ type: 'session_created', sessionId, userId }); } catch (_) {}

    // Save user-provided config files and custom env to DB
    if ((configFiles?.length) || (customEnvInput && Object.keys(customEnvInput).length)) {
        const { saveSessionConfig } = require('./sessionConfig');
        await saveSessionConfig(db, schema, sessionId, { configFiles: configFiles || [], customEnv: customEnvInput || {} });
    }

    // --- async provisioning: VM creation + agent spawn ---
    (async () => {
        let ready;
        let workspacePath;
        let runtimeId;

        try {
            ready = await ensureProjectRuntime(project, {
                agentId: agentMeta.id,
                ...(customImageRef ? { image: customImageRef } : {}),
                ...(customImageId ? { customImageId: customImageId } : {}),
                agentVmResources: dbAgents[0]?.vmResources || null,
            });
            workspacePath = ready.workspacePath;
            runtimeId = ready.runtime.id;
        } catch (err) {
            log.error({ err, sessionId }, '[sessions] async provisioning: ensureProjectRuntime failed');
            await markSessionFailed(sessionId, err instanceof RuntimeError ? err.message : (err.message || 'Failed to prepare project runtime'));
            return;
        }

        // claude-code 模型 env 需按实际版本选择：>= 2.1.236 用 ANTHROPIC_DEFAULT_MODEL
        // （ANTHROPIC_MODEL 会钉死模型），旧版本用 ANTHROPIC_MODEL。runtime 已就绪，探测一次。
        if (agentMeta.id === 'claude-code') {
            resolved.env = await resolveClaudeCodeModelEnv(agentMeta.id, resolved.env, runtime, {
                runtimeRef: ready.runtime ? ready.runtime.runtimeRef : undefined,
                cwd: workspacePath,
                warn: (msg) => log.warn(msg),
            });
        }

        // Backfill built-in git if create-time initRepo failed (e.g. BoxLite).
        try {
            const localGit = new LocalGitService({ runtimeId });
            await localGit.ensureGitInit(project);
        } catch (err) {
            log.warn({ err, sessionId, projectId: project.id }, '[sessions] ensureGitInit failed (non-fatal)');
        }

        if (!(await isSessionStillPending(sessionId))) {
            log.info({ sessionId }, '[sessions] session cancelled after runtime prepare');
            return;
        }

        // Update cwd and runtimeId now that the VM is ready.
        // Defer the DB write to merge with stateDirRef below (reduces serial DB writes).

        // Run ensureSessionStateDir and ensureKimiConfig SEQUENTIALLY.
        // Concurrent exec calls against a just-booted VM trigger a guest zygote race
        // ("received unexpected message: InitReady, expected: IntermediateReady(0)")
        // that surfaces as "mkdir failed" / "failed to spawn command in sandbox".
        let sessionStateDir = null;
        if (resumeSpec?.stateEnv || resumeSpec?.stateArgs || resumeSpec?.redirectHome) {
            try {
                sessionStateDir = await ensureSessionStateDir(runtime.fs, {
                    workspaceRoot: workspacePath,
                    sessionId,
                    runtimeRef: ready.runtime ? ready.runtime.runtimeRef : undefined,
                });
            } catch (err) {
                log.error({ err, sessionId }, '[sessions] async provisioning: ensureSessionStateDir failed');
                const errMsg = err instanceof RuntimeError ? err.message : (err.message || 'Failed to prepare agent state directory');
                await markSessionFailed(sessionId, errMsg);
                return;
            }
            if (!sessionStateDir) {
                await markSessionFailed(sessionId, 'Failed to prepare agent state directory');
                return;
            }
        }

        // ensureKimiConfig is best-effort.
        try {
            const { ensureKimiConfig } = require('../workspace/kimiConfigBootstrap');
            await ensureKimiConfig({
                runtime,
                runtimeRef: ready.runtime ? ready.runtime.runtimeRef : undefined,
                userId,
                agentId: agentMeta.id,
                warn: (msg) => log.warn(msg),
            });
        } catch (err) {
            log.warn({ err, sessionId }, '[sessions] kimi config bootstrap failed');
        }

        // Write user-provided config files BEFORE bootstrap so that bootstrap
        // logic (e.g. claude-code API key approval) can augment user-provided files.
        const { writeConfigFilesToVM, applyCustomEnv, getSessionConfig, resolveAgentSpawnArgs } = require('./sessionConfig');
        const { mergeByokConfigFiles } = require('../agents/byokFields');
        const userSessionConfig = await getSessionConfig(db, schema, sessionId);
        const mergedConfigFiles = mergeByokConfigFiles(byokConfigFiles, userSessionConfig.configFiles);
        if (mergedConfigFiles.length) {
            const vmRuntimeRef = ready.runtime ? ready.runtime.runtimeRef : undefined;
            await writeConfigFilesToVM(runtime.fs, {
                workspaceRoot: workspacePath,
                runtimeRef: vmRuntimeRef,
                configFiles: mergedConfigFiles,
                stateDirPath: sessionStateDir?.stateDirPath || null,
            }).catch((err) => log.warn({ err, sessionId }, '[sessions] writeConfigFilesToVM failed'));
        }

        if (sessionStateDir?.stateDirPath) {
            resolved.env = applyStateDirEnv(resolved.env, resumeSpec, sessionStateDir.stateDirPath);
            // Pre-approve custom API key for claude-code to skip the "Detected
            // a custom API key" confirmation prompt that blocks --continue.
            if (agentMeta.id === 'claude-code' && resolved.env.ANTHROPIC_API_KEY) {
                try {
                    const { ensureClaudeApiKeyApproved } = require('../workspace/claudeConfigBootstrap');
                    await ensureClaudeApiKeyApproved({
                        runtime,
                        runtimeRef: ready.runtime ? ready.runtime.runtimeRef : undefined,
                        stateDirPath: sessionStateDir.stateDirPath,
                        apiKey: resolved.env.ANTHROPIC_API_KEY,
                    });
                } catch (err) {
                    log.warn({ err, sessionId }, '[sessions] claude api key approval failed');
                }
            }
            if (resumeSpec?.redirectHome && sessionStateDir.stateDirRef) {
                const runtimeRef = ready.runtime ? ready.runtime.runtimeRef : undefined;
                await prepareHomeRedirect(runtime.fs, {
                    workspaceRoot: workspacePath,
                    stateDirRef: sessionStateDir.stateDirRef,
                    runtimeRef,
                }).catch((err) => log.warn({ err, sessionId }, '[sessions] prepareHomeRedirect failed'));
            }
        }

        // Gateway mode: write agent-specific config files to route through the gateway.
        // Runs AFTER user config files and state dir env so gateway config can override.
        if (authMode === 'gateway') {
            try {
                const { ensureGatewayConfig } = require('../workspace/ensureGatewayConfig');
                const { resolveAgentGatewayModelTargets } = require('../agents/agentEnv');
                const { targets: modelTargets, defaultTarget } = await resolveAgentGatewayModelTargets(agentMeta.id);
                await ensureGatewayConfig({
                    runtime,
                    runtimeRef: ready.runtime ? ready.runtime.runtimeRef : undefined,
                    agentId: agentMeta.id,
                    authMode,
                    stateDirPath: sessionStateDir?.stateDirPath || null,
                    sessionToken: resolved.env.LLM_ROUTER_API_KEY,
                    routerUrl: resolved.env.LLM_ROUTER_URL,
                    modelTarget: resolved.env.OPENAI_MODEL,
                    modelTargets,
                    defaultTarget,
                    warn: (msg) => log.warn(msg),
                });
            } catch (err) {
                log.warn({ err, sessionId }, '[sessions] gateway config bootstrap failed');
            }
        }

        if (!(await isSessionStillPending(sessionId))) {
            log.info({ sessionId }, '[sessions] session cancelled before spawn');
            return;
        }

        // Single DB update: merge cwd + runtimeId + stateDirRef (was 2 separate writes).
        const sessionUpdate = {
            cwd: workspacePath,
            runtimeId,
            updatedAt: Date.now(),
        };
        if (sessionStateDir?.stateDirRef) {
            sessionUpdate.stateDirRef = sessionStateDir.stateDirRef;
        }
        await db.update(schema.sessions).set(sessionUpdate).where(eq(schema.sessions.id, sessionId));

        applyProjectGitEnv(resolved.env, project);

        let handle;
        const spawnOpts = {
            name: agentMeta.name,
            cwd: workspacePath,
            runtimeRef: ready.runtime ? ready.runtime.runtimeRef : undefined,
            uid: process.env.RUNTIME_UID,
            gid: process.env.RUNTIME_GID,
        };

        // Merge user-provided custom env (config files already written above)
        if (Object.keys(userSessionConfig.customEnv).length) {
            resolved.env = applyCustomEnv(resolved.env, userSessionConfig.customEnv, {
                blockedKeys: authMode === 'gateway' ? GATEWAY_MANAGED_ENV_KEYS : [],
            });
        }

        // P4：spawn 前把 active skills 注入 workspace 指令文件（AGENTS.md / CLAUDE.md）。
        // 失败仅 log，不阻断 spawn。workspace 目录由 workspace.js 在控制面本地创建
        // （Local/BoxLite 均可见），故用默认本地 fs 适配器直写。
        // 路径注意：注入器用「宿主机本地 fs」直写，因此必须传**宿主机真实路径**。
        //   - Local runtime：ready.workspacePath 即宿主机路径（createProjectDirectory）
        //   - BoxLite runtime：ready.workspacePath 是沙箱内 guest 路径（/workspace），
        //     宿主机真实目录在 ready.hostWorkspacePath —— 传 guest 路径会写到宿主机 /workspace
        //     导致沙箱挂载目录里看不到技能（历史 bug，已修复）。
        if (skillInjectEnabled()) {
            try {
                // Claude Code / CodeBuddy / Qwen Code / OpenClaw 的 config 目录 env
                // 改变扫描根为 <configDir>/skills。其余 Agent 若改变扫描根，子目录应与 userSkillDirs[0] 一致。
                const stateSkillsSubdir = (agentMeta.id === 'claude-code' || agentMeta.id === 'codebuddy' || agentMeta.id === 'qwen-code' || agentMeta.id === 'openclaw' || agentMeta.id === 'hermes')
                    ? 'skills'
                    : (getUserSkillDirs(agentMeta.id)[0] || 'skills');
                // Cline / OpenCode 的 stateEnv 不影响 skills 发现，走 /root/<userSkillDirs>
                const stateSkillsDir = (agentMeta.id !== 'cline' && agentMeta.id !== 'opencode')
                    && (resumeSpec?.stateEnv || resumeSpec?.redirectHome) && sessionStateDir?.stateDirPath && stateSkillsSubdir
                    ? `${sessionStateDir.stateDirPath}/${stateSkillsSubdir}`
                    : null;
                const injectResult = await injectSkillsForSession({
                    userId,
                    projectId,
                    agentId: agentMeta.id,
                    workspacePath: ready.hostWorkspacePath || workspacePath,
                    // 载体模式：spawn 前把宿主载体全量复制为 VM 内真目录（1 次 exec，
                    // 每次会话启动即最新）——复制对所有 Agent 的扫描实现一致
                    runtimeExec: runtime && runtime.exec ? runtime.exec : null,
                    runtimeRef: ready.runtime ? ready.runtime.runtimeRef : null,
                    carrierGuestRoot: ready.skillCarrierGuestRoot || null,
                    vmSkillsDir: stateSkillsDir,
                });
                if (injectResult.injected) {
                    log.info(
                        `[skills] injected ${injectResult.count} skill(s) for ${agentMeta.id} (session ${sessionId}) → ${injectResult.targetDirs?.join(', ') || 'host carrier only'}`,
                    );
                }
            } catch (err) {
                log.warn({ err, sessionId }, '[skills] inject-for-session failed (non-fatal)');
            }
        }

        try {
            const stateArgs = sessionStateDir?.stateDirPath
                ? buildStateArgs(resumeSpec, sessionStateDir.stateDirPath)
                : [];
            const spawnArgs = resolveAgentSpawnArgs(agentMeta.id, mergedConfigFiles, {
                authMode,
                gatewayModel: resolved.env.OPENAI_MODEL,
            });
            // 一次性模式（LoopTask）：追加 headless 任务指令参数，Agent 执行完即退出；
            // 剔除与一次性模式冲突的基础参数（如 cline 的 -i 强制 TUI）
            const taskRunArgs = taskPrompt ? getTaskRunArgs(agentMeta.id, taskPrompt, { autoApprove: taskAutoApprove }) : null;
            const taskRemoveArgs = taskPrompt ? getTaskRunRemoveArgs(agentMeta.id) : [];
            const baseAgentArgs = taskRemoveArgs.length
                ? agentMeta.args.filter((a) => !taskRemoveArgs.includes(a))
                : agentMeta.args;
            handle = await runtime.exec.spawn(
                agentMeta.cmd,
                assembleSpawnArgs({
                    agentId: agentMeta.id,
                    prepend: spawnArgs.prepend,
                    stateArgs,
                    baseArgs: baseAgentArgs,
                    append: spawnArgs.append,
                    taskArgs: taskRunArgs || [],
                }),
                resolved.env,
                spawnOpts,
            );
        } catch (err) {
            if (
                err instanceof AgentSpawnError
                && resolveRuntimeProvider() === 'boxlite'
                && ready.runtime?.runtimeRef
            ) {
                log.warn({ err, sessionId }, '[sessions] spawn failed, recreating boxlite runtime');
                try {
                    ready = await ensureProjectRuntime(project, {
                        agentId: agentMeta.id,
                        runtimeId: ready.runtime.id,
                        forceRecreate: true,
                    });
                    workspacePath = ready.workspacePath;
                    spawnOpts.cwd = workspacePath;
                    spawnOpts.runtimeRef = ready.runtime.runtimeRef;
                    // Re-create state dir and re-write user config files in the new VM
                    if (sessionStateDir) {
                        try {
                            sessionStateDir = await ensureSessionStateDir(runtime.fs, {
                                workspaceRoot: workspacePath,
                                sessionId,
                                runtimeRef: ready.runtime ? ready.runtime.runtimeRef : undefined,
                            });
                        } catch (e) { /* best-effort */ }
                    }
                    if (mergedConfigFiles.length) {
                        await writeConfigFilesToVM(runtime.fs, {
                            workspaceRoot: workspacePath,
                            runtimeRef: ready.runtime ? ready.runtime.runtimeRef : undefined,
                            configFiles: mergedConfigFiles,
                            stateDirPath: sessionStateDir?.stateDirPath || null,
                        }).catch(() => {});
                    }
                    const retryStateArgs = sessionStateDir?.stateDirPath
                        ? buildStateArgs(resumeSpec, sessionStateDir.stateDirPath)
                        : [];
                    const retrySpawnArgs = resolveAgentSpawnArgs(agentMeta.id, mergedConfigFiles, {
                        authMode,
                        gatewayModel: resolved.env.OPENAI_MODEL,
                    });
                    const retryTaskRunArgs = taskPrompt ? getTaskRunArgs(agentMeta.id, taskPrompt, { autoApprove: taskAutoApprove }) : null;
                    const retryRemoveArgs = taskPrompt ? getTaskRunRemoveArgs(agentMeta.id) : [];
                    const retryBaseAgentArgs = retryRemoveArgs.length
                        ? agentMeta.args.filter((a) => !retryRemoveArgs.includes(a))
                        : agentMeta.args;
                    handle = await runtime.exec.spawn(
                        agentMeta.cmd,
                        assembleSpawnArgs({
                            agentId: agentMeta.id,
                            prepend: retrySpawnArgs.prepend,
                            stateArgs: retryStateArgs,
                            baseArgs: retryBaseAgentArgs,
                            append: retrySpawnArgs.append,
                            taskArgs: retryTaskRunArgs || [],
                        }),
                        resolved.env,
                        spawnOpts,
                    );
                } catch (retryErr) {
                    log.error({ err: retryErr, sessionId }, '[sessions] spawn retry failed');
                    await markSessionFailed(sessionId, retryErr instanceof AgentSpawnError
                        ? retryErr.message
                        : (retryErr.message || 'Failed to start agent session'));
                    return;
                }
            } else {
                log.error({ err, sessionId }, '[sessions] spawn failed');
                await markSessionFailed(sessionId, err instanceof AgentSpawnError
                    ? err.message
                    : (err.message || 'Failed to start agent session'));
                return;
            }
        }

        // Guard: if the user deleted the session while provisioning, abort
        const currentRows = await db.select({ status: schema.sessions.status })
            .from(schema.sessions)
            .where(eq(schema.sessions.id, sessionId));
        if (!currentRows[0] || currentRows[0].status !== 'pending') {
            log.info({ sessionId }, '[sessions] session no longer pending, discarding spawn result');
            try { handle.kill(); } catch {}
            return;
        }

        sessionManager.createSession(sessionId, handle, agentMeta.id, {
            transcriptRef: handle.streamRef,
            projectId,
            runtimeId,
            runtimeRef: ready.runtime ? ready.runtime.runtimeRef : undefined,
            stateDirRef: sessionStateDir?.stateDirRef || null,
            userId,
        });

        await registerSessionLifecycle({
            db,
            schema,
            sessionManager,
            sessionId,
            project,
            fastifyLog: log,
            runtimeId,
        });

        const streamRef = handle.streamRef ?? null;
        await db.update(schema.sessions).set({
            status: 'running',
            streamRef: streamRef || null,
            updatedAt: Date.now(),
        }).where(eq(schema.sessions.id, sessionId));
        broadcastSse({ type: 'session_status', sessionId, status: 'running', userId });
    })().catch((err) => {
        log.error({ err, sessionId }, '[sessions] async provisioning uncaught error');
        markSessionFailed(sessionId, err.message || 'Unexpected error during session provisioning').catch(() => {});
    });

    return { ok: true, sessionId };
}

module.exports = { createAgentSession };
