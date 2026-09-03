const TRUSTED_PROXIES = process.env.TRUSTED_PROXIES
    ? process.env.TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean)
    : false;
const fastify = require('fastify')({ logger: true, trustProxy: TRUSTED_PROXIES, bodyLimit: 10485760 });
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const FS_LIST_CACHE_TTL_MS = 3000;
const fsListCache = new Map();

const { sendPublicError, sanitizePublicError } = require('./http/publicError');
const { getRuntime } = require('./runtime/registry');
const { AgentSpawnError, RuntimeError } = require('./runtime/interfaces');
const { ensureProjectRuntime, formatRuntime } = require('./runtime/RuntimeService');
const deploymentService = require('./deployments/DeploymentService');
const repositoryEnvironment = require('./repositories/RepositoryEnvironmentService');
const { recordEvent } = require('./events/recordEvent');
const { registerPreviewGateway } = require('./preview/gateway');
const { registerLlmProxy } = require('./llm/proxy');
const chatTranscript = require('./llm/chatTranscript');
const { issueSessionToken } = require('./llm/sessionToken');
const agentGatewayConfig = require('./admin/AgentGatewayConfig');
const userAdmin = require('./admin/UserAdminService');
const { startPreviewLifecycle } = require('./preview/lifecycle');
const { stopTunnel } = require('./preview/tunnelServer');
const { abortDeploy, listByUser } = require('./deployments/activeDeploys');
const sessionManager = require('./session/SessionManager');
const { WorkspaceShellManager, subscribeWorkspaceShell } = require('./session/workspaceShell');
const { reconcileRunningSessions } = require('./session/reconcileRunningSessions');
const { recoverRunningSessions } = require('./session/recoverRunningSessions');
const { reconcileCustomImageBuilds } = require('./runtime/reconcileCustomImageBuilds');

const { db } = require('./db/index');
const schema = require('./db/schema');
const { eq, and, ne, sql, inArray } = require('drizzle-orm');
const auth = require('./auth/index');
const { assertActiveUser } = require('./auth/assertActiveUser');
const {
    closeUnauthorizedWebSocket,
    closeForbiddenWebSocket,
    sendWebSocketReady,
} = require('./auth/websocket');
const { addSseClient, broadcastSse } = require('./session/sseManager');
const { t } = require('./i18n');
const { getProjectForUser, invalidateProjectCache } = require('./projects/getProjectForUser');
const { registerAuthHooks } = require('./auth/hooks');
const { detectLocale } = require('./i18n/localeDetector');
const policy = require('./auth/PolicyService');
const { registerAuthRoutes } = require('./routes/auth');
const { registerAdminRoutes } = require('./routes/admin');
const { registerUserRoutes } = require('./routes/user');
const { registerWorkspaceRoutes } = require('./routes/workspace');
const { registerAutoDeployRoutes, runAutoTwoStageDeploy } = require('./deployments/twoStage');
const { registerTerminalHttpRoutes } = require('./routes/terminalHttp');
const { registerGitHubRoutes } = require('./routes/github');
const { registerGitRoutes } = require('./routes/git');
const { registerProjectGitRoutes } = require('./routes/projectGit');
const { registerGitHubAppRoutes } = require('./routes/githubApp');
const { registerCustomImageRoutes } = require('./routes/customImages');
const { registerSkillRoutes } = require('./routes/skills');
const { LocalGitService } = require('./git/LocalGitService');
const { applyTerminalMessage, subscribeTerminal } = require('./session/terminalBridge');
const { resumeSession, registerSessionLifecycle } = require('./session/resumeSession');
const {
    start: startConversationAutoSummarizer,
    stop: stopConversationAutoSummarizer,
} = require('./session/conversationAutoSummarizer');
const { startScheduler, stopScheduler } = require('./scheduler');
const {
    start: startSkillPipelineHook,
    stop: stopSkillPipelineHook,
} = require('./skills/skillPipeline');
const { injectForSession: injectSkillsForSession, isEnabled: skillInjectEnabled } = require('./skills/skillInjector');
const { createIdleHibernateMonitor, stopSession, waitForAgentExit } = require('./session/idleHibernate');
const { terminateDetachedSessionProcess } = require('./session/sessionTermination');
const {
    gracefulShutdownSessions,
    installProcessShutdownHooks,
} = require('./session/gracefulShutdown');
const { buildResumeSessionContext } = require('./session/resumeSessionContext');
const transcriptStore = require('./runtime/TranscriptStore');
const activeWebSockets = new Set();

async function resolveRuntimeIdFromSession(userId, sessionId) {
    if (!sessionId) return null;
    const rows = await db.select().from(schema.sessions)
        .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId)));
    return rows[0]?.runtimeId || null;
}

function trackWebSocket(ws) {
    if (!ws) return;
    activeWebSockets.add(ws);
    const forget = () => activeWebSockets.delete(ws);
    ws.once('close', forget);
    ws.once('error', forget);
}
const unigateway = require('./gateway/unigatewayManager');
const { registerGatewayAdminRoutes } = require('./gateway/adminProxy');
const { deleteProjectForUser } = require('./projects/deleteProject');
const { getAgentResume, getAgentResumeLevel, buildStateArgs } = require('./agents/agentResume');
const { applyProjectGitEnv } = require('./agents/projectGitEnv');
const { ensureSessionStateDir, prepareHomeRedirect } = require('./session/stateDir');
const { resolveRuntimeProvider, DEFAULT_RUNTIME_PROVIDER } = require('./config/runtimeProvider');

const runtime = getRuntime();

async function markSessionFailed(sessionId, errMsg, log) {
    // Never overwrite a user-cancelled / deleted session (exited) or an already-terminal row.
    const updated = await db.update(schema.sessions)
        .set({ status: 'failed', provisioningError: errMsg })
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

function formatAgentRow(a) {
    const { DEFAULT_AGENTS } = require('./agents/defaultAgents');
    const catalogEntry = DEFAULT_AGENTS.find((entry) => entry.id === a.id);
    return {
        id: a.id,
        name: a.name,
        cmd: a.cmd,
        args: JSON.parse(a.args),
        env_required: JSON.parse(a.envRequired),
        config_schema: catalogEntry?.configSchema || null,
    };
}

// getProjectForUser is imported from ./projects/getProjectForUser (cached)

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

const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : ['http://127.0.0.1:3889', 'http://localhost:3889'];

fastify.register(require('@fastify/cors'), {
    origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) {
            cb(null, true);
            return;
        }
        cb(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true,
});
fastify.register(require('@fastify/websocket'), {
    options: { maxPayload: 1024 * 1024 },
});

registerAuthHooks(fastify);

// Inject request.locale for i18n error messages
fastify.addHook('onRequest', async (request) => {
  request.locale = detectLocale(request);
});

registerAuthRoutes(fastify);
registerAdminRoutes(fastify);
registerUserRoutes(fastify);
registerWorkspaceRoutes(fastify, { getProjectForUser });
registerAutoDeployRoutes(fastify, { getProjectForUser });
registerTerminalHttpRoutes(fastify);
registerGatewayAdminRoutes(fastify);
registerGitHubRoutes(fastify);
registerGitRoutes(fastify);
registerProjectGitRoutes(fastify);
registerGitHubAppRoutes(fastify);
registerCustomImageRoutes(fastify);
registerSkillRoutes(fastify);

// -- API Routes --

fastify.get('/api/v1/runtime/info', async () => {
    const provider = resolveRuntimeProvider();
    const configured = process.env.RUNTIME_PROVIDER?.trim() || null;
    let blink = null;
    if (provider === 'boxlite') {
        const url = process.env.BLINK_API_URL || 'http://127.0.0.1:8787';
        try {
            const BoxLiteClient = require('./runtime/BoxLiteClient');
            const bc = new BoxLiteClient();
            await bc.health();
            blink = { reachable: true, url };
        } catch (err) {
            blink = { reachable: false, url, error: err.message };
        }
    }
    return {
        provider,
        configured_provider: configured,
        default_provider: DEFAULT_RUNTIME_PROVIDER,
        blink,
    };
});

fastify.get('/api/v1/secrets', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const result = await db.select().from(schema.secrets).where(eq(schema.secrets.userId, request.user.id));
    if (result.length === 0) return {};
    return auth.decryptSecrets(result[0].encryptedData);
});

fastify.post('/api/v1/secrets', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    try {
        const existing = await db.select().from(schema.secrets).where(eq(schema.secrets.userId, request.user.id));
        let currentSecrets = {};
        if (existing.length > 0) {
            currentSecrets = auth.decryptSecrets(existing[0].encryptedData);
        }

        const updates = Object.fromEntries(
            Object.entries(request.body || {}).filter(([, v]) => v != null && String(v).trim() !== '')
        );
        const deletedKeys = Object.entries(request.body || {})
            .filter(([, v]) => v == null || String(v).trim() === '')
            .map(([k]) => k);
        const mergedSecrets = { ...currentSecrets, ...updates };
        for (const key of deletedKeys) {
            delete mergedSecrets[key];
        }
        const encrypted = auth.encryptSecrets(mergedSecrets);

        if (existing.length > 0) {
            await db.update(schema.secrets).set({ encryptedData: encrypted }).where(eq(schema.secrets.userId, request.user.id));
        } else {
            await db.insert(schema.secrets).values({ userId: request.user.id, encryptedData: encrypted });
        }
        return { success: true, secrets: mergedSecrets };
    } catch (e) {
        request.log.error(e);
        return reply.code(500).send({ error: t('errors:save_secrets_failed', { defaultValue: 'Failed to save secrets' }, request.locale || 'en'), code: 'save_secrets_failed' });
    }
});

// ── BYOK (Bring Your Own Key) field definitions and config ──

fastify.get('/api/v1/agents/:agentId/byok-fields', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const { agentId } = request.params;
    const { BYOK_FIELDS } = require('./agents/byokFields');
    const entry = BYOK_FIELDS[agentId];
    return entry ? { description: entry.description, fields: entry.fields } : { description: '', fields: [] };
});

fastify.get('/api/v1/agents/:agentId/byok-config', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const { agentId } = request.params;
    const { getByokFieldValues } = require('./agents/byokFields');
    const { getUserSecrets } = require('./agents/agentEnv');
    const secrets = await getUserSecrets(request.user.id);
    return getByokFieldValues(agentId, secrets);
});

fastify.put('/api/v1/agents/:agentId/byok-config', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const { agentId } = request.params;
    const body = request.body || {};
    const values = body.values || body;
    const { BYOK_FIELDS, applyByokToSecrets } = require('./agents/byokFields');

    const entry = BYOK_FIELDS[agentId];
    const fields = entry?.fields;
    if (!fields) return reply.code(404).send({ error: t('errors:no_byok_fields', { defaultValue: 'No BYOK fields for this agent' }, request.locale || 'en'), code: 'no_byok_fields' });

    const missing = fields
        .filter((f) => f.required && !String(values[f.key] ?? '').trim())
        .map((f) => f.key);
    if (missing.length) {
        return reply.code(400).send({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    try {
        const existing = await db.select().from(schema.secrets).where(eq(schema.secrets.userId, request.user.id));
        let currentSecrets = {};
        if (existing.length > 0) {
            currentSecrets = auth.decryptSecrets(existing[0].encryptedData);
        }
        const updatedSecrets = applyByokToSecrets(agentId, values, currentSecrets);
        const encrypted = auth.encryptSecrets(updatedSecrets);

        if (existing.length > 0) {
            await db.update(schema.secrets).set({ encryptedData: encrypted }).where(eq(schema.secrets.userId, request.user.id));
        } else {
            await db.insert(schema.secrets).values({ userId: request.user.id, encryptedData: encrypted });
        }
        return { success: true };
    } catch (e) {
        request.log.error(e);
        return reply.code(500).send({ error: t('errors:save_byok_failed', { defaultValue: 'Failed to save BYOK config' }, request.locale || 'en'), code: 'save_byok_failed' });
    }
});

fastify.delete('/api/v1/agents/:agentId/byok-config', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const { agentId } = request.params;
    const { removeByokFromSecrets, byokStorageKey } = require('./agents/byokFields');

    try {
        const existing = await db.select().from(schema.secrets).where(eq(schema.secrets.userId, request.user.id));
        if (existing.length === 0) return { success: true };
        const currentSecrets = auth.decryptSecrets(existing[0].encryptedData);
        if (!currentSecrets[byokStorageKey(agentId)]) return { success: true };
        const updatedSecrets = removeByokFromSecrets(agentId, currentSecrets);
        const encrypted = auth.encryptSecrets(updatedSecrets);
        await db.update(schema.secrets).set({ encryptedData: encrypted }).where(eq(schema.secrets.userId, request.user.id));
        return { success: true };
    } catch (e) {
        request.log.error(e);
        return reply.code(500).send({ error: t('errors:delete_byok_failed', { defaultValue: 'Failed to delete BYOK config' }, request.locale || 'en'), code: 'delete_byok_failed' });
    }
});

const DEFAULT_AGENT_ID = 'kimi-code';

fastify.get('/api/v1/agents', { preValidation: [fastify.authenticate] }, async (request) => {
    const agentGatewayConfig = require('./admin/AgentGatewayConfig');
    const installedAgents = require('./agents/installedAgents');
    const grantedIds = await policy.listGrantedAgentIds(request.user.id, request.user.role);
    const grantedSet = new Set(grantedIds);
    const allAgents = await installedAgents.listInstalledAgentRows();
    // Hide agents that don't support gateway mode yet
    const HIDDEN_AGENTS = new Set(['cursor', 'amp', 'commandcode', 'minimax-cli']);
    const visibleAgents = allAgents.filter((a) => !HIDDEN_AGENTS.has(a.id));
    const filtered = request.user.role === 'admin'
        ? visibleAgents
        : visibleAgents.filter((a) => grantedSet.has(a.id));
    filtered.sort((a, b) => {
        if (a.id === DEFAULT_AGENT_ID) return -1;
        if (b.id === DEFAULT_AGENT_ID) return 1;
        return a.name.localeCompare(b.name);
    });
    const gatewayConfigs = await agentGatewayConfig.getAll();
    const { computeEffectiveRequired } = require('./agents/agentEnv');
    return filtered.map((a) => {
        const cfg = gatewayConfigs[a.id];
        const authMode = cfg?.llm_auth_mode === 'gateway' || cfg?.llm_auth_mode === 'byok'
            ? cfg.llm_auth_mode
            : 'byok';
        const fullRequired = JSON.parse(a.envRequired);
        const effectiveRequired = computeEffectiveRequired(fullRequired, cfg);
        return {
            ...formatAgentRow(a),
            env_required: effectiveRequired,
            llm_auth_mode: authMode,
            gateway_model: agentGatewayConfig.primaryModel(cfg) || null,
        };
    });
});

fastify.get('/api/v1/events', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    reply.raw.write(': ok\n\n');
    addSseClient(reply.raw, request.user.id);
    const heartbeat = setInterval(() => {
        try { reply.raw.write(': heartbeat\n\n'); } catch (_) { clearInterval(heartbeat); }
    }, 30000);
    request.raw.on('close', () => clearInterval(heartbeat));
});

fastify.post('/api/v1/agents', { preValidation: [fastify.authenticate, fastify.requireAdmin] }, async (request, reply) => {
    const { id, name, cmd, args, env_required } = request.body;
    try {
        await db.insert(schema.agents).values({
            id, name, cmd,
            args: JSON.stringify(args || []),
            envRequired: JSON.stringify(env_required || [])
        });
        return { success: true };
    } catch (e) {
        return reply.code(400).send({ error: t('errors:agent_insert_failed', { defaultValue: 'Failed to insert agent or ID already exists' }, request.locale || 'en'), code: 'agent_insert_failed' });
    }
});

fastify.put('/api/v1/agents/:id', { preValidation: [fastify.authenticate, fastify.requireAdmin] }, async (request, reply) => {
    const { name, cmd, args, env_required } = request.body || {};
    const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, request.params.id));
    if (rows.length === 0) return reply.code(404).send({ error: t('errors:agent_not_found', {}, request.locale || 'en'), code: 'agent_not_found' });
    await db.update(schema.agents).set({
        ...(name !== undefined && { name }),
        ...(cmd !== undefined && { cmd }),
        ...(args !== undefined && { args: JSON.stringify(args) }),
        ...(env_required !== undefined && { envRequired: JSON.stringify(env_required) }),
    }).where(eq(schema.agents.id, request.params.id));
    return { success: true };
});

fastify.delete('/api/v1/agents/:id', { preValidation: [fastify.authenticate, fastify.requireAdmin] }, async (request, reply) => {
    const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, request.params.id));
    if (rows.length === 0) return reply.code(404).send({ error: t('errors:agent_not_found', {}, request.locale || 'en'), code: 'agent_not_found' });
    await db.delete(schema.userAgentGrants).where(eq(schema.userAgentGrants.agentId, request.params.id));
    await db.delete(schema.agents).where(eq(schema.agents.id, request.params.id));
    return { ok: true };
});

// Projects — list
fastify.get('/api/v1/projects', { preValidation: [fastify.authenticate] }, async (request) => {
    const rows = await db.select().from(schema.projects)
        .where(eq(schema.projects.userId, request.user.id));
    return rows
        .map((p) => ({
            id: p.id,
            name: p.name,
            default_runtime_id: p.defaultRuntimeId,
            repo_provider: p.repoProvider || 'none',
            repo_url: p.repoUrl || null,
            repo_default_branch: p.repoDefaultBranch || 'main',
            workspace_mode: p.workspaceMode || 'local',
            last_sync_sha: p.lastSyncSha || null,
            last_snapshot_id: p.lastSnapshotId || null,
            dev_profile_id: p.devProfileId || null,
            current_branch: p.currentBranch || null,
            github_full_name: p.githubFullName || p.remoteFullName || null,
            clone_status: p.repoProvider && p.repoProvider !== 'none' ? (p.cloneStatus || 'pending') : null,
            clone_error: p.cloneError || null,
            created_at: p.createdAt,
        }))
        .sort((a, b) => b.created_at - a.created_at);
});

// Projects — create（通过 RuntimeProvider.ensureReady 创建 workspace）
fastify.post('/api/v1/projects', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const quotaCheck = await policy.checkQuota(request.user.id, 'projects', request.user.role);
    if (!quotaCheck.ok) return policy.quotaErrorReply(reply, quotaCheck);

    const name = String(request.body?.name || '').trim();
    if (!name) return reply.code(400).send({ error: t('errors:project_name_required', { defaultValue: 'Project name is required' }, request.locale || 'en'), code: 'project_name_required' });
    if (name.length > 120) return reply.code(400).send({ error: t('errors:project_name_too_long', { defaultValue: 'Project name is too long' }, request.locale || 'en'), code: 'project_name_too_long' });

    const projectId = `proj_${crypto.randomBytes(8).toString('hex')}`;
    const createdAt = Date.now();

    let workspacePath;
    let defaultRuntimeId;
    try {
        await db.insert(schema.projects).values({
            id: projectId,
            userId: request.user.id,
            name,
            serverPath: '',
            cloneStatus: null,
            createdAt,
        });
        // Do not provision a runtime/VM yet: the agent image is unknown at creation
        // time, so eagerly provisioning would pin the default runtime to box-base and
        // force a delete+rebuild (losing state) on the first agent session. The default
        // runtime is created lazily on first session start with the correct agent image.
        const workspace = require('./workspace');
        workspacePath = workspace.createProjectDirectory(request.user.id, projectId);
        await db.update(schema.projects)
            .set({ serverPath: workspacePath })
            .where(eq(schema.projects.id, projectId));
        defaultRuntimeId = null;
    } catch (err) {
        request.log.error(err);
        await db.delete(schema.projects).where(eq(schema.projects.id, projectId)).catch(() => {});
        return reply.code(500).send({ error: t('errors:create_project_dir_failed', { defaultValue: 'Failed to create project directory' }, request.locale || 'en'), code: 'create_project_dir_failed' });
    }

    // Initialize built-in Git repo (Layer 1) for the new project
    try {
        const _localGitSid = request.query?.session_id || request.body?.session_id;
    const localGit = new LocalGitService({ runtimeId: _localGitSid ? await resolveRuntimeIdFromSession(request.user.id, _localGitSid) : null });
        const fullProject = { id: projectId, userId: request.user.id };
        await localGit.initRepo(fullProject);
    } catch (err) {
        request.log.warn({ err, projectId }, 'Local git init failed (non-fatal)');
    }

    return {
        id: projectId,
        name,
        default_runtime_id: defaultRuntimeId,
        created_at: createdAt,
    };
});

// Repository environment — 外部 Git provider 绑定与工程环境元数据
fastify.delete('/api/v1/projects/:projectId', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    try {
        await deleteProjectForUser(request.user.id, project, { log: request.log });
        return { ok: true };
    } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: t('errors:delete_project_failed', { defaultValue: 'Failed to delete project' }, request.locale || 'en'), code: 'delete_project_failed' });
    }
});

fastify.patch('/api/v1/projects/:projectId', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const name = String(request.body?.name || '').trim();
    if (!name) return reply.code(400).send({ error: t('errors:project_name_required', { defaultValue: 'Project name is required' }, request.locale || 'en'), code: 'project_name_required' });
    if (name.length > 120) return reply.code(400).send({ error: t('errors:project_name_too_long', { defaultValue: 'Project name is too long' }, request.locale || 'en'), code: 'project_name_too_long' });

    await db.update(schema.projects)
        .set({ name })
        .where(eq(schema.projects.id, project.id));

    invalidateProjectCache(project.id);

    return { id: project.id, name };
});

fastify.get('/api/v1/projects/:projectId/repository', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
    return repositoryEnvironment.formatRepository(project);
});

fastify.put('/api/v1/projects/:projectId/repository', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
    return repositoryEnvironment.updateRepository(project, request.body || {});
});

fastify.get('/api/v1/projects/:projectId/dev-profile', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
    return { profile: await repositoryEnvironment.getDevProfile(project) };
});

fastify.put('/api/v1/projects/:projectId/dev-profile', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
    return repositoryEnvironment.upsertDevProfile(project, request.body || {});
});

fastify.get('/api/v1/projects/:projectId/repo-snapshots', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
    return repositoryEnvironment.listSnapshots(project.id);
});

fastify.post('/api/v1/projects/:projectId/repo-snapshots', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
    const snapshot = await repositoryEnvironment.createSnapshot(project, request.body || {});
    return reply.code(201).send(snapshot);
});

fastify.get('/api/v1/projects/:projectId/checkpoints', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
    return repositoryEnvironment.listCheckpoints(project.id);
});

fastify.post('/api/v1/projects/:projectId/checkpoints', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const sessionId = request.body?.session_id || request.body?.sessionId;
    if (sessionId) {
        const rows = await db.select().from(schema.sessions)
            .where(and(
                eq(schema.sessions.id, sessionId),
                eq(schema.sessions.userId, request.user.id),
                eq(schema.sessions.projectId, project.id),
            ));
        if (rows.length === 0) return reply.code(404).send({ error: t('errors:session_not_found', {}, request.locale || 'en'), code: 'session_not_found' });
    }

    // Use LocalGitService for git-mode projects to execute real git commit
    let checkpoint;
    if (project.workspaceMode === 'git') {
        try {
            const _localGitSid = request.query?.session_id || request.body?.session_id;
    const localGit = new LocalGitService({ runtimeId: _localGitSid ? await resolveRuntimeIdFromSession(request.user.id, _localGitSid) : null });
            const meta = {
                sessionId: sessionId || null,
                trigger: request.body?.trigger || 'manual',
                summary: request.body?.summary || '',
                userId: request.user.id,
            };
            checkpoint = await localGit.commitCheckpoint(project, meta);
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: t('errors:create_checkpoint_failed', { defaultValue: 'Failed to create git checkpoint' }, request.locale || 'en'), code: 'create_checkpoint_failed' });
        }
    } else {
        checkpoint = await repositoryEnvironment.createCheckpoint(project, request.body || {}, request.user.id);
    }

    // BoxLite/Blink 持久化：创建 blink checkpoint（VM 磁盘快照），记录到 storageRef
    const PROVIDER_NOW = resolveRuntimeProvider();
    if (PROVIDER_NOW === 'boxlite') {
        try {
            const _sessionId = request.query?.session_id || request.body?.session_id;
        const _runtimeId = _sessionId ? await resolveRuntimeIdFromSession(request.user.id, _sessionId) : null;
        const ready = await ensureProjectRuntime(project, _runtimeId ? { runtimeId: _runtimeId } : {});
            const ref = ready.runtime && ready.runtime.runtimeRef;
            const rtNow = getRuntime();
            if (ref && typeof rtNow.provider.checkpoint === 'function') {
                const snapName = (checkpoint && checkpoint.id) || `ckpt_${Date.now().toString(36)}`;
                await rtNow.provider.checkpoint(ref, snapName);
                await db.update(schema.workspaceCheckpoints)
                    .set({ storageRef: `blink:${snapName}` })
                    .where(eq(schema.workspaceCheckpoints.id, (checkpoint && checkpoint.id) || snapName));
                if (checkpoint) {
                    checkpoint.storage_ref = `blink:${snapName}`;
                }
            }
        } catch (e) {
            request.log.warn(e, '[boxlite] blink checkpoint best-effort failed');
        }
    }

    return reply.code(201).send(checkpoint);
});

// Restore checkpoint
fastify.post('/api/v1/projects/:projectId/checkpoints/:checkpointId/restore', {
    preValidation: [fastify.authenticate],
}, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const ckId = request.params.checkpointId;
    const ckRows = await db.select().from(schema.workspaceCheckpoints)
        .where(and(
            eq(schema.workspaceCheckpoints.id, ckId),
            eq(schema.workspaceCheckpoints.projectId, project.id),
        ));
    const ck = ckRows[0] || null;

    // BoxLite 优先使用 blink restore（VM 快照）
    const PROVIDER_NOW = resolveRuntimeProvider();
    if (PROVIDER_NOW === 'boxlite') {
        try {
            const _sessionId = request.query?.session_id || request.body?.session_id;
        const _runtimeId = _sessionId ? await resolveRuntimeIdFromSession(request.user.id, _sessionId) : null;
        const ready = await ensureProjectRuntime(project, _runtimeId ? { runtimeId: _runtimeId } : {});
            const ref = ready.runtime && ready.runtime.runtimeRef;
            const rtNow = getRuntime();
            let snap = ckId;
            if (ck && ck.storageRef && ck.storageRef.startsWith('blink:')) {
                snap = ck.storageRef.slice(6);
            }
            if (ref && typeof rtNow.provider.restore === 'function') {
                await rtNow.provider.restore(ref, snap);
                await recordEvent({
                    userId: request.user.id,
                    projectId: project.id,
                    subjectType: 'workspace_checkpoint',
                    subjectId: ckId,
                    type: 'workspace_checkpoint.restored',
                    data: { provider: 'boxlite', snap },
                });
                return { id: ckId, restored: true, provider: 'boxlite' };
            }
        } catch (e) {
            request.log.warn(e, '[boxlite] blink restore failed, fallback to git');
        }
    }

    const _localGitSid = request.query?.session_id || request.body?.session_id;
    const localGit = new LocalGitService({ runtimeId: _localGitSid ? await resolveRuntimeIdFromSession(request.user.id, _localGitSid) : null });
    try {
        const result = await localGit.restoreCheckpoint(
            project,
            ckId,
            { cleanUntracked: request.body?.clean_untracked !== false },
        );
        return result;
    } catch (err) {
        request.log.error(err);
        return sendPublicError(reply, err, 'Git operation failed', 500);
    }
});

// Repository log
fastify.get('/api/v1/projects/:projectId/repository/log', {
    preValidation: [fastify.authenticate, fastify.requireActive],
}, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const _localGitSid = request.query?.session_id || request.body?.session_id;
    const localGit = new LocalGitService({ runtimeId: _localGitSid ? await resolveRuntimeIdFromSession(request.user.id, _localGitSid) : null });
    try {
        const count = request.query?.count ? Number(request.query.count) : 20;
        const log = await localGit.getLog(project, { count });
        return { commits: log };
    } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: t('errors:get_repo_log_failed', { defaultValue: 'Failed to get repository log' }, request.locale || 'en'), code: 'get_repo_log_failed' });
    }
});

// Checkpoint diff
fastify.get('/api/v1/projects/:projectId/checkpoints/:checkpointId/diff', {
    preValidation: [fastify.authenticate],
}, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const rows = await db.select().from(schema.workspaceCheckpoints)
        .where(and(
            eq(schema.workspaceCheckpoints.id, request.params.checkpointId),
            eq(schema.workspaceCheckpoints.projectId, project.id),
        ));
    if (rows.length === 0) return reply.code(404).send({ error: t('errors:checkpoint_not_found', { defaultValue: 'Checkpoint not found' }, request.locale || 'en'), code: 'checkpoint_not_found' });

    const checkpoint = rows[0];
    if (!checkpoint.gitSha) return reply.code(409).send({ error: 'Checkpoint has no git_sha' });

    const _localGitSid = request.query?.session_id || request.body?.session_id;
    const localGit = new LocalGitService({ runtimeId: _localGitSid ? await resolveRuntimeIdFromSession(request.user.id, _localGitSid) : null });
    try {
        const full = request.query?.full === 'true';
        const result = await localGit.getDiff(project, checkpoint.gitSha, { full });
        return result;
    } catch (err) {
        request.log.error(err);
        return sendPublicError(reply, err, 'Git operation failed', 500);
    }
});

// ── Phase 4: Advanced Git APIs ──

// Git blame
fastify.get('/api/v1/projects/:projectId/repository/blame', {
    preValidation: [fastify.authenticate, fastify.requireActive],
}, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const { path: filePath, ref, start_line, end_line } = request.query || {};
    if (!filePath) return reply.code(400).send({ error: t('errors:path_required', { defaultValue: 'path query parameter is required' }, request.locale || 'en'), code: 'path_required' });

    const _localGitSid = request.query?.session_id || request.body?.session_id;
    const localGit = new LocalGitService({ runtimeId: _localGitSid ? await resolveRuntimeIdFromSession(request.user.id, _localGitSid) : null });
    try {
        const entries = await localGit.blame(project, filePath, {
            ref,
            startLine: start_line ? Number(start_line) : undefined,
            endLine: end_line ? Number(end_line) : undefined,
        });
        return { path: filePath, ref: ref || 'HEAD', entries };
    } catch (err) {
        request.log.error(err);
        return sendPublicError(reply, err, 'Git operation failed', 500);
    }
});

// Detailed commit log (with files changed, author info)
fastify.get('/api/v1/projects/:projectId/repository/log/detailed', {
    preValidation: [fastify.authenticate, fastify.requireActive],
}, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const _localGitSid = request.query?.session_id || request.body?.session_id;
    const localGit = new LocalGitService({ runtimeId: _localGitSid ? await resolveRuntimeIdFromSession(request.user.id, _localGitSid) : null });
    try {
        const count = request.query?.count ? Number(request.query.count) : 20;
        const filePath = request.query?.path || undefined;
        const commits = await localGit.logDetailed(project, { count, path: filePath });
        return { commits };
    } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to get detailed log' });
    }
});

// Get files changed in a specific commit
fastify.get('/api/v1/projects/:projectId/repository/commit/:sha/files', {
    preValidation: [fastify.authenticate, fastify.requireActive],
}, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const _localGitSid = request.query?.session_id || request.body?.session_id;
    const localGit = new LocalGitService({ runtimeId: _localGitSid ? await resolveRuntimeIdFromSession(request.user.id, _localGitSid) : null });
    try {
        const files = await localGit.getCommitFiles(project, request.params.sha);
        return { files };
    } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to get commit files' });
    }
});

// Commit graph log with tree structure and branch refs
fastify.get('/api/v1/projects/:projectId/repository/files', {
    preValidation: [fastify.authenticate, fastify.requireActive],
}, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const _localGitSid = request.query?.session_id || request.body?.session_id;
    const localGit = new LocalGitService({ runtimeId: _localGitSid ? await resolveRuntimeIdFromSession(request.user.id, _localGitSid) : null });
    try {
        const files = await localGit.listTrackedFiles(project);
        return { files };
    } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to list files' });
    }
});

fastify.get('/api/v1/projects/:projectId/repository/log/graph', {
    preValidation: [fastify.authenticate, fastify.requireActive],
}, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const _localGitSid = request.query?.session_id || request.body?.session_id;
    const localGit = new LocalGitService({ runtimeId: _localGitSid ? await resolveRuntimeIdFromSession(request.user.id, _localGitSid) : null });
    try {
        const count = request.query?.count ? Number(request.query.count) : 20;
        const commits = await localGit.logGraph(project, { count });
        return { commits };
    } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to get graph log' });
    }
});

// Conflict check (dry-run merge to detect conflicts)
fastify.get('/api/v1/projects/:projectId/repository/conflict-check', {
    preValidation: [fastify.authenticate, fastify.requireActive],
}, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const targetBranch = request.query?.target || project.repoDefaultBranch || 'main';
    const _localGitSid = request.query?.session_id || request.body?.session_id;
    const localGit = new LocalGitService({ runtimeId: _localGitSid ? await resolveRuntimeIdFromSession(request.user.id, _localGitSid) : null });
    try {
        const result = await localGit.conflictCheck(project, targetBranch);
        return { target_branch: targetBranch, ...result };
    } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to check conflicts' });
    }
});

// List conflict files (working tree)
fastify.get('/api/v1/projects/:projectId/repository/conflicts', {
    preValidation: [fastify.authenticate, fastify.requireActive],
}, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const _localGitSid = request.query?.session_id || request.body?.session_id;
    const localGit = new LocalGitService({ runtimeId: _localGitSid ? await resolveRuntimeIdFromSession(request.user.id, _localGitSid) : null });
    try {
        const conflicts = await localGit.listConflicts(project);
        return { conflicts };
    } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to list conflicts' });
    }
});

// Resolve a conflict file
fastify.post('/api/v1/projects/:projectId/repository/conflicts/resolve', {
    preValidation: [fastify.authenticate, fastify.requireActive],
}, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const { path: filePath, strategy } = request.body || {};
    if (!filePath) return reply.code(400).send({ error: t('errors:path_required', { defaultValue: 'path is required' }, request.locale || 'en'), code: 'path_required' });
    if (!strategy || !['ours', 'theirs', 'manual'].includes(strategy)) {
        return reply.code(400).send({ error: 'strategy must be ours, theirs, or manual' });
    }

    const _localGitSid = request.query?.session_id || request.body?.session_id;
    const localGit = new LocalGitService({ runtimeId: _localGitSid ? await resolveRuntimeIdFromSession(request.user.id, _localGitSid) : null });
    try {
        const result = await localGit.resolveConflict(project, filePath, strategy);
        return result;
    } catch (err) {
        request.log.error(err);
        return sendPublicError(reply, err, 'Git operation failed', 500);
    }
});

// Show file content at a specific ref (for conflict side-by-side view)
fastify.get('/api/v1/projects/:projectId/repository/file', {
    preValidation: [fastify.authenticate, fastify.requireActive],
}, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const { path: filePath, ref } = request.query || {};
    if (!filePath) return reply.code(400).send({ error: t('errors:path_required', { defaultValue: 'path query parameter is required' }, request.locale || 'en'), code: 'path_required' });

    const _localGitSid = request.query?.session_id || request.body?.session_id;
    const localGit = new LocalGitService({ runtimeId: _localGitSid ? await resolveRuntimeIdFromSession(request.user.id, _localGitSid) : null });
    try {
        const result = await localGit.showFile(project, filePath, ref || 'HEAD');
        return result;
    } catch (err) {
        request.log.error(err);
        return sendPublicError(reply, err, 'Git operation failed', 500);
    }
});

// PR/MR Reviews / Comments / Files routes have been migrated to routes/git.js
// (using MergeRequestService with requireActive guard).
// The inline implementations below were removed to eliminate duplication.

// Sessions - list
function conversationStats(turns, summary) {
    if (turns == null) return null;
    const list = Array.isArray(turns) ? turns : [];
    let filesTouched = 0;
    if (Array.isArray(summary?.filesTouched)) filesTouched = summary.filesTouched.length;
    const timestamps = list
        .map((t) => (t && typeof t.ts === 'number' && Number.isFinite(t.ts) ? t.ts : null))
        .filter((ts) => ts != null);
    let durationMs = null;
    if (timestamps.length >= 2) {
        durationMs = Math.max(0, Math.max(...timestamps) - Math.min(...timestamps));
    }
    return { turnCount: list.length, filesTouched, durationMs };
}

function mapSessionRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        agentId: row.agent_id,
        status: row.status,
        recoverable: Boolean(row.recoverable),
        customImageId: row.custom_image_id || null,
        provisioningError: row.provisioning_error || null,
        shellOnly: row.agent_id === 'shell' || undefined,
        memoryStatus: sessionManager.getSession(row.id)?.status ?? row.status,
        alive: sessionManager.isAlive(row.id),
        projectName: row.project_id ? row.project_name : null,
        title: row.title || null,
        titleManual: Boolean(row.title_manual),
        createdAt: Number(row.created_at),
        exitCode: row.exit_code ?? sessionManager.getSession(row.id)?.exitCode ?? null,
        exitedAt: row.exited_at ? Number(row.exited_at) : null,
        updatedAt: null,
    };
}

const SESSION_LIST_SORT_WHITELIST = {
    'created_at:desc': 's.created_at DESC, s.id DESC',
    'created_at:asc': 's.created_at ASC, s.id ASC',
};

fastify.get('/api/v1/sessions', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const query = request.query || {};
    const hasQuery = ['status', 'agentId', 'projectId', 'q', 'page', 'pageSize', 'sort', 'withStats']
        .some((key) => query[key] !== undefined && query[key] !== '');

    // Backward-compatible fast path: no query params → existing response shape.
    if (!hasQuery) {
        const result = await db.execute(sql`
            SELECT s.id, s.project_id, s.agent_id, s.status, s.recoverable,
                   s.custom_image_id, s.title, s.title_manual, s.created_at,
                   s.exit_code, s.exited_at,
                   p.name AS project_name,
                   s.provisioning_error
            FROM sessions s
            LEFT JOIN projects p ON p.id = s.project_id
            WHERE s.user_id = ${request.user.id}
        `);
        const rawRows = result.rows || result;
        return rawRows.map(mapSessionRow);
    }

    const withStats = query.withStats === 'true' || query.withStats === '1';
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize, 10) || 20));
    const sortKey = String(query.sort || 'created_at:desc');
    const orderBy = SESSION_LIST_SORT_WHITELIST[sortKey] || SESSION_LIST_SORT_WHITELIST['created_at:desc'];

    const filters = [];
    if (query.status) filters.push(sql`s.status = ${String(query.status)}`);
    if (query.agentId) filters.push(sql`s.agent_id = ${String(query.agentId)}`);
    if (query.projectId) filters.push(sql`s.project_id = ${String(query.projectId)}`);
    const hasSearch = Boolean(query.q);
    if (hasSearch) {
        const escaped = String(query.q).replace(/[\\%_]/g, (m) => `\\${m}`);
        filters.push(sql`(s.title ILIKE ${`%${escaped}%`} OR s.agent_id ILIKE ${`%${escaped}%`} OR sc.summary::text ILIKE ${`%${escaped}%`})`);
    }
    const whereClause = sql`WHERE s.user_id = ${request.user.id}${filters.length ? sql` AND ${sql.join(filters, sql` AND `)}` : sql``}`;

    const statsSelect = withStats
        ? sql`, sc.turns AS conversation_turns, sc.summary AS conversation_summary`
        : sql``;
    // withStats 或搜索时都需 join session_conversations（搜索命中 summary 字段）
    const statsJoin = (withStats || hasSearch)
        ? sql`LEFT JOIN session_conversations sc ON sc.session_id = s.id`
        : sql``;

    const listResult = await db.execute(sql`
        SELECT s.id, s.project_id, s.agent_id, s.status, s.recoverable,
               s.custom_image_id, s.title, s.title_manual, s.created_at,
               s.exit_code, s.exited_at,
               p.name AS project_name, s.provisioning_error
               ${statsSelect}
        FROM sessions s
        LEFT JOIN projects p ON p.id = s.project_id
        ${statsJoin}
        ${whereClause}
        ORDER BY ${sql.raw(orderBy)}
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `);
    const countResult = await db.execute(sql`
        SELECT COUNT(*)::int AS total
        FROM sessions s
        ${statsJoin}
        ${whereClause}
    `);

    const rows = listResult.rows || listResult;
    const total = Number(countResult.rows?.[0]?.total ?? countResult[0]?.total ?? 0);

    const items = rows.map((row) => {
        const item = mapSessionRow(row);
        if (withStats) {
            item.stats = conversationStats(row.conversation_turns, row.conversation_summary);
        }
        return item;
    });

    return { items, total, page, pageSize };
});

// Rename a session — sets titleManual=true so AI auto-naming never overwrites it.
// Sending an empty title clears the title but keeps titleManual=true (user explicitly cleared it).
fastify.patch('/api/v1/sessions/:sessionId/title', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
    const { sessionId } = request.params;
    const rows = await db.select().from(schema.sessions)
        .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, request.user.id)));
    if (rows.length === 0) return reply.code(404).send({ error: t('errors:session_not_found', {}, request.locale || 'en'), code: 'session_not_found' });

    const rawTitle = String(request.body?.title ?? '').trim();
    if (rawTitle.length > 80) {
        return reply.code(400).send({ error: 'Title too long (max 80 characters)', code: 'title_too_long' });
    }

    const title = rawTitle || null;
    await db.update(schema.sessions)
        .set({ title, titleManual: true })
        .where(eq(schema.sessions.id, sessionId));

    try {
        const { broadcastSse } = require('./session/sseManager');
        broadcastSse({ type: 'session_title', sessionId, title, userId: request.user.id });
    } catch (_) {}

    return { ok: true, sessionId, title, titleManual: true };
});

const conversationRefreshInFlight = new Map();

fastify.get('/api/v1/sessions/:sessionId/conversation', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
    const { sessionId } = request.params;
    const rows = await db.select().from(schema.sessions)
        .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, request.user.id)));
    if (rows.length === 0) return reply.code(404).send({ error: t('errors:session_not_found', {}, request.locale || 'en'), code: 'session_not_found' });

    const { getConversation } = require('./session/conversationSummaryService');
    const offset = Math.max(0, Number.parseInt(request.query?.offset, 10) || 0);
    const limitRaw = request.query?.limit != null ? Number.parseInt(request.query.limit, 10) : null;
    const limit = limitRaw == null || Number.isNaN(limitRaw) ? null : Math.min(200, Math.max(1, limitRaw));
    const view = await getConversation(sessionId, { offset, limit });
    if (!view) return reply.code(404).send({ code: 'conversation_not_found' });
    return view;
});

fastify.post('/api/v1/sessions/:sessionId/conversation/refresh', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
    const { sessionId } = request.params;
    const rows = await db.select().from(schema.sessions)
        .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, request.user.id)));
    if (rows.length === 0) return reply.code(404).send({ error: t('errors:session_not_found', {}, request.locale || 'en'), code: 'session_not_found' });

    if (conversationRefreshInFlight.has(sessionId)) {
        return reply.code(409).send({ code: 'refresh_in_progress' });
    }

    const { summarizeSession } = require('./session/conversationSummaryService');
    const { LlmRequestError } = require('./llm/analyzeClient');

    const promise = summarizeSession(sessionId, { force: true })
        .catch((err) => {
            if (err?.code === 'llm_not_configured') {
                return reply.code(503).send({ code: 'llm_not_configured' });
            }
            if (err instanceof LlmRequestError || err?.code === 'llm_request_failed') {
                return reply.code(502).send({ code: 'llm_request_failed' });
            }
            if (err?.code === 'no_content') {
                return reply.code(422).send({ code: 'no_content' });
            }
            request.log.error(err, '[conversation] refresh failed');
            return reply.code(500).send({ error: 'Failed to refresh conversation summary' });
        })
        .finally(() => {
            conversationRefreshInFlight.delete(sessionId);
        });

    conversationRefreshInFlight.set(sessionId, promise);
    return promise;
});

fastify.post('/api/v1/sessions/:sessionId/stop', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params;
    const rows = await db.select().from(schema.sessions)
        .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, request.user.id)));
    if (rows.length === 0) return reply.code(404).send({ error: t('errors:session_not_found', {}, request.locale || 'en'), code: 'session_not_found' });

    const session = rows[0];
    if (session.status === 'idle') {
        return {
            ok: true,
            session_id: sessionId,
            status: 'idle',
            recoverable: Boolean(session.recoverable),
        };
    }
    if (session.status === 'exited') {
        return reply.code(409).send({ error: 'Session has already ended' });
    }

    try {
        const result = await stopSession({
            db,
            schema,
            runtime,
            sessionManager,
            session,
            fastifyLog: request.log,
        });
        if (!result.stopped) {
            const message = result.reason === 'not_alive'
                ? 'Session is not running'
                : 'Failed to stop session';
            return reply.code(result.reason === 'not_alive' ? 409 : 500).send({ error: message });
        }
        return {
            ok: true,
            session_id: sessionId,
            status: result.status || 'idle',
            recoverable: Boolean(session.recoverable),
        };
    } catch (err) {
        request.log.error(err, '[sessions] stop failed');
        return reply.code(500).send({ error: 'Failed to stop session' });
    }
});

fastify.get('/api/v1/sessions/:sessionId/transcript', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params;
    const parsedAfter = Number(request.query?.after);
    const after = Number.isFinite(parsedAfter) && parsedAfter >= 0 ? parsedAfter : 0;

    const rows = await db.select().from(schema.sessions)
        .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, request.user.id)));
    if (rows.length === 0) return reply.code(404).send({ error: t('errors:session_not_found', {}, request.locale || 'en'), code: 'session_not_found' });

    const session = rows[0];
    if (session.status !== 'idle' && session.status !== 'exited') {
        return reply.code(409).send({ error: 'Transcript replay is only available for stopped sessions' });
    }

    const transcriptRows = await db.select().from(schema.sessionStreams)
        .where(eq(schema.sessionStreams.sessionId, sessionId));
    const transcriptRef = transcriptRows[0]?.storageRef || session.streamRef || null;
    if (!transcriptRef) {
        return { session_id: sessionId, after, output: '', head: 0, truncated: false };
    }

    let frames;
    let truncated = false;
    if (after > 0) {
        frames = transcriptStore.readFrom(transcriptRef, after);
    } else {
        const tail = transcriptStore.readTail(transcriptRef);
        frames = tail.frames;
        truncated = tail.omittedCount > 0;
    }

    let output = '';
    if (truncated) {
        output += '\x1b[33m[Earlier messages truncated. Full history is preserved.]\x1b[0m\r\n';
    }
    output += frames
        .filter((frame) => frame.kind === 'out' || frame.kind === 'in')
        .map((frame) => (typeof frame.data === 'string' ? frame.data : ''))
        .join('');

    return {
        session_id: sessionId,
        after,
        output,
        head: transcriptStore.head(transcriptRef),
        truncated,
    };
});

fastify.get('/api/v1/sessions/:sessionId/chat', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params;
    const rows = await db.select().from(schema.sessions)
        .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, request.user.id)));
    if (rows.length === 0) return reply.code(404).send({ error: t('errors:session_not_found', {}, request.locale || 'en'), code: 'session_not_found' });

    return {
        session_id: sessionId,
        messages: await chatTranscript.getHistory(sessionId),
    };
});

fastify.delete('/api/v1/sessions/:sessionId', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params;
    const rows = await db.select().from(schema.sessions)
        .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, request.user.id)));
    if (rows.length === 0) return reply.code(404).send({ error: t('errors:session_not_found', {}, request.locale || 'en'), code: 'session_not_found' });

    const session = rows[0];

    // Mark exited first so in-flight provisioning observes cancellation.
    await db.update(schema.sessions)
        .set({ status: 'exited', exitedAt: Date.now() })
        .where(eq(schema.sessions.id, sessionId));

    const live = sessionManager.getSession(sessionId);
    if (live?.handle) {
        try { live.handle.kill(); } catch (err) {
            request.log.warn({ err, sessionId }, '[sessions] failed to kill live handle on delete');
        }
        const runtimeRef = live.runtimeRef || live.runtimeId || null;
        if (runtimeRef) {
            await waitForAgentExit(runtime, runtimeRef, live.agentId || session.agentId).catch(() => {});
        }
    } else if (session.status === 'running' || session.status === 'idle' || session.status === 'pending') {
        let runtimeRef = null;
        if (session.runtimeId) {
            try {
                const runtimeRows = await db.select().from(schema.runtimes)
                    .where(eq(schema.runtimes.id, session.runtimeId));
                runtimeRef = runtimeRows[0]?.runtimeRef || null;
            } catch (_) { /* best-effort */ }
        }
        await terminateDetachedSessionProcess({
            session: { ...session, runtimeRef },
            runtime,
            waitForAgentExit,
            fastifyLog: request.log,
        });
    }

    sessionManager.deleteSession(sessionId);

    // session 强绑定：删除 session 时，中止并清理它名下所有 deploy/preview 进程。
    // DB 记录由 deployments.session_id 的 ON DELETE CASCADE 级联清理；这里显式停 tunnel/abort。
    try {
        const depRows = await db.select({
            id: schema.deployments.id,
            projectId: schema.deployments.projectId,
            sessionId: schema.deployments.sessionId,
            kind: schema.deployments.kind,
        })
            .from(schema.deployments)
            .where(and(
                eq(schema.deployments.sessionId, sessionId),
                ne(schema.deployments.status, 'stopped'),
            ));
        for (const d of depRows) {
            try { stopTunnel(d.id); } catch (_) { /* ignore */ }
            if (d.kind === 'deploy') {
                try { abortDeploy(d.projectId, d.sessionId); } catch (_) { /* ignore */ }
            }
            await db.update(schema.deployments)
                .set({ status: 'stopped', updatedAt: Date.now(), stoppedBy: 'session_delete' })
                .where(eq(schema.deployments.id, d.id))
                .catch(() => {});
        }
    } catch (err) {
        request.log.warn({ err, sessionId }, '[sessions] failed to stop preview/deploy on session delete');
    }

    // Destroy the boxlite/blink VM if no other live session for this project still
    // uses the same runtime. Without this, deleting a session leaves an orphan VM
    // behind (which can later fail/panic once its workspace dir is removed).
    if (session.runtimeId) {
        try {
            const siblings = await db.select({ id: schema.sessions.id }).from(schema.sessions)
                .where(and(
                    eq(schema.sessions.runtimeId, session.runtimeId),
                    ne(schema.sessions.id, sessionId),
                    ne(schema.sessions.status, 'exited'),
                    ne(schema.sessions.status, 'failed'),
                ));
            if (siblings.length === 0) {
                const runtimeRows = await db.select().from(schema.runtimes)
                    .where(eq(schema.runtimes.id, session.runtimeId));
                const runtimeRef = runtimeRows[0]?.runtimeRef;
                if (runtimeRef && typeof runtime.provider.destroy === 'function') {
                    await runtime.provider.destroy(runtimeRef);
                }
            }
        } catch (err) {
            request.log.warn({ err, sessionId }, '[sessions] failed to destroy runtime on session delete');
        }
    }
    return { ok: true };
});

// ── Session config (config files + custom env) ──
fastify.get('/api/v1/sessions/:sessionId/config', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params;
    const rows = await db.select().from(schema.sessions)
        .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, request.user.id)));
    if (rows.length === 0) return reply.code(404).send({ error: t('errors:session_not_found', {}, request.locale || 'en'), code: 'session_not_found' });

    const { getSessionConfig, getAgentConfigSchema } = require('./session/sessionConfig');
    const config = await getSessionConfig(db, schema, sessionId);
    const schemaDecl = getAgentConfigSchema(rows[0].agentId);
    return {
        session_id: sessionId,
        agent_id: rows[0].agentId,
        config_files: config.configFiles,
        custom_env: config.customEnv,
        config_schema: schemaDecl,
    };
});

fastify.put('/api/v1/sessions/:sessionId/config', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params;
    const { config_files, custom_env } = request.body || {};

    const rows = await db.select().from(schema.sessions)
        .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, request.user.id)));
    if (rows.length === 0) return reply.code(404).send({ error: t('errors:session_not_found', {}, request.locale || 'en'), code: 'session_not_found' });

    const session = rows[0];
    const { saveSessionConfig, validateConfigFiles, writeConfigFilesToVM, getSessionConfig } = require('./session/sessionConfig');

    const { valid, invalidPaths, invalidJson } = validateConfigFiles(config_files, session.agentId);
    if (!valid) {
        const errors = [];
        if (invalidPaths.length) errors.push(`Invalid config file paths: ${invalidPaths.join(', ')}`);
        if (invalidJson?.length) errors.push(`Invalid JSON in: ${invalidJson.map((j) => `${j.path} (${j.error})`).join('; ')}`);
        return reply.code(400).send({ error: errors.join('; ') });
    }

    const cleanConfigFiles = (config_files || []).filter((cf) => cf.path && cf.content);
    const cleanCustomEnv = {};
    if (custom_env && typeof custom_env === 'object') {
        for (const [k, v] of Object.entries(custom_env)) {
            const trimmed = v != null ? String(v).trim() : '';
            if (trimmed) cleanCustomEnv[k] = trimmed;
        }
    }

    // Compare with previous config to detect changes (requires restart)
    const prevConfig = await getSessionConfig(db, schema, sessionId);
    const envChanged = JSON.stringify(prevConfig.customEnv || {}) !== JSON.stringify(cleanCustomEnv);
    const configFilesChanged = JSON.stringify(prevConfig.configFiles || []) !== JSON.stringify(cleanConfigFiles);

    await saveSessionConfig(db, schema, sessionId, { configFiles: cleanConfigFiles, customEnv: cleanCustomEnv });

    // If session is running, write config files to VM immediately (env requires restart)
    if (session.status === 'running' && cleanConfigFiles.length) {
        try {
            const runtimeRows = session.runtimeId
                ? await db.select().from(schema.runtimes).where(eq(schema.runtimes.id, session.runtimeId))
                : [];
            const runtimeRef = runtimeRows[0]?.runtimeRef;
            if (runtimeRef) {
                const vmWorkspacePath = process.env.XENSEMBLE_WORKSPACE_PATH || '/workspace';
                const stateDirRef = session.stateDirRef;
                const stateDirPath = stateDirRef
                    ? `${vmWorkspacePath}/${stateDirRef}`
                    : null;
                await writeConfigFilesToVM(runtime.fs, {
                    workspaceRoot: vmWorkspacePath,
                    runtimeRef,
                    configFiles: cleanConfigFiles,
                    stateDirPath,
                });
            }
        } catch (err) {
            fastify.log.warn({ err, sessionId }, '[sessions] failed to write config files to running VM');
        }
    }

    const needsRestart = session.status === 'running' && (envChanged || configFilesChanged);
    return {
        ok: true,
        needs_restart: needsRestart,
        message: needsRestart
            ? 'Configuration updated. Restart the session for changes to take effect.'
            : 'Configuration updated.',
    };
});

fastify.post('/api/v1/sessions/:sessionId/resume', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params;
    const { terminal_theme_id } = request.body || {};

    const rows = await db.select().from(schema.sessions)
        .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, request.user.id)));
    if (rows.length === 0) return reply.code(404).send({ error: t('errors:session_not_found', {}, request.locale || 'en'), code: 'session_not_found' });

    const session = rows[0];
    if (sessionManager.isAlive(sessionId)) {
        const live = sessionManager.getSession(sessionId);
        if (session.status === 'idle' || session.status === 'exited') {
            sessionManager.forceClear(sessionId);
        } else {
            return {
                session_id: sessionId,
                status: 'running',
                runtime_id: session.runtimeId || null,
                stream_ref: live?.streamRef || session.streamRef || null,
                recoverable: Boolean(session.recoverable),
                terminal_theme_id: terminal_theme_id || null,
                spawn_env_preview: null,
                state_dir_ref: session.stateDirRef || null,
            };
        }
    }
    if (session.status !== 'exited' && session.status !== 'idle' && session.status !== 'running') {
        return reply.code(409).send({ error: 'session not resumable - please start a new session' });
    }
    try {
        const resumeContext = await buildResumeSessionContext({
            requestUser: request.user,
            requestLog: request.log,
            session,
            terminalThemeId: terminal_theme_id,
            db,
            schema,
            getProjectForUser,
            agentGatewayConfig,
            issueSessionToken,
        });
        return await resumeSession({
            db,
            schema,
            sessionManager,
            runtime,
            project: resumeContext.project,
            session,
            agentMeta: resumeContext.agentMeta,
            terminalThemeId: resumeContext.terminalThemeId,
            resolvedSpawnEnv: resumeContext.resolvedSpawnEnv,
            requestLog: request.log,
            fastifyLog: fastify.log,
            ensureProjectRuntime,
            issueSessionToken,
            agentGatewayConfig,
            requestUser: request.user,
            byokConfigFiles: resumeContext.byokConfigFiles,
        });
    } catch (err) {
        if (err instanceof RuntimeError) {
            return sendPublicError(reply, err, 'Failed to resume session', err.statusCode);
        }
        return sendPublicError(reply, err, 'Failed to resume session', 500);
    }
});

// 启动 Agent Session（通过 RuntimeProvider + ExecAdapter）
fastify.post('/api/v1/session/start', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const { agent_id, project_id, terminal_theme_id, custom_image_id, config_files, custom_env } = request.body;
    const isShellOnly = !!(custom_image_id && !agent_id);

    if (!project_id) {
        return reply.code(400).send({ error: 'project_id is required. Select or create a project first.' });
    }

    const project = await getProjectForUser(request.user.id, project_id);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    if (!isShellOnly) {
        const agentAccess = await policy.checkAgentAccess(request.user.id, agent_id, request.user.role);
        if (!agentAccess.ok) return policy.agentAccessErrorReply(reply, agentAccess);
    }

    const sessionQuota = await policy.checkQuota(request.user.id, 'sessions', request.user.role);
    if (!sessionQuota.ok) return policy.quotaErrorReply(reply, sessionQuota);

    let customImageRef = null;
    if (custom_image_id) {
        try {
            const { getReadyImageRef } = require('./runtime/CustomImageService');
            customImageRef = await getReadyImageRef(custom_image_id, request.user.id);
        } catch (err) {
            const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
            return sendPublicError(reply, err, 'Cannot use custom image', statusCode);
        }
    }

    const sessionId = `sess_${crypto.randomBytes(8).toString('hex')}`;

    // --- shell-only: synchronous fast path (no agent spawn, default image) ---
    if (isShellOnly) {
        let workspacePath;
        let runtimeId;
        let ready;
        try {
            ready = await ensureProjectRuntime(project, {
                agentId: 'shell',
                ...(customImageRef ? { image: customImageRef } : {}),
                ...(custom_image_id ? { customImageId: custom_image_id } : {}),
            });
            workspacePath = ready.workspacePath;
            runtimeId = ready.runtime.id;
        } catch (err) {
            if (err instanceof RuntimeError) {
                return sendPublicError(reply, err, 'Failed to prepare project runtime', err.statusCode);
            }
            request.log.error(err);
            return reply.code(500).send({ error: 'Project workspace directory is missing and could not be recreated' });
        }

        try {
            const _localGitSid = request.query?.session_id || request.body?.session_id;
    const localGit = new LocalGitService({ runtimeId: _localGitSid ? await resolveRuntimeIdFromSession(request.user.id, _localGitSid) : null });
            await localGit.ensureGitInit(project);
        } catch (err) {
            request.log.warn({ err, projectId: project.id }, '[sessions] shell ensureGitInit failed (non-fatal)');
        }

        await db.insert(schema.sessions).values({
            id: sessionId,
            userId: request.user.id,
            projectId: project_id,
            runtimeId,
            agentId: 'shell',
            cwd: workspacePath,
            streamRef: null,
            stateDirRef: null,
            recoverable: false,
            status: 'running',
            customImageId: custom_image_id || null,
            createdAt: Date.now(),
        });

        return reply.code(201).send({
            session_id: sessionId,
            project_id,
            agent_id: 'shell',
            shell_only: true,
            custom_image_id: custom_image_id || null,
        });
    }

    // --- regular agent session: async provisioning ---

    const dbAgents = await db.select().from(schema.agents).where(eq(schema.agents.id, agent_id));
    if (dbAgents.length === 0) return reply.code(404).send({ error: t('errors:agent_not_found', {}, request.locale || 'en'), code: 'agent_not_found' });
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
            userId: request.user.id,
            projectId: project_id,
            agentId: agentMeta.id,
            model: agentGatewayConfig.primaryModel(gwCfg),
            role: request.user.role,
        });
    }

    const { resolveSpawnEnv, GATEWAY_MANAGED_ENV_KEYS } = require('./agents/agentEnv');
    if (authMode === 'gateway' && custom_env && typeof custom_env === 'object') {
        for (const key of Object.keys(custom_env)) {
            if (GATEWAY_MANAGED_ENV_KEYS.includes(key)) delete custom_env[key];
        }
    }
    const resolved = await resolveSpawnEnv({
        userId: request.user.id,
        agentId: agentMeta.id,
        envRequired: agentMeta.env_required,
        sessionToken,
        projectId: project_id,
        terminalThemeId: terminal_theme_id,
        warn: (msg) => request.log.warn(msg),
    });
    if (!resolved.env) {
        return reply.code(400).send({ error: resolved.error });
    }

    // Merge BYOK env vars + collect BYOK config files for this agent.
    const { getByokFieldValues, generateByokConfig } = require('./agents/byokFields');
    const { getUserSecrets } = require('./agents/agentEnv');
    const byokSecrets = await getUserSecrets(request.user.id);
    const byokValues = getByokFieldValues(agent_id, byokSecrets);
    let byokConfigFiles = [];
    if (Object.keys(byokValues).length) {
        const byokConfig = generateByokConfig(agent_id, byokValues);
        resolved.env = { ...resolved.env, ...byokConfig.env };
        byokConfigFiles = byokConfig.configFiles || [];
    }

    // Validate config files BEFORE creating the session so we can reject
    // invalid JSON without leaving an orphaned session row.
    if (config_files?.length) {
        const { validateConfigFiles } = require('./session/sessionConfig');
        const { valid, invalidPaths, invalidJson } = validateConfigFiles(config_files, agent_id);
        if (!valid) {
            const errors = [];
            if (invalidPaths.length) errors.push(`Invalid config file paths: ${invalidPaths.join(', ')}`);
            if (invalidJson?.length) errors.push(`Invalid JSON in: ${invalidJson.map((j) => `${j.path} (${j.error})`).join('; ')}`);
            return reply.code(400).send({ error: errors.join('; ') });
        }
    }

    // Insert session as pending - user sees a provisioning UI immediately
    await db.insert(schema.sessions).values({
        id: sessionId,
        userId: request.user.id,
        projectId: project_id,
        runtimeId: null,
        agentId: agent_id,
        cwd: '',
        streamRef: null,
        stateDirRef: null,
        recoverable,
        status: 'pending',
        customImageId: custom_image_id || null,
        createdAt: Date.now(),
    });

    // Save user-provided config files and custom env to DB
    if ((config_files?.length) || (custom_env && Object.keys(custom_env).length)) {
        const { saveSessionConfig } = require('./session/sessionConfig');
        await saveSessionConfig(db, schema, sessionId, { configFiles: config_files, customEnv: custom_env || {} });
    }

    // Return 202 immediately — the frontend enters the agent page and shows a loading state
    reply.code(202).send({
        session_id: sessionId,
        status: 'pending',
        project_id,
        agent_id: agent_id,
    });

    // --- async provisioning: VM creation + agent spawn ---
    (async () => {
        let ready;
        let workspacePath;
        let runtimeId;

        try {
            ready = await ensureProjectRuntime(project, {
                agentId: agent_id,
                ...(customImageRef ? { image: customImageRef } : {}),
                ...(custom_image_id ? { customImageId: custom_image_id } : {}),
                agentVmResources: dbAgents[0]?.vmResources || null,
            });
            workspacePath = ready.workspacePath;
            runtimeId = ready.runtime.id;
        } catch (err) {
            fastify.log.error({ err, sessionId }, '[sessions] async provisioning: ensureProjectRuntime failed');
            await markSessionFailed(sessionId, err instanceof RuntimeError ? err.message : (err.message || 'Failed to prepare project runtime'));
            return;
        }

        // Backfill built-in git if create-time initRepo failed (e.g. BoxLite).
        try {
            const localGit = new LocalGitService({ runtimeId });
            await localGit.ensureGitInit(project);
        } catch (err) {
            fastify.log.warn({ err, sessionId, projectId: project.id }, '[sessions] ensureGitInit failed (non-fatal)');
        }

        if (!(await isSessionStillPending(sessionId))) {
            fastify.log.info({ sessionId }, '[sessions] session cancelled after runtime prepare');
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
                fastify.log.error({ err, sessionId }, '[sessions] async provisioning: ensureSessionStateDir failed');
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
            const { ensureKimiConfig } = require('./workspace/kimiConfigBootstrap');
            await ensureKimiConfig({
                runtime,
                runtimeRef: ready.runtime ? ready.runtime.runtimeRef : undefined,
                userId: request.user.id,
                agentId: agentMeta.id,
                warn: (msg) => fastify.log.warn(msg),
            });
        } catch (err) {
            fastify.log.warn({ err, sessionId }, '[sessions] kimi config bootstrap failed');
        }

        // Write user-provided config files BEFORE bootstrap so that bootstrap
        // logic (e.g. claude-code API key approval) can augment user-provided files.
        const { writeConfigFilesToVM, applyCustomEnv, getSessionConfig, resolveAgentSpawnArgs } = require('./session/sessionConfig');
        const { mergeByokConfigFiles } = require('./agents/byokFields');
        const userSessionConfig = await getSessionConfig(db, schema, sessionId);
        const mergedConfigFiles = mergeByokConfigFiles(byokConfigFiles, userSessionConfig.configFiles);
        if (mergedConfigFiles.length) {
            const vmRuntimeRef = ready.runtime ? ready.runtime.runtimeRef : undefined;
            await writeConfigFilesToVM(runtime.fs, {
                workspaceRoot: workspacePath,
                runtimeRef: vmRuntimeRef,
                configFiles: mergedConfigFiles,
                stateDirPath: sessionStateDir?.stateDirPath || null,
            }).catch((err) => fastify.log.warn({ err, sessionId }, '[sessions] writeConfigFilesToVM failed'));
        }

        if (sessionStateDir?.stateDirPath) {
            resolved.env = applyStateDirEnv(resolved.env, resumeSpec, sessionStateDir.stateDirPath);
            // Pre-approve custom API key for claude-code to skip the "Detected
            // a custom API key" confirmation prompt that blocks --continue.
            if (agentMeta.id === 'claude-code' && resolved.env.ANTHROPIC_API_KEY) {
                try {
                    const { ensureClaudeApiKeyApproved } = require('./workspace/claudeConfigBootstrap');
                    await ensureClaudeApiKeyApproved({
                        runtime,
                        runtimeRef: ready.runtime ? ready.runtime.runtimeRef : undefined,
                        stateDirPath: sessionStateDir.stateDirPath,
                        apiKey: resolved.env.ANTHROPIC_API_KEY,
                    });
                } catch (err) {
                    fastify.log.warn({ err, sessionId }, '[sessions] claude api key approval failed');
                }
            }
            if (resumeSpec?.redirectHome && sessionStateDir.stateDirRef) {
                const runtimeRef = ready.runtime ? ready.runtime.runtimeRef : undefined;
                await prepareHomeRedirect(runtime.fs, {
                    workspaceRoot: workspacePath,
                    stateDirRef: sessionStateDir.stateDirRef,
                    runtimeRef,
                }).catch((err) => fastify.log.warn({ err, sessionId }, '[sessions] prepareHomeRedirect failed'));
            }
        }

        // Gateway mode: write agent-specific config files to route through the gateway.
        // Runs AFTER user config files and state dir env so gateway config can override.
        if (authMode === 'gateway') {
            try {
                const { ensureGatewayConfig } = require('./workspace/ensureGatewayConfig');
                const { resolveAgentGatewayModelTargets } = require('./agents/agentEnv');
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
                    warn: (msg) => fastify.log.warn(msg),
                });
            } catch (err) {
                fastify.log.warn({ err, sessionId }, '[sessions] gateway config bootstrap failed');
            }
        }

        if (!(await isSessionStillPending(sessionId))) {
            fastify.log.info({ sessionId }, '[sessions] session cancelled before spawn');
            return;
        }

        // Single DB update: merge cwd + runtimeId + stateDirRef (was 2 separate writes).
        const sessionUpdate = {
            cwd: workspacePath,
            runtimeId,
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
                const injectResult = await injectSkillsForSession({
                    userId: request.user.id,
                    projectId: project_id,
                    agentId: agentMeta.id,
                    workspacePath: ready.hostWorkspacePath || workspacePath,
                });
                if (injectResult.injected) {
                    fastify.log.info(
                        `[skills] injected ${injectResult.count} skill(s) into ${injectResult.instructionFile} for ${agentMeta.id} (session ${sessionId})`,
                    );
                }
            } catch (err) {
                fastify.log.warn({ err, sessionId }, '[skills] inject-for-session failed (non-fatal)');
            }
        }

        try {
            const stateArgs = sessionStateDir?.stateDirPath
                ? buildStateArgs(resumeSpec, sessionStateDir.stateDirPath)
                : [];
            const spawnArgs = resolveAgentSpawnArgs(agent_id, mergedConfigFiles, {
                authMode,
                gatewayModel: resolved.env.OPENAI_MODEL,
            });
            handle = await runtime.exec.spawn(
                agentMeta.cmd,
                [...spawnArgs.prepend, ...stateArgs, ...agentMeta.args, ...spawnArgs.append],
                resolved.env,
                spawnOpts,
            );
        } catch (err) {
            if (
                err instanceof AgentSpawnError
                && resolveRuntimeProvider() === 'boxlite'
                && ready.runtime?.runtimeRef
            ) {
                fastify.log.warn({ err, sessionId }, '[sessions] spawn failed, recreating boxlite runtime');
                try {
                    ready = await ensureProjectRuntime(project, {
                        agentId: agent_id,
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
                    const retrySpawnArgs = resolveAgentSpawnArgs(agent_id, mergedConfigFiles, {
                        authMode,
                        gatewayModel: resolved.env.OPENAI_MODEL,
                    });
                    handle = await runtime.exec.spawn(
                        agentMeta.cmd,
                        [...retrySpawnArgs.prepend, ...retryStateArgs, ...agentMeta.args, ...retrySpawnArgs.append],
                        resolved.env,
                        spawnOpts,
                    );
                } catch (retryErr) {
                    fastify.log.error({ err: retryErr, sessionId }, '[sessions] spawn retry failed');
                    await markSessionFailed(sessionId, retryErr instanceof AgentSpawnError
                        ? retryErr.message
                        : (retryErr.message || 'Failed to start agent session'));
                    return;
                }
            } else {
                fastify.log.error({ err, sessionId }, '[sessions] spawn failed');
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
            fastify.log.info({ sessionId }, '[sessions] session no longer pending, discarding spawn result');
            try { handle.kill(); } catch {}
            return;
        }

        sessionManager.createSession(sessionId, handle, agent_id, {
            transcriptRef: handle.streamRef,
            projectId: project_id,
            runtimeId,
            runtimeRef: ready.runtime ? ready.runtime.runtimeRef : undefined,
            stateDirRef: sessionStateDir?.stateDirRef || null,
            userId: request.user.id,
        });

        await registerSessionLifecycle({
            db,
            schema,
            sessionManager,
            sessionId,
            project,
            fastifyLog: fastify.log,
            runtimeId,
        });

        const streamRef = handle.streamRef ?? null;
        await db.update(schema.sessions).set({
            status: 'running',
            streamRef: streamRef || null,
        }).where(eq(schema.sessions.id, sessionId));
        broadcastSse({ type: 'session_status', sessionId, status: 'running', userId: request.user.id });
    })().catch((err) => {
        fastify.log.error({ err, sessionId }, '[sessions] async provisioning uncaught error');
        markSessionFailed(sessionId, err.message || 'Unexpected error during session provisioning').catch(() => {});
    });
});

const WS_BUFFERED_LIMIT = 16 * 1024 * 1024;
const WS_PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS) || 30000;

function startWsHeartbeat(ws) {
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const timer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!alive) {
            ws.terminate();
            return;
        }
        alive = false;
        try { ws.ping(); } catch (_) { ws.terminate(); }
    }, WS_PING_INTERVAL_MS);
    timer.unref();
    const stop = () => clearInterval(timer);
    ws.once('close', stop);
    return stop;
}

function createWsSender(ws) {
    const queue = [];
    let draining = false;
    const onDrain = () => {
        draining = false;
        while (queue.length > 0 && ws.readyState === WebSocket.OPEN) {
            if (ws.bufferedAmount > WS_BUFFERED_LIMIT) {
                draining = true;
                return;
            }
            const payload = queue.shift();
            try {
                ws.send(payload);
            } catch (_) {
                queue.length = 0;
                return;
            }
        }
    };
    ws.on('drain', onDrain);

    return (payload) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
        if (ws.bufferedAmount > WS_BUFFERED_LIMIT || draining) {
            if (queue.length < 200) {
                queue.push(data);
            }
            return;
        }
        try {
            ws.send(data);
            if (ws.bufferedAmount > WS_BUFFERED_LIMIT) {
                draining = true;
            }
        } catch (_) {}
    };
}

// WebSocket Terminal（协议不变；与 /api/v1/terminal/* HTTP 通道共享 terminalBridge）
fastify.register(async function terminalWsRoutes(app) {
    app.get('/ws/v1/terminal', { websocket: true }, async (connection, req) => {
        const ws = connection.socket;
        trackWebSocket(ws);
        const stopHeartbeat = startWsHeartbeat(ws);
        const sendJson = createWsSender(ws);

        try {
            let sessionId = null;
            let accessToken = null;
            let after = 0;
            let chatOnly = false;
            try {
                const url = new URL(req.url, 'http://localhost');
                sessionId = url.searchParams.get('sessionId');
                accessToken = url.searchParams.get('access_token');
                const parsedAfter = Number(url.searchParams.get('after'));
                after = Number.isFinite(parsedAfter) ? parsedAfter : 0;
                chatOnly = url.searchParams.get('chat') === '1';
            } catch (_) {
                sessionId = null;
                accessToken = null;
                after = 0;
            }

            if (!accessToken) {
                closeUnauthorizedWebSocket(ws, sendJson, 'access_token is required');
                return;
            }

            const payload = auth.verifyAccessToken(accessToken);
            if (!payload?.id) {
                closeUnauthorizedWebSocket(ws, sendJson);
                return;
            }

            const active = await assertActiveUser(payload);
            if (active.error) {
                closeForbiddenWebSocket(ws, sendJson, active.error);
                return;
            }

            if (!sessionId) {
                sendJson({ type: 'error', data: 'sessionId is required' });
                ws.close();
                return;
            }

            const [userRows, sessionRows] = await Promise.all([
                db.select().from(schema.users).where(eq(schema.users.id, payload.id)),
                db.select().from(schema.sessions).where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, payload.id))),
            ]);
            const wsUser = userRows[0] || { id: payload.id, role: 'user', status: 'active' };

            if (sessionRows.length === 0) {
                sendJson({ type: 'error', data: 'Session not found or not active' });
                ws.close();
                return;
            }
            const sessionRecord = sessionRows[0];
            const wakeSession = async (record = sessionRecord) => {
                const resumeContext = await buildResumeSessionContext({
                    requestUser: wsUser,
                    requestLog: req.log,
                    session: record,
                    db,
                    schema,
                    getProjectForUser,
                    agentGatewayConfig,
                    issueSessionToken,
                });
                return resumeSession({
                    db,
                    schema,
                    sessionManager,
                    runtime,
                    project: resumeContext.project,
                    session: record,
                    agentMeta: resumeContext.agentMeta,
                    terminalThemeId: resumeContext.terminalThemeId,
                    resolvedSpawnEnv: resumeContext.resolvedSpawnEnv,
                    requestLog: req.log,
                    fastifyLog: fastify.log,
                    ensureProjectRuntime,
                    issueSessionToken,
                    agentGatewayConfig,
                    requestUser: wsUser,
                    byokConfigFiles: resumeContext.byokConfigFiles,
                });
            };

            // Client messages (input/resize) may arrive while the session is
            // still provisioning: the frontend sends its fitted terminal size
            // immediately after the WS opens, but for a freshly created
            // session subscribeTerminal below waits (up to 120s) for the agent
            // to spawn. Register the handler NOW and buffer those messages —
            // with no listener registered they would be dropped, and a
            // full-screen TUI like opencode would boot at the PTY default
            // size (120x32), leaving the bottom of the terminal unpainted.
            const bufferedClientMessages = [];
            let handleClientMessage = (message) => {
                try {
                    const raw = typeof message === 'string' ? message : message.toString();
                    bufferedClientMessages.push(JSON.parse(raw));
                } catch (_) { /* ignore malformed frames */ }
            };
            ws.on('message', (message) => handleClientMessage(message));

            const sub = await subscribeTerminal(sessionId, (payload) => {
                sendJson(payload);
                if (payload.type === 'exit' || payload.type === 'error') {
                    try { ws.close(); } catch (_) {}
                }
            }, { after, sessionRecord, wakeSession, chatOnly });
            if (!sub.ok) {
                ws.close();
                return;
            }

            const processTerminalClientMessage = (parsed) => {
                if (!sessionManager.isAlive(sessionId)) return;
                if (parsed?.type === 'input' || parsed?.type === 'resize') {
                    const live = sessionManager.getSession(sessionId);
                    if (parsed?.type === 'input') {
                        sessionManager.touchActivity(sessionId, 'input');
                    }
                    const transcriptRef = live?.transcriptRef || live?.streamRef;
                    if (transcriptRef) {
                        transcriptStore.append(transcriptRef, {
                            kind: parsed.type === 'input' ? 'in' : 'resize',
                            data: parsed.type === 'input'
                                ? parsed.data
                                : { cols: parsed.cols, rows: parsed.rows },
                        });
                    }
                }
                applyTerminalMessage(sub.handle, parsed);
            };

            // Replay messages buffered while the session was provisioning
            // (the fitted resize and any early keystrokes) now that the agent
            // handle exists.
            for (const parsed of bufferedClientMessages.splice(0)) {
                try { processTerminalClientMessage(parsed); } catch (err) { req.log.error(err); }
            }

            // Forward structured chat events (recorded by the LLM proxy) over
            // the same terminal channel so the chat view can render them live.
            const offChat = chatTranscript.subscribe(sessionId, (entry) => {
                sendJson({ type: 'chat_event', data: entry });
            });
            sendWebSocketReady(sendJson);

            handleClientMessage = (message) => {
                try {
                    const raw = typeof message === 'string' ? message : message.toString();
                    const parsed = JSON.parse(raw);
                    processTerminalClientMessage(parsed);
                } catch (err) {
                    req.log.error(err);
                }
            };

            ws.on('close', () => {
                stopHeartbeat();
                offChat();
                sub.cleanup();
            });
        } catch (err) {
            req.log.error(err);
            sendJson({ type: 'error', data: 'Internal server error' });
            ws.close();
        }
    });
});

fastify.register(async function workspaceTerminalWsRoutes(app) {
    app.get('/ws/v1/workspace-terminal', { websocket: true }, async (connection, req) => {
        const ws = connection.socket;
        trackWebSocket(ws);
        const stopHeartbeat = startWsHeartbeat(ws);
        const sendJson = createWsSender(ws);

        try {
            let projectId = null;
            let accessToken = null;
            let sessionId = null;
            try {
                const url = new URL(req.url, 'http://localhost');
                projectId = url.searchParams.get('project_id');
                accessToken = url.searchParams.get('access_token');
                sessionId = url.searchParams.get('session_id');
            } catch (_) {
                projectId = null;
                accessToken = null;
            }

            if (!accessToken) {
                closeUnauthorizedWebSocket(ws, sendJson, 'access_token is required');
                return;
            }

            const payload = auth.verifyAccessToken(accessToken);
            if (!payload?.id) {
                closeUnauthorizedWebSocket(ws, sendJson);
                return;
            }

            const active = await assertActiveUser(payload);
            if (active.error) {
                closeForbiddenWebSocket(ws, sendJson, active.error);
                return;
            }

            if (!projectId) {
                sendJson({ type: 'error', data: 'project_id is required' });
                ws.close();
                return;
            }

            const project = await getProjectForUser(payload.id, projectId);
            if (!project) {
                sendJson({ type: 'error', data: 'Project not found' });
                ws.close();
                return;
            }

            // Resolve runtimeId from session_id so the workspace shell lands in the
            // correct worktree (per-agent isolation via git worktree).
            let runtimeId = null;
            if (sessionId) {
                runtimeId = await resolveRuntimeIdFromSession(payload.id, sessionId);
            }

            let ready;
            try {
                ready = await ensureProjectRuntime(project, runtimeId ? { runtimeId } : {});
            } catch (err) {
                req.log.error(err);
                const { message } = sanitizePublicError(err, 'Failed to initialize workspace shell');
                sendJson({ type: 'error', data: message });
                ws.close();
                return;
            }

            const ref = ready.runtime ? ready.runtime.runtimeRef : undefined;
            const shellId = `${payload.id}:${projectId}:${runtimeId || 'default'}`;
            let shell = WorkspaceShellManager.get(shellId);
            if (!shell || !WorkspaceShellManager.isAlive(shellId)) {
                shell = null;
                // Inject custom_env from the most recent running session for this project
                // so the workspace shell has the same env vars as the agent.
                let shellEnv = { TERM: 'xterm-256color' };
                try {
                    const sessRows = await db.select().from(schema.sessions)
                        .where(and(eq(schema.sessions.projectId, projectId), eq(schema.sessions.userId, payload.id)))
                        .orderBy(sql`${schema.sessions.createdAt} DESC`)
                        .limit(1);
                    if (sessRows.length > 0) {
                        const { getSessionConfig } = require('./session/sessionConfig');
                        const sessCfg = await getSessionConfig(db, schema, sessRows[0].id);
                        if (sessCfg.customEnv && Object.keys(sessCfg.customEnv).length) {
                            shellEnv = { ...shellEnv, ...sessCfg.customEnv };
                        }
                    }
                } catch (e) {
                    req.log.warn({ err: e }, '[workspace-shell] failed to load session custom_env');
                }
                // Default to bash with -i (interactive). systemd injects SHELL=/bin/sh into
                // service processes, so we cannot rely on process.env.SHELL — pick an absolute
                // path explicitly and force interactive mode so the shell sources .bashrc,
                // sets up a prompt, and supports tab completion.
                const shellAttempts = [
                    { cmd: process.env.WORKSPACE_SHELL_CMD, args: ['-i'] },
                    { cmd: '/bin/bash', args: ['-i'] },
                    { cmd: '/bin/sh', args: ['-i'] },
                ].filter((s) => s.cmd);
                let lastErr = null;
                for (const { cmd: shellCmd, args: shellArgs } of shellAttempts) {
                    try {
                        const handle = await runtime.exec.spawn(
                            shellCmd,
                            shellArgs,
                            shellEnv,
                            {
                                name: 'workspace-shell',
                                cwd: ready.workspacePath,
                                runtimeRef: ref,
                                uid: process.env.RUNTIME_UID,
                                gid: process.env.RUNTIME_GID,
                            },
                        );
                        req.log.info({ shellCmd, args: shellArgs }, '[workspace-shell] spawn ok');
                        shell = WorkspaceShellManager.create(shellId, handle);
                        break;
                    } catch (err) {
                        lastErr = err;
                        req.log.warn(
                            {
                                shellCmd,
                                args: shellArgs,
                                errName: err?.name,
                                errMessage: err?.message,
                            },
                            '[workspace-shell] spawn attempt failed',
                        );
                        if (!(err instanceof AgentSpawnError)) {
                            break;
                        }
                    }
                }
                if (!shell) {
                    req.log.error(lastErr);
                    sendJson({ type: 'error', data: lastErr instanceof Error ? lastErr.message : 'Failed to start workspace shell' });
                    ws.close();
                    return;
                }
            }

            WorkspaceShellManager.addSubscriber(shellId);

            const sub = subscribeWorkspaceShell(shellId, (payload) => {
                sendJson(payload);
                if (payload.type === 'exit' || payload.type === 'error') {
                    try {
                        ws.close();
                    } catch (_) {}
                }
            });
            if (!sub.ok) {
                WorkspaceShellManager.removeSubscriber(shellId);
                ws.close();
                return;
            }
            sendWebSocketReady(sendJson);

            ws.on('message', (message) => {
                if (!WorkspaceShellManager.isAlive(shellId)) return;
                try {
                    const raw = typeof message === 'string' ? message : message.toString();
                    applyTerminalMessage(sub.handle, JSON.parse(raw));
                } catch (err) {
                    req.log.error(err);
                }
            });

            ws.on('close', () => {
                stopHeartbeat();
                sub.cleanup();
                WorkspaceShellManager.removeSubscriber(shellId);
            });
        } catch (err) {
            req.log.error(err);
            sendJson({ type: 'error', data: 'Internal server error' });
            ws.close();
        }
    });
});

// Runtimes — 按 project 列出（一等实体）
fastify.get('/api/v1/runtimes', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const projectId = request.query.project_id;
    if (!projectId) return reply.code(400).send({ error: 'project_id is required' });

    const project = await getProjectForUser(request.user.id, projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const rows = await db.select().from(schema.runtimes)
        .where(eq(schema.runtimes.projectId, projectId));
    return rows.map(formatRuntime);
});

// Deployments — CRUD + preview start/stop（Architecture.md 步骤 2）

// 当前占用并发额度的部署/预览（进行中部署 + 运行中 preview/deploy），
// 前端据此在左侧会话列表标记"占用限额"的会话（标红/闪烁）
fastify.get('/api/v1/active-deployments', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const userId = request.user.id;
    const items = [];
    const seen = new Set();
    for (const { projectId, sessionId } of listByUser(userId)) {
        const key = `deploy:${projectId}:${sessionId || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ sessionId: sessionId || null, projectId, kind: 'deploy', status: 'building' });
    }
    try {
        const rows = await db.select({
            projectId: schema.deployments.projectId,
            sessionId: schema.deployments.sessionId,
            kind: schema.deployments.kind,
        }).from(schema.deployments)
            .where(and(eq(schema.deployments.userId, userId), eq(schema.deployments.status, 'running')));
        for (const r of rows) {
            const key = `${r.kind}:${r.projectId}:${r.sessionId || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({ sessionId: r.sessionId || null, projectId: r.projectId, kind: r.kind, status: 'running' });
        }
    } catch (e) { /* ignore */ }
    return items;
});

fastify.get('/api/v1/deployments', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const projectId = request.query.project_id;
    if (!projectId) return reply.code(400).send({ error: 'project_id is required' });

    const project = await getProjectForUser(request.user.id, projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    return deploymentService.listForProject(request.user.id, projectId);
});

fastify.get('/api/v1/deployments/:deploymentId', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const row = await deploymentService.getForUser(request.user.id, request.params.deploymentId);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });
    return deploymentService.formatDeployment(row);
});

fastify.post('/api/v1/projects/:projectId/preview', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const previewQuota = await policy.checkQuota(request.user.id, 'previews', request.user.role);
    if (!previewQuota.ok) return policy.quotaErrorReply(reply, previewQuota);

    try {
        // "Open Preview" runs the two-stage auto-deploy pipeline synchronously
        // (no SSE): stage A analyses the project, stage B builds/starts the
        // app, verify probes the listening port. On success the response
        // carries previewUrl + previewToken, matching what PreviewPanel
        // already expects (data.public_url + data.preview_token).
        const result = await runAutoTwoStageDeploy({
            projectId: request.params.projectId,
            userId: request.user.id,
            role: request.user.role,
            getProjectForUser,
            resume: false,
            sessionId: request.query?.session_id || request.body?.session_id,
        });
        if (!result?.ok) {
            const code = result?.statusCode || 503;
            return reply.code(code).send({
                error: result?.error || 'Preview deploy failed',
                code: result?.errorCode || 'preview_deploy_failed',
            });
        }
        return reply.code(201).send({
            ok: true,
            public_url: result.previewUrl,
            deploymentId: result.deploymentId,
            preview_token: result.previewToken,
            elapsed_ms: result.elapsedMs,
        });
    } catch (err) {
        const code = err instanceof RuntimeError ? err.statusCode : 503;
        const { message } = sanitizePublicError(err, 'Preview deploy failed');
        return reply.code(code).send({ error: message });
    }
});

fastify.post('/api/v1/deployments', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const projectId = request.body?.project_id;
    if (!projectId) return reply.code(400).send({ error: 'project_id is required' });

    const project = await getProjectForUser(request.user.id, projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const previewQuota = await policy.checkQuota(request.user.id, 'previews', request.user.role);
    if (!previewQuota.ok) return policy.quotaErrorReply(reply, previewQuota);

    const dep = await deploymentService.createPreview(request.user.id, project);
    return reply.code(201).send(dep);
});

fastify.post('/api/v1/deployments/:deploymentId/start', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const row = await deploymentService.getForUser(request.user.id, request.params.deploymentId);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });

    const project = await getProjectForUser(request.user.id, row.projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    try {
        return await deploymentService.startPreview(request.user.id, project, row);
    } catch (err) {
        const rowAfter = await deploymentService.getForUser(request.user.id, row.id);
        const code = err instanceof RuntimeError ? err.statusCode : 503;
        const { message } = sanitizePublicError(err, 'Preview start failed');
        return reply.code(code).send({
            error: message,
            deployment: deploymentService.formatDeployment(rowAfter),
        });
    }
});

fastify.post('/api/v1/deployments/:deploymentId/stop', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const row = await deploymentService.getForUser(request.user.id, request.params.deploymentId);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });

    return deploymentService.stopPreview(request.user.id, row);
});

fastify.delete('/api/v1/deployments/:deploymentId', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const row = await deploymentService.getForUser(request.user.id, request.params.deploymentId);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });

    await deploymentService.remove(request.user.id, row.id);
    return { ok: true };
});

fastify.post('/api/v1/deployments/:deploymentId/preview-token', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const row = await deploymentService.getForUser(request.user.id, request.params.deploymentId);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });
    if (row.status !== 'running') return reply.code(503).send({ error: 'Preview is not running' });

    const previewToken = await deploymentService.issuePreviewToken(row.id);
    return { preview_token: previewToken };
});

// Workspace API — 经 runtime 解析 workspace 根路径后委托 FsAdapter
fastify.get('/api/v1/workspace/files', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
    const projectId = request.query.project_id;
    if (!projectId) return reply.code(400).send({ error: 'project_id is required' });

    const project = await getProjectForUser(request.user.id, projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    try {
        const relativePath = request.query.path || '';
        const includeHidden = request.query.include_hidden === '1' || request.query.include_hidden === 'true';
        const depth = request.query.depth === 'single' ? 'single' : 'recursive';
        const _sessionId = request.query?.session_id || request.body?.session_id;
        const _runtimeId = _sessionId ? await resolveRuntimeIdFromSession(request.user.id, _sessionId) : null;
        const ready = await ensureProjectRuntime(project, _runtimeId ? { runtimeId: _runtimeId } : {});
        const ref = ready.runtime ? ready.runtime.runtimeRef : undefined;
        const cacheKey = `${ref}:${relativePath}:${depth}:${includeHidden ? 1 : 0}`;
        const cached = fsListCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.data;
        const files = await runtime.fs.fsList(ready.workspacePath, relativePath, { runtimeRef: ref, includeHidden, depth });
        // 空结果不缓存：新 workspace 在两阶段（Import repository / Start session）加载过程中，
        // 首次请求时 VM/workspace 可能尚未就绪而返回空，缓存空结果会挡住就绪后的请求。
        if (Array.isArray(files) && files.length > 0) {
            fsListCache.set(cacheKey, { data: files, expiresAt: Date.now() + FS_LIST_CACHE_TTL_MS });
        }
        return files;
    } catch (err) {
        if (err instanceof RuntimeError) return reply.code(err.statusCode).send({ error: err.message });
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to list workspace files' });
    }
});

const TEXT_EXTENSIONS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.css', '.html', '.txt',
    '.yml', '.yaml', '.toml', '.sh', '.py', '.go', '.rs', '.xml', '.svg',
    '.env', '.gitignore', '.editorconfig', '.csv', '.log', '.c', '.h', '.cpp',
    '.hpp', '.java', '.rb', '.php', '.sql', '.graphql', '.prisma', '.vue',
    '.svelte', '.scss', '.less', '.ini', '.cfg', '.conf',
]);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

function isTextFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return TEXT_EXTENSIONS.has(ext) || ext === '' || !ext.includes('.');
}

fastify.get('/api/v1/workspace/file', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
    const projectId = request.query.project_id;
    const filePath = request.query.path;
    if (!projectId) return reply.code(400).send({ error: 'project_id is required' });
    if (!filePath) return reply.code(400).send({ error: 'Missing path' });

    const project = await getProjectForUser(request.user.id, projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    try {
        const _sessionId = request.query?.session_id || request.body?.session_id;
        const _runtimeId = _sessionId ? await resolveRuntimeIdFromSession(request.user.id, _sessionId) : null;
        const ready = await ensureProjectRuntime(project, _runtimeId ? { runtimeId: _runtimeId } : {});
        const ref = ready.runtime ? ready.runtime.runtimeRef : undefined;
        const isText = isTextFile(filePath);
        const encoding = isText ? 'utf8' : 'buffer';
        // Skip fsStat (saves one VM exec ~500ms-1s): use fsRead's result length
        // for the size check, and catch 404 for non-existent files.
        let content;
        try {
            content = await runtime.fs.fsRead(ready.workspacePath, filePath, { runtimeRef: ref, encoding });
        } catch (readErr) {
            if (readErr instanceof RuntimeError && readErr.statusCode === 404) {
                return reply.code(404).send({ error: 'File not found' });
            }
            throw readErr;
        }
        const byteLength = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
        if (byteLength > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'File too large' });
        }
        const isBinary = !isText;
        if (isBinary) {
            return { content: Buffer.isBuffer(content) ? content.toString('base64') : content, isBinary: true };
        }
        return { content, isBinary: false };
    } catch (err) {
        if (err instanceof RuntimeError) return reply.code(err.statusCode).send({ error: err.message });
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to read file' });
    }
});

fastify.put('/api/v1/workspace/file', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
    const projectId = request.query.project_id;
    const filePath = request.query.path;
    if (!projectId) return reply.code(400).send({ error: 'project_id is required' });
    if (!filePath) return reply.code(400).send({ error: 'Missing path' });

    const project = await getProjectForUser(request.user.id, projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const { content } = request.body || {};
    if (content === undefined || content === null) return reply.code(400).send({ error: 'content is required' });
    if (typeof content === 'string' && Buffer.byteLength(content) > MAX_FILE_SIZE) {
        return reply.code(413).send({ error: 'File too large' });
    }

    try {
        const _sessionId = request.query?.session_id || request.body?.session_id;
        const _runtimeId = _sessionId ? await resolveRuntimeIdFromSession(request.user.id, _sessionId) : null;
        const ready = await ensureProjectRuntime(project, _runtimeId ? { runtimeId: _runtimeId } : {});
        const ref = ready.runtime ? ready.runtime.runtimeRef : undefined;

        const ifUnmodifiedSince = request.headers['if-unmodified-since'];
        if (ifUnmodifiedSince) {
            try {
                const stat = await runtime.fs.fsStat(ready.workspacePath, filePath, { runtimeRef: ref });
                const headerTime = new Date(ifUnmodifiedSince).getTime();
                if (!isNaN(headerTime) && stat.mtime > headerTime) {
                    return reply.code(409).send({ error: 'File was modified externally' });
                }
            } catch (err) {
                if (err instanceof RuntimeError && err.statusCode === 404) {
                    // file doesn't exist yet, allow write
                } else if (err instanceof RuntimeError) {
                    throw err;
                }
            }
        }

        const result = await runtime.fs.fsWrite(ready.workspacePath, filePath, content, { runtimeRef: ref });
        fsListCache.clear();
        request.log.info({ userId: request.user.id, projectId, path: filePath, action: 'write' }, 'workspace fs op');
        return { ok: true, path: result.path, size: result.size };
    } catch (err) {
        if (err instanceof RuntimeError) return reply.code(err.statusCode).send({ error: err.message });
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to write file' });
    }
});

fastify.delete('/api/v1/workspace/file', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
    const projectId = request.query.project_id;
    const filePath = request.query.path;
    if (!projectId) return reply.code(400).send({ error: 'project_id is required' });
    if (!filePath) return reply.code(400).send({ error: 'Missing path' });

    const project = await getProjectForUser(request.user.id, projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    try {
        const _sessionId = request.query?.session_id || request.body?.session_id;
        const _runtimeId = _sessionId ? await resolveRuntimeIdFromSession(request.user.id, _sessionId) : null;
        const ready = await ensureProjectRuntime(project, _runtimeId ? { runtimeId: _runtimeId } : {});
        const ref = ready.runtime ? ready.runtime.runtimeRef : undefined;
        await runtime.fs.fsDelete(ready.workspacePath, filePath, { runtimeRef: ref });
        fsListCache.clear();
        request.log.info({ userId: request.user.id, projectId, path: filePath, action: 'delete' }, 'workspace fs op');
        return { ok: true, path: filePath };
    } catch (err) {
        if (err instanceof RuntimeError) return reply.code(err.statusCode).send({ error: err.message });
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to delete file' });
    }
});

fastify.post('/api/v1/workspace/dir', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
    const projectId = request.query.project_id;
    if (!projectId) return reply.code(400).send({ error: 'project_id is required' });

    const project = await getProjectForUser(request.user.id, projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const { path: dirPath } = request.body || {};
    if (!dirPath) return reply.code(400).send({ error: t('errors:path_required', { defaultValue: 'path is required' }, request.locale || 'en'), code: 'path_required' });

    try {
        const _sessionId = request.query?.session_id || request.body?.session_id;
        const _runtimeId = _sessionId ? await resolveRuntimeIdFromSession(request.user.id, _sessionId) : null;
        const ready = await ensureProjectRuntime(project, _runtimeId ? { runtimeId: _runtimeId } : {});
        const ref = ready.runtime ? ready.runtime.runtimeRef : undefined;
        await runtime.fs.mkdirp(ready.workspacePath, dirPath, { runtimeRef: ref });
        fsListCache.clear();
        request.log.info({ userId: request.user.id, projectId, path: dirPath, action: 'mkdir' }, 'workspace fs op');
        return { ok: true, path: dirPath };
    } catch (err) {
        if (err instanceof RuntimeError) return reply.code(err.statusCode).send({ error: err.message });
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to create directory' });
    }
});

fastify.delete('/api/v1/workspace/dir', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
    const projectId = request.query.project_id;
    const dirPath = request.query.path;
    if (!projectId) return reply.code(400).send({ error: 'project_id is required' });
    if (!dirPath) return reply.code(400).send({ error: 'Missing path' });

    const project = await getProjectForUser(request.user.id, projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    try {
        const _sessionId = request.query?.session_id || request.body?.session_id;
        const _runtimeId = _sessionId ? await resolveRuntimeIdFromSession(request.user.id, _sessionId) : null;
        const ready = await ensureProjectRuntime(project, _runtimeId ? { runtimeId: _runtimeId } : {});
        const ref = ready.runtime ? ready.runtime.runtimeRef : undefined;
        await runtime.fs.fsRmdir(ready.workspacePath, dirPath, { runtimeRef: ref });
        fsListCache.clear();
        request.log.info({ userId: request.user.id, projectId, path: dirPath, action: 'rmdir' }, 'workspace fs op');
        return { ok: true, path: dirPath };
    } catch (err) {
        if (err instanceof RuntimeError) return reply.code(err.statusCode).send({ error: err.message });
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to delete directory' });
    }
});

fastify.post('/api/v1/workspace/move', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
    const projectId = request.query.project_id;
    if (!projectId) return reply.code(400).send({ error: 'project_id is required' });

    const project = await getProjectForUser(request.user.id, projectId);
    if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

    const { from, to } = request.body || {};
    if (!from || !to) return reply.code(400).send({ error: 'from and to are required' });

    try {
        const _sessionId = request.query?.session_id || request.body?.session_id;
        const _runtimeId = _sessionId ? await resolveRuntimeIdFromSession(request.user.id, _sessionId) : null;
        const ready = await ensureProjectRuntime(project, _runtimeId ? { runtimeId: _runtimeId } : {});
        const ref = ready.runtime ? ready.runtime.runtimeRef : undefined;
        await runtime.fs.fsMove(ready.workspacePath, from, to, { runtimeRef: ref });
        fsListCache.clear();
        request.log.info({ userId: request.user.id, projectId, from, to, action: 'move' }, 'workspace fs op');
        return { ok: true, from, to };
    } catch (err) {
        if (err instanceof RuntimeError) return reply.code(err.statusCode).send({ error: err.message });
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to move' });
    }
});

/**
 * Idempotent first-run admin bootstrap. Mirrors `scripts/manage-user.js
 * create-admin` but runs in-process so the preview / dev server comes up with
 * a usable admin without an out-of-band SSH step.
 *
 * Behaviour:
 *   - INITIAL_ADMIN_BOOTSTRAP=0 (or unset with intent to disable) skips entirely.
 *   - If any active admin already exists, no-op (existing password preserved).
 *   - Otherwise insert a new admin user with the given username / password.
 *
 * Defaults to admin / admin so the first deploy is loggable immediately;
 * operators should change the password (or set INITIAL_ADMIN_BOOTSTRAP=0 once
 * a real admin exists) before exposing the service.
 */
async function bootstrapInitialAdmin(db) {
    if (String(process.env.INITIAL_ADMIN_BOOTSTRAP ?? '1') !== '1') return;
    const username = String(process.env.INITIAL_ADMIN_USERNAME ?? 'admin');
    const password = String(process.env.INITIAL_ADMIN_PASSWORD ?? 'admin');
    if (!username || !password) return;

    const { eq, and, sql } = require('drizzle-orm');
    const schema = require('./db/schema');
    const auth = require('./auth');
    const platformSettings = require('./admin/PlatformSettings');

    // No-op if any active admin already exists; otherwise creating a duplicate
    // here would clobber operator-set credentials on every restart.
    const adminRows = await db
        .select({ count: sql`count(*)` })
        .from(schema.users)
        .where(and(eq(schema.users.role, 'admin'), eq(schema.users.status, 'active')));
    if (Number(adminRows[0]?.count ?? 0) > 0) return;

    const userId = `usr_${require('crypto').randomBytes(6).toString('hex')}`;
    const now = Date.now();
    const defaults = await platformSettings.getDefaultUserQuota();

    await db.insert(schema.users).values({
        id: userId,
        username,
        passwordHash: auth.hashPassword(password),
        role: 'admin',
        status: 'active',
        createdAt: now,
        updatedAt: now,
    });
    await db.insert(schema.userQuotas).values({
        userId,
        maxProjects: defaults.max_projects ?? 5,
        maxSessions: defaults.max_sessions ?? 20,
        maxPreviews: defaults.max_previews ?? 1,
        maxRuntimes: defaults.max_runtimes ?? 1,
        resourceTier: defaults.resource_tier ?? 'basic',
        updatedAt: now,
    });

    fastify.log.warn(
        `Bootstrap admin "${username}" created with default password. ` +
        'Set INITIAL_ADMIN_PASSWORD (or change it via the admin console) before exposing this instance.',
    );
}

async function startServer() {
    fastify.setErrorHandler((err, request, reply) => {
        request.log.error(err);
        if (reply.sent) return;
        const { statusCode, message, code } = sanitizePublicError(err, 'Internal server error');
        const body = { error: message };
        if (code) body.code = code;
        reply.code(statusCode).send(body);
    });

    const { seedIfNeeded } = require('./db/seed');
    // 生产环境由 deploy/install.sh 以管理员连接执行 migrate；应用 role 无 DDL 权限。
    if (process.env.NODE_ENV !== 'production' || process.env.RUN_DB_MIGRATE === '1') {
        const { runMigrations } = require('./db/migrate');
        await runMigrations(db);
    }
    await seedIfNeeded(db);
    await bootstrapInitialAdmin(db);

    unigateway.installShutdownHooks(fastify.log);
    const gatewaySettings = require('./admin/GatewaySettings');
    const gatewayConfig = await gatewaySettings.getConfig();
    const gatewayStatus = gatewayConfig.auto_start
        ? await unigateway.start(fastify.log)
        : await unigateway.applyRuntimeConfig().then(() => unigateway.getStatus());
    try {
        const platformSecrets = require('./admin/PlatformSecrets');
        await unigateway.syncPlatformRouterSecrets(platformSecrets);
        fastify.log.info(`[unigateway] agent router -> ${gatewayStatus.baseUrl}`);
    } catch (err) {
        fastify.log.warn(err, '[unigateway] failed to sync platform router secrets');
    }

    // Heal gateway service bindings for gateway-mode agents (e.g. after TOML
    // regeneration, provider rename/delete, or a config saved before the
    // provider existed). Best-effort; failures are logged, not fatal.
    try {
        const { syncAllAgentServiceBindings } = require('./llm/agentServiceSync');
        const results = await syncAllAgentServiceBindings(fastify.log);
        const unfinished = results.filter(
            (r) => !r.synced && !['not_gateway_mode', 'no_provider'].includes(r.reason),
        );
        if (unfinished.length > 0) {
            fastify.log.warn({ unfinished }, '[llm] gateway binding sync: unfinished');
        }
    } catch (err) {
        fastify.log.warn(err, '[llm] gateway binding sync failed');
    }

    await registerPreviewGateway(fastify);
    await registerLlmProxy(fastify);
    startPreviewLifecycle();

    if (resolveRuntimeProvider() === 'boxlite') {
        try {
            const BoxLiteClient = require('./runtime/BoxLiteClient');
            const bc = new BoxLiteClient();
            await bc.health();
            fastify.log.info('[boxlite] blink-server reachable at ' + (process.env.BLINK_API_URL || 'http://127.0.0.1:8787'));
        } catch (e) {
            fastify.log.warn('[boxlite] blink-server not reachable yet; ensure it is running before agent sessions: ' + e.message);
        }
    }

    const staticRoot = path.join(__dirname, '../../web/dist');
    if (fs.existsSync(staticRoot)) {
        await fastify.register(require('@fastify/static'), {
            root: staticRoot,
            wildcard: false,
            setHeaders: (reply, path) => {
                if (path.endsWith('index.html')) {
                    reply.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                }
            },
        });
        fastify.setNotFoundHandler((request, reply) => {
            const url = request.raw.url || '';
            if (url.startsWith('/api') || url.startsWith('/ws') || url.startsWith('/preview')) {
                return reply.code(404).send({ error: 'Not found' });
            }
            return reply.sendFile('index.html', staticRoot);
        });
        fastify.log.info(`[static] serving ${staticRoot}`);
    }

    const { resolvePort } = require('./config/defaultPort');
    const port = resolvePort();

    // 对话摘要（A+B）：挂到 SessionManager 会话创建上，仅会话退出时触发一次摘要；
    // 轮次实时读结构化聊天记录，不调用 LLM。
    // 必须在 recoverRunningSessions 之前启动，以便恢复出来的会话也被接管。
    startConversationAutoSummarizer();

    // P3 技能提炼 exit 钩子：会话退出时 L1 评分入池（SKILL_EXTRACT_ENABLED=false 时 no-op）。
    startSkillPipelineHook();

    // P2 定时调度器：conversation-summarize job（PG 乐观锁，多实例安全）。
    // SCHEDULER_ENABLED=false 时 startScheduler 内部 no-op。
    try {
        await startScheduler({ db });
        fastify.log.info('[scheduler] started');
    } catch (err) {
        fastify.log.warn(err, '[scheduler] failed to start');
    }

    try {
        const recovery = await recoverRunningSessions({
            db,
            schema,
            runtime,
            sessionManager,
            transcriptStore,
            fastifyLog: fastify.log,
        });
        if (recovery.recovered > 0) {
            fastify.log.info(
                `[sessions] reattached ${recovery.recovered} running boxlite session(s)`,
            );
        }
    } catch (err) {
        fastify.log.warn(err, '[sessions] failed to recover running boxlite sessions');
    }

    try {
        const reconcile = await reconcileRunningSessions(db, schema);
        if (reconcile.reconciled > 0) {
            fastify.log.info(
                `[sessions] reconciled ${reconcile.reconciled} stale running session(s)`,
            );
        }
    } catch (err) {
        fastify.log.warn(err, '[sessions] failed to reconcile stale sessions');
    }

    try {
        const builds = await reconcileCustomImageBuilds(db, schema);
        if (builds.reconciled > 0) {
            fastify.log.info(
                `[custom-images] marked ${builds.reconciled} interrupted build(s) as failed`,
            );
        }
    } catch (err) {
        fastify.log.warn(err, '[custom-images] failed to reconcile interrupted builds');
    }

    try {
        const { initService: initCustomImageService, getFeatureStatus } = require('./runtime/CustomImageService');
        await initCustomImageService();
        fastify.log.info(
            `[custom-images] service initialized (${JSON.stringify(getFeatureStatus())})`,
        );
    } catch (err) {
        fastify.log.warn(err, '[custom-images] failed to initialize service');
    }

    const idleHibernateMonitor = createIdleHibernateMonitor({
        db,
        schema,
        runtime,
        sessionManager,
        fastifyLog: fastify.log,
        idleThresholdMs: Number(process.env.SESSION_IDLE_HIBERNATE_MS || 600000),
        sweepIntervalMs: Number(process.env.SESSION_IDLE_SWEEP_MS || 60000),
    });
    idleHibernateMonitor.start();
    fastify.addHook('onClose', async () => {
        idleHibernateMonitor.stop();
        stopConversationAutoSummarizer();
        stopSkillPipelineHook();
        await stopScheduler();
        await gracefulShutdownSessions({
            db,
            schema,
            runtime,
            sessionManager,
            workspaceShellManager: WorkspaceShellManager,
            fastifyLog: fastify.log,
            activeWebSockets,
        });
    });
    installProcessShutdownHooks(fastify, {
        onShutdown: async () => {
            // Stop the idle-hibernate sweep immediately so no new hibernate
            // operations start while sessions are being shut down.
            idleHibernateMonitor.stop();
        },
    });

    try {
        const sync = await userAdmin.syncInstalledAgentGrantsForAllUsers();
        if (sync.granted_count > 0) {
            fastify.log.info(
                `[agents] synced ${sync.granted_count} missing grant(s) for ${sync.agent_count} installed agent(s)`,
            );
        }
    } catch (err) {
        fastify.log.warn(err, '[agents] failed to sync installed agent grants');
    }

    // 默认仅监听 loopback：对外统一走 nginx(:8088 → 127.0.0.1:3888)。
    // 监听 0.0.0.0 会让沙箱 guest（gvproxy 出站网络）直连宿主控制面 API，破坏隔离；
    // 如需外部直连控制面，请显式设置 LISTEN_HOST=0.0.0.0 并自行防护。
    await fastify.listen({ port, host: process.env.LISTEN_HOST || '127.0.0.1' });
}

startServer().catch((err) => {
    fastify.log.error(err);
    process.exit(1);
});
