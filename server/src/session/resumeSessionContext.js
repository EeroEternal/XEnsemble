const { eq } = require('drizzle-orm');
const { getAgentResume, getAgentResumeLevel } = require('../agents/agentResume');
const { resolveSpawnEnv, getUserSecrets } = require('../agents/agentEnv');
const { applyProjectGitEnv } = require('../agents/projectGitEnv');
const { getByokFieldValues, generateByokConfig } = require('../agents/byokFields');

async function buildResumeSessionContext({
    requestUser,
    requestLog,
    session,
    terminalThemeId = null,
    db,
    schema,
    getProjectForUser,
    agentGatewayConfig,
    issueSessionToken,
}) {
    const project = session.projectId ? await getProjectForUser(requestUser.id, session.projectId) : null;
    if (!project) {
        const error = new Error('Project not found');
        error.statusCode = 404;
        throw error;
    }

    const dbAgents = await db.select().from(schema.agents).where(eq(schema.agents.id, session.agentId));
    if (dbAgents.length === 0) {
        const error = new Error('Agent not found');
        error.statusCode = 404;
        throw error;
    }

    const agentRow = dbAgents[0];
    const agentMeta = {
        ...agentRow,
        args: JSON.parse(agentRow.args),
        env_required: JSON.parse(agentRow.envRequired),
    };
    const resumeSpec = getAgentResume(agentMeta.id);
    if (getAgentResumeLevel(agentMeta.id) !== 'L2' || (!resumeSpec?.stateEnv && !resumeSpec?.stateArgs && !resumeSpec?.redirectHome) || !session.stateDirRef || !session.recoverable) {
        const error = new Error('session not resumable — please start a new session');
        error.statusCode = 409;
        throw error;
    }

    const authMode = await agentGatewayConfig.getAgentAuthMode(agentMeta.id);
    let sessionToken = null;
    if (authMode === 'gateway') {
        const gwCfg = await agentGatewayConfig.getForAgent(agentMeta.id);
        sessionToken = issueSessionToken({
            sessionId: session.id,
            userId: requestUser.id,
            projectId: project.id,
            agentId: agentMeta.id,
            model: agentGatewayConfig.primaryModel(gwCfg),
            role: requestUser.role,
        });
    }

    const resolvedSpawnEnv = await resolveSpawnEnv({
        userId: requestUser.id,
        agentId: agentMeta.id,
        envRequired: agentMeta.env_required,
        sessionToken,
        projectId: project.id,
        terminalThemeId,
        warn: (msg) => requestLog?.warn?.(msg),
    });
    if (!resolvedSpawnEnv.env) {
        const error = new Error(resolvedSpawnEnv.error || 'Failed to resolve spawn environment');
        error.statusCode = 400;
        throw error;
    }

    applyProjectGitEnv(resolvedSpawnEnv.env, project);

    // Merge BYOK env vars + collect BYOK config files for this agent.
    const byokSecrets = await getUserSecrets(requestUser.id);
    const byokValues = getByokFieldValues(agentMeta.id, byokSecrets);
    let byokConfigFiles = [];
    if (Object.keys(byokValues).length) {
        const byokConfig = generateByokConfig(agentMeta.id, byokValues);
        resolvedSpawnEnv.env = { ...resolvedSpawnEnv.env, ...byokConfig.env };
        byokConfigFiles = byokConfig.configFiles || [];
    }
    // opencode TUI follows the embedded xterm theme (gateway mode has no BYOK
    // config generation, so bootstrap the theme file here for both modes).
    if (agentMeta.id === 'opencode' && !byokConfigFiles.some((f) => f.path === '/root/.config/opencode/tui.json')) {
        const { opencodeThemeConfigFile } = require('../agents/byokFields');
        byokConfigFiles = [...byokConfigFiles, opencodeThemeConfigFile()];
    }
    // Agent TUI 稳定性 env（如禁用 cline ClinePass 促销弹窗；用户 customEnv
    // 稍后经 applyCustomEnv 后写入，显式设置可覆盖）。
    require('../agents/agentTuiEnv').applyAgentTuiEnv(resolvedSpawnEnv.env, agentMeta.id);

    return {
        project,
        agentMeta,
        terminalThemeId,
        resolvedSpawnEnv,
        sessionToken,
        requestUser,
        byokConfigFiles,
    };
}

module.exports = { buildResumeSessionContext };
