const platformSecrets = require('../admin/PlatformSecrets');
const platformSettings = require('../admin/PlatformSettings');
const userPreferences = require('../admin/UserPreferences');
const terminalThemes = require('../config/terminalThemes');
const unigateway = require('../gateway/unigatewayManager');
const agentGatewayConfig = require('../admin/AgentGatewayConfig');
const { resolveLlmPublicRouterBase } = require('../llm/publicUrl');
const { TOKEN_PREFIX } = require('../llm/sessionToken');
const { resolveExternalGatewayUrl } = require('../llm/gatewayUpstream');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { eq } = require('drizzle-orm');
const auth = require('../auth/index');

const GATEWAY_BASE_URL_KEYS = [
    'ANTHROPIC_BASE_URL',
    'OPENAI_BASE_URL',
    'KIMI_BASE_URL',
    'MOONSHOT_BASE_URL',
    'OPENROUTER_BASE_URL',
    'ZAI_BASE_URL',
];

/** Injected at spawn when not in the user/platform vault (official CLI defaults). */
const SPAWN_ENV_DEFAULTS = {
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
};

const GATEWAY_MODEL_ENV_KEYS = [
    'OPENAI_MODEL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'LLM_MODEL',
    'KIMI_MODEL',
    'MOONSHOT_MODEL',
    'ZAI_MODEL',
];

const KIMI_CODE_AGENT_IDS = new Set(['kimi-code']);
const KIMI_CODE_DEFAULT_MAX_CONTEXT = String(256 * 1024);
const OPENCODE_AGENT_IDS = new Set(['opencode']);

function computeEffectiveRequired(envRequired) {
    return envRequired;
}

const GATEWAY_API_KEY_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'KIMI_API_KEY',
    'MOONSHOT_API_KEY',
    'DASHSCOPE_API_KEY',
    'ZAI_API_KEY',
    'MINIMAX_API_KEY',
    'QODER_PERSONAL_ACCESS_TOKEN',
    'AMP_API_KEY',
    'COHERE_API_KEY',
    'HERMES_API_KEY',
    'OPENCLAW_KEY',
];
const GATEWAY_MANAGED_ENV_KEYS = Object.freeze([
    ...new Set([...GATEWAY_BASE_URL_KEYS, ...GATEWAY_API_KEY_KEYS]),
]);

async function getLlmAuthMode() {
    return platformSettings.getLlmAuthMode();
}

async function getUserSecrets(userId) {
    const rows = await db.select().from(schema.secrets).where(eq(schema.secrets.userId, userId));
    if (rows.length === 0) return {};
    return auth.decryptSecrets(rows[0].encryptedData);
}

async function resolvePlatformSecrets({ sessionToken, forPreview = false } = {}) {
    const platform = await platformSecrets.getRaw();
    await unigateway.applyRuntimeConfig();
    const secrets = unigateway.ensureGatewaySecrets();
    let routerKey = sessionToken?.trim() || '';
    if (!routerKey && !forPreview) {
        routerKey = platform.LLM_ROUTER_API_KEY?.trim()
            || secrets.gatewayKey
            || unigateway.getStatus().gatewayKey
            || '';
    }
    return {
        ...platform,
        LLM_ROUTER_URL: await resolveLlmPublicRouterBase(),
        LLM_ROUTER_API_KEY: routerKey,
    };
}

function openRouterCompatibleBaseUrl(router) {
    const base = String(router || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    return base.endsWith('/v1') ? base : `${base}/v1`;
}

function applyGatewaySynthesis(platform) {
    const router = platform.LLM_ROUTER_URL?.trim();
    if (!router) return { ...platform };

    const out = { ...platform };
    const openRouterBase = openRouterCompatibleBaseUrl(router);
    if (openRouterBase) {
        out.OPENROUTER_BASE_URL = openRouterBase;
    }
    for (const key of GATEWAY_BASE_URL_KEYS) {
        if (key === 'OPENROUTER_BASE_URL') continue;
        if (!out[key]?.trim()) out[key] = router;
    }

    const token = platform.LLM_ROUTER_API_KEY?.trim();
    if (token) {
        for (const key of GATEWAY_API_KEY_KEYS) {
            out[key] = token;
        }
    }
    return out;
}

function pickEnvRequired(env, envRequired) {
    const picked = {};
    for (const key of envRequired) {
        if (env[key] != null && String(env[key]).trim() !== '') {
            picked[key] = env[key];
        }
    }
    return picked;
}

function applySpawnDefaults(env, envRequired) {
    const out = { ...env };
    if (envRequired.includes('ANTHROPIC_API_KEY') && !out.ANTHROPIC_BASE_URL?.trim()) {
        out.ANTHROPIC_BASE_URL = SPAWN_ENV_DEFAULTS.ANTHROPIC_BASE_URL;
    }
    if (envRequired.includes('OPENAI_API_KEY') && !out.OPENAI_BASE_URL?.trim()) {
        out.OPENAI_BASE_URL = SPAWN_ENV_DEFAULTS.OPENAI_BASE_URL;
    }
    return out;
}

function findMissing(env, envRequired) {
    return envRequired.filter((k) => !env[k]?.trim());
}

/**
 * Resolve PTY env for an agent session.
 * - gateway: platform vault (+ LLM_ROUTER_URL synthesis); users do not supply keys.
 * - byok: user vault for env_required only; interactive-login agents use empty env_required.
 */
function applyKimiCodeGatewayEnv(env) {
    const routerUrl = env.LLM_ROUTER_URL?.trim();
    const routerKey = env.LLM_ROUTER_API_KEY?.trim();
    const model = env.KIMI_MODEL?.trim()
        || env.MOONSHOT_MODEL?.trim()
        || env.OPENAI_MODEL?.trim()
        || env.LLM_MODEL?.trim();
    if (!routerUrl || !routerKey || !model) return env;
    return {
        ...env,
        KIMI_MODEL_NAME: model,
        KIMI_MODEL_API_KEY: routerKey,
        KIMI_MODEL_BASE_URL: routerUrl,
        KIMI_MODEL_PROVIDER_TYPE: 'openai',
        KIMI_MODEL_MAX_CONTEXT_SIZE: env.KIMI_MODEL_MAX_CONTEXT_SIZE?.trim() || KIMI_CODE_DEFAULT_MAX_CONTEXT,
    };
}

function applyOpencodeGatewayEnv(env, modelTargets, defaultTarget) {
    const routerUrl = env.LLM_ROUTER_URL?.trim();
    const routerKey = env.LLM_ROUTER_API_KEY?.trim();
    const targets = (Array.isArray(modelTargets) ? modelTargets : [modelTargets])
        .map((t) => (t ?? '').trim())
        .filter(Boolean);
    if (!routerUrl || !routerKey || targets.length === 0) return env;
    const defaultModel = ((defaultTarget ?? targets[0]) ?? '').trim();
    const models = {};
    for (const target of targets) {
        models[target] = { name: target };
    }
    const config = {
        autoupdate: false,
        model: `gateway/${defaultModel}`,
        provider: {
            gateway: {
                npm: '@ai-sdk/openai-compatible',
                name: 'gateway',
                options: {
                    baseURL: routerUrl,
                    apiKey: routerKey,
                },
                models,
            },
        },
    };
    return {
        ...env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    };
}

/**
 * Compose the routing target the agent sends to the gateway as the `model` field.
 * The gateway host resolves `provider/model` by selecting the provider via the
 * `provider` part and the upstream model via the `model` part, so a bare model id
 * (which the gateway treats as a provider hint) no longer fails routing.
 */
function composeGatewayModelTarget(provider, model) {
    const trimmedModel = (model ?? '').trim();
    if (!trimmedModel) return '';
    const trimmedProvider = (provider ?? '').trim();
    return trimmedProvider ? `${trimmedProvider}/${trimmedModel}` : trimmedModel;
}

async function applyAgentGatewayModel(agentId, env) {
    const cfg = await agentGatewayConfig.getForAgent(agentId);
    const model = agentGatewayConfig.primaryModel(cfg);
    if (!model) return env;
    const target = composeGatewayModelTarget(cfg.provider, model);
    const out = { ...env };
    for (const key of GATEWAY_MODEL_ENV_KEYS) {
        out[key] = target;
    }
    if (agentId === 'hermes') {
        out.HERMES_MODEL = target;
    }
    if (KIMI_CODE_AGENT_IDS.has(agentId)) {
        return applyKimiCodeGatewayEnv(out);
    }
    if (OPENCODE_AGENT_IDS.has(agentId)) {
        const targets = agentGatewayConfig.allModels(cfg)
            .map((m) => composeGatewayModelTarget(cfg.provider, m));
        return applyOpencodeGatewayEnv(out, targets, target);
    }
    return out;
}

async function resolveAgentAuthMode(agentId) {
    return agentGatewayConfig.getAgentAuthMode(agentId);
}

function applyGatewayAgentEnv(agentId, env, platform, envRequired) {
    const out = { ...env };
    if (agentId === 'droid') {
        // Factory Droid in BYOK airgap mode: droid only talks to configured
        // customModels (no Factory API), which makes the gateway model the
        // default in the UI instead of Factory's built-in models. Without this,
        // the model selector opens on a Factory model and customModels must be
        // picked manually every session.
        out.FACTORY_AIRGAP_ENABLED = '1';
    }
    if (agentId === 'github-copilot') {
        // Copilot CLI BYOK: without COPILOT_PROVIDER_* the CLI requires GitHub
        // auth (OAuth / PAT) and talks to GitHub's hosted models. Setting these
        // env vars routes all requests to the gateway with no GitHub login.
        const routerUrl = platform.LLM_ROUTER_URL?.trim();
        const routerKey = platform.LLM_ROUTER_API_KEY?.trim();
        const target = out.OPENAI_MODEL?.trim() || out.LLM_MODEL?.trim();
        if (routerUrl && routerKey && target) {
            out.COPILOT_PROVIDER_BASE_URL = `${routerUrl.replace(/\/+$/, '')}/v1`;
            out.COPILOT_PROVIDER_TYPE = 'openai';
            out.COPILOT_PROVIDER_API_KEY = routerKey;
            out.COPILOT_MODEL = target;
        }
    }
    if (agentId === 'codebuddy') {
        // CodeBuddy's interactive UI always shows a "Select login method" screen
        // unless CODEBUDDY_API_KEY is present. Setting it skips the login prompt;
        // model requests still use the custom model from models.json (gateway),
        // so any non-empty value works.
        const routerKey = platform.LLM_ROUTER_API_KEY?.trim();
        if (routerKey) {
            out.CODEBUDDY_API_KEY = routerKey;
        }
    }
    if (envRequired.includes('OPENROUTER_API_KEY') && platform.OPENROUTER_BASE_URL?.trim()) {
        out.OPENROUTER_BASE_URL = platform.OPENROUTER_BASE_URL.trim();
    }
    return out;
}

async function resolveTerminalThemeContext({ userId, terminalThemeId, warn } = {}) {
    const settings = await platformSettings.getAll();
    const disabledIds = settings.disabled_terminal_theme_ids || [];
    const userThemeId = userId ? await userPreferences.getTerminalThemeId(userId) : null;
    const platformDefaultId = settings.default_terminal_theme_id;

    const effectiveId = terminalThemes.resolveEffectiveTerminalThemeId({
        requestThemeId: terminalThemeId,
        userThemeId,
        platformDefaultId,
        disabledIds,
        warn,
    });

    const platformThemeId = platformDefaultId || terminalThemes.getCatalogDefaultId();
    return {
        terminal_theme_id: effectiveId,
        platformSpawnEnv: terminalThemes.getThemeSpawnEnv(platformThemeId),
        themeSpawnEnv: terminalThemes.getThemeSpawnEnv(effectiveId),
    };
}

function resolveTerminalSpawnEnv(themeId) {
    return terminalThemes.getThemeSpawnEnv(themeId);
}

function mergeSpawnEnvLayers({ platformSpawnEnv, themeSpawnEnv, secretEnv }) {
    // Priority (lowest to highest), per desktop/docs/terminal-theme-server-requirements.md §5:
    //   1. platform/theme spawn env
    //   2. agent env_required secrets (BYOK / gateway vault)
    return {
        ...platformSpawnEnv,
        ...themeSpawnEnv,
        ...secretEnv,
    };
}

async function buildGatewaySpawnEnv(agentId, envRequired, { draftModel, draftProvider, sessionToken, forPreview = false } = {}) {
    const [cfg, platform] = await Promise.all([
        agentGatewayConfig.getForAgent(agentId),
        (async () => {
            const secrets = await resolvePlatformSecrets({ sessionToken, forPreview });
            return applyGatewaySynthesis(secrets);
        })(),
    ]);
    const model = (draftModel ?? agentGatewayConfig.primaryModel(cfg) ?? '').trim();
    const provider = (draftProvider ?? cfg?.provider ?? '').trim();

    const effectiveRequired = computeEffectiveRequired(envRequired);
    let env = pickEnvRequired(platform, effectiveRequired);
    if (model) {
        env = { ...env };
        const target = composeGatewayModelTarget(provider, model);
        for (const key of GATEWAY_MODEL_ENV_KEYS) env[key] = target;
        if (agentId === 'hermes') env.HERMES_MODEL = target;
    }
    env = applySpawnDefaults({ ...platform, ...env }, effectiveRequired);
    env = applyGatewayAgentEnv(agentId, env, platform, effectiveRequired);

    const defaults = {
        OPENROUTER_API_KEY: env.OPENROUTER_API_KEY || platform.OPENROUTER_API_KEY || '',
        OPENROUTER_BASE_URL: env.OPENROUTER_BASE_URL || platform.OPENROUTER_BASE_URL || openRouterCompatibleBaseUrl(platform.LLM_ROUTER_URL) || '',
    };

    if (KIMI_CODE_AGENT_IDS.has(agentId)) {
        env = applyKimiCodeGatewayEnv(env);
    }
    if (OPENCODE_AGENT_IDS.has(agentId) && model) {
        const draftTarget = composeGatewayModelTarget(provider, model);
        const targets = Array.from(new Set([
            ...agentGatewayConfig.allModels(cfg).map((m) => composeGatewayModelTarget(provider, m)),
            draftTarget,
        ]));
        env = applyOpencodeGatewayEnv(env, targets, draftTarget);
    }

    return { env, cfg, model, platform, defaults };
}

async function resolveSpawnEnv({ userId, agentId, envRequired, sessionToken, projectId, terminalThemeId, forPreview = false, warn } = {}) {
    const [cfg, themeCtx, platform] = await Promise.all([
        agentGatewayConfig.getForAgent(agentId),
        resolveTerminalThemeContext({ userId, terminalThemeId, warn }),
        (async () => {
            const secrets = await resolvePlatformSecrets({ sessionToken, forPreview });
            return applyGatewaySynthesis(secrets);
        })(),
    ]);
    const mode = (cfg?.llm_auth_mode === 'gateway' || cfg?.llm_auth_mode === 'byok')
        ? cfg.llm_auth_mode
        : 'byok';

    const effectiveRequired = computeEffectiveRequired(envRequired);

    const finish = (secretEnv, missing = []) => {
        const env = mergeSpawnEnvLayers({
            platformSpawnEnv: themeCtx.platformSpawnEnv,
            themeSpawnEnv: themeCtx.themeSpawnEnv,
            secretEnv,
        });
        return {
            mode,
            env,
            missing,
            terminal_theme_id: themeCtx.terminal_theme_id,
            spawn_env_preview: terminalThemes.pickSpawnEnvPreview(env),
        };
    };

    if (mode === 'gateway') {
        if (!forPreview && !sessionToken?.trim()) {
            return {
                mode,
                env: null,
                missing: [],
                error: 'Session LLM token is required for gateway mode.',
            };
        }
        let env = pickEnvRequired(platform, effectiveRequired);
        if (effectiveRequired.length > 0 && !platform.LLM_ROUTER_URL?.trim()) {
            const missing = findMissing(env, effectiveRequired);
            if (missing.length > 0) {
                return {
                    mode,
                    env: null,
                    missing,
                    error: 'Platform LLM gateway is not configured. Ask an admin to start the gateway under Settings → Gateway.',
                };
            }
        }
        const missing = findMissing(env, effectiveRequired);
        if (missing.length > 0 && !forPreview) {
            return {
                mode,
                env: null,
                missing,
                error: `Missing platform API key: ${missing[0]}. Ask an admin to configure gateway keys under Agents → Keys.`,
            };
        }
        env = await applyAgentGatewayModel(agentId, applySpawnDefaults({ ...platform, ...env }, effectiveRequired));
        if (KIMI_CODE_AGENT_IDS.has(agentId) && !env.KIMI_MODEL_NAME?.trim()) {
            return {
                mode,
                env: null,
                missing: ['model'],
                error: 'A model must be selected for Kimi Code in gateway mode. Configure it under Agents → Keys.',
            };
        }
        env = applyGatewayAgentEnv(agentId, env, platform, effectiveRequired);
        return finish(env, missing);
    }

    const user = await getUserSecrets(userId);
    const env = applySpawnDefaults(pickEnvRequired(user, effectiveRequired), effectiveRequired);
    const missing = findMissing(env, effectiveRequired);
    return finish(env, missing);
}

async function previewSpawnEnv({ userId, agentId, envRequired, terminalThemeId } = {}) {
    const resolved = await resolveSpawnEnv({
        userId,
        agentId,
        envRequired,
        terminalThemeId,
        forPreview: true,
    });
    if (!resolved.env) {
        return {
            mode: resolved.mode,
            ready: false,
            error: resolved.error || 'Unable to resolve spawn environment.',
        };
    }
    return {
        mode: resolved.mode,
        ready: true,
        terminal_theme_id: resolved.terminal_theme_id,
        effective_spawn_env: resolved.env,
        spawn_env_preview: resolved.spawn_env_preview,
    };
}

async function isAgentKeysReady(envRequired, userId, agentId) {
    const cfg = await agentGatewayConfig.getForAgent(agentId);
    const mode = (cfg?.llm_auth_mode === 'gateway' || cfg?.llm_auth_mode === 'byok')
        ? cfg.llm_auth_mode
        : 'byok';
    if (mode === 'gateway') {
        if (!agentGatewayConfig.primaryModel(cfg)) return false;
        return Boolean(await resolveExternalGatewayUrl()) || unigateway.getStatus().running;
    }
    const effectiveRequired = computeEffectiveRequired(envRequired);
    if (effectiveRequired.length === 0) return true;
    const user = await getUserSecrets(userId);
    return findMissing(pickEnvRequired(user, effectiveRequired), effectiveRequired).length === 0;
}

function maskEnvValue(key, value) {
    if (!value?.trim()) return '—';
    if (/URL|BASE/i.test(key)) return value.trim();
    const trimmed = value.trim();
    if (trimmed.length <= 8) return '••••••••';
    return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function describeGatewayEnvSource(key) {
    if (key === 'OPENROUTER_BASE_URL') return 'Router Base URL (+ /v1)';
    if (GATEWAY_API_KEY_KEYS.includes(key)) return 'Session token (issued at start)';
    if (GATEWAY_BASE_URL_KEYS.includes(key)) return 'Control plane LLM proxy';
    return 'Platform gateway';
}

async function previewGatewaySpawnEnv(agentId, { envRequired = [], cmd, args = [], draftModel, draftProvider, draftAuthMode } = {}) {
    const cfg = await agentGatewayConfig.getForAgent(agentId);
    const savedMode = (cfg?.llm_auth_mode === 'gateway' || cfg?.llm_auth_mode === 'byok')
        ? cfg.llm_auth_mode
        : 'byok';
    const mode = draftAuthMode === 'gateway' || draftAuthMode === 'byok' ? draftAuthMode : savedMode;
    const gateway = unigateway.getStatus();
    const externalGatewayUrl = await resolveExternalGatewayUrl();

    if (mode !== 'gateway') {
        return {
            mode,
            ready: false,
            gateway_running: gateway.running,
            error: 'Agent is not in gateway mode.',
        };
    }

    const { env, model, platform, defaults } = await buildGatewaySpawnEnv(agentId, envRequired, {
        draftModel,
        draftProvider,
        forPreview: true,
    });
    const routerUrl = platform.LLM_ROUTER_URL?.trim() || '';
    const missingKeys = !model ? ['model'] : [];

    const fields = [];
    const effectiveEnvRequired = envRequired.includes('OPENROUTER_API_KEY') || agentId === 'hermes'
        ? [...new Set([...envRequired.filter((k) => k !== 'HERMES_API_KEY'), 'OPENROUTER_API_KEY'])]
        : envRequired;
    if (effectiveEnvRequired.includes('OPENROUTER_API_KEY') || agentId === 'hermes') {
        fields.push({
            key: 'OPENROUTER_API_KEY',
            label: 'OpenRouter API Key',
            source: describeGatewayEnvSource('OPENROUTER_API_KEY'),
            value: '',
            default_value: '',
            placeholder: `${TOKEN_PREFIX}… (issued at session start)`,
            password: true,
        });
    }
    if (env.OPENROUTER_BASE_URL || envRequired.includes('OPENROUTER_API_KEY')) {
        fields.push({
            key: 'OPENROUTER_BASE_URL',
            label: 'OpenRouter Base URL',
            source: describeGatewayEnvSource('OPENROUTER_BASE_URL'),
            value: env.OPENROUTER_BASE_URL || '',
            default_value: defaults.OPENROUTER_BASE_URL || '',
            password: false,
        });
    }

    const launchArgs = Array.isArray(args) ? args : [];
    const ready = Boolean(model)
        && missingKeys.length === 0
        && Boolean(routerUrl)
        && (gateway.running || Boolean(externalGatewayUrl));

    return {
        mode,
        ready,
        gateway_running: gateway.running,
        router_base_url: routerUrl || null,
        session_token_prefix: TOKEN_PREFIX,
        openrouter_base_url: env.OPENROUTER_BASE_URL || null,
        model: model || null,
        missing_keys: missingKeys,
        defaults,
        fields,
        launch: {
            cmd: cmd || null,
            args: launchArgs,
            command_line: [cmd, ...launchArgs].filter(Boolean).join(' ') || null,
        },
    };
}

module.exports = {
    GATEWAY_MANAGED_ENV_KEYS,
    getLlmAuthMode,
    resolveAgentAuthMode,
    getUserSecrets,
    resolvePlatformSecrets,
    applyGatewaySynthesis,
    resolveSpawnEnv,
    resolveTerminalSpawnEnv,
    resolveTerminalThemeContext,
    mergeSpawnEnvLayers,
    applyGatewayAgentEnv,
    applyOpencodeGatewayEnv,
    computeEffectiveRequired,
    isAgentKeysReady,
    findMissing,
    previewGatewaySpawnEnv,
    previewSpawnEnv,
};
