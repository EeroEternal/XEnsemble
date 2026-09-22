const { eq } = require('drizzle-orm');
const { DEFAULT_AGENTS } = require('../agents/defaultAgents');

/**
 * Get configSchema for an agent from the default catalog.
 */
function getAgentConfigSchema(agentId) {
    const agent = DEFAULT_AGENTS.find((a) => a.id === agentId);
    return agent?.configSchema || null;
}

/**
 * Resolve a config file path, replacing ${STATE_DIR} with the actual state dir.
 * Returns null if the path contains ${STATE_DIR} but no stateDirPath is provided.
 */
function resolveConfigFilePath(path, stateDirPath) {
    if (!path) return path;
    if (path.includes('${STATE_DIR}')) {
        if (!stateDirPath) return null;
        return path.replace(/\$\{STATE_DIR\}/g, stateDirPath);
    }
    return path;
}

/**
 * Validate that all config file paths are declared in the agent's configSchema.
 * Also validates JSON format for files declared with format: 'json'.
 * Returns { valid, invalidPaths, invalidJson }.
 */
function validateConfigFiles(configFiles, agentId) {
    const schema = getAgentConfigSchema(agentId);
    if (!schema?.configFiles?.length) {
        return { valid: !configFiles?.length, invalidPaths: [], invalidJson: [] };
    }
    const allowedPaths = new Set(schema.configFiles.map((f) => f.path));
    const invalidPaths = [];
    const invalidJson = [];
    for (const cf of configFiles || []) {
        if (!allowedPaths.has(cf.path)) {
            invalidPaths.push(cf.path);
        }
        const decl = schema.configFiles.find((f) => f.path === cf.path);
        if (decl?.format === 'json' && cf.content) {
            try {
                JSON.parse(cf.content);
            } catch (e) {
                invalidJson.push({ path: cf.path, error: e.message });
            }
        }
    }
    return { valid: invalidPaths.length === 0 && invalidJson.length === 0, invalidPaths, invalidJson };
}

/**
 * Write config files to the VM via the FS adapter.
 * Each file's path is resolved (replacing ${STATE_DIR}) and written via fsWrite.
 *
 * @param {object} fsAdapter - BoxLiteFsAdapter or LocalFsAdapter
 * @param {object} opts
 * @param {string} opts.workspaceRoot - workspace path in the VM
 * @param {string} opts.runtimeRef - blink session name
 * @param {Array} opts.configFiles - [{ path, content }]
 * @param {string|null} opts.stateDirPath - state directory path for ${STATE_DIR} resolution
 */
async function writeConfigFilesToVM(fsAdapter, { workspaceRoot, runtimeRef, configFiles, stateDirPath }) {
    if (!fsAdapter || typeof fsAdapter.fsWrite !== 'function') return;
    if (!configFiles?.length) return;
    for (const cf of configFiles) {
        if (!cf.path || !cf.content) continue;
        const resolvedPath = resolveConfigFilePath(cf.path, stateDirPath);
        if (!resolvedPath) continue;
        await fsAdapter.fsWrite(workspaceRoot, resolvedPath, cf.content, { runtimeRef });
    }
}

/**
 * Merge custom env into the resolved spawn env.
 * Custom env values are added on top of existing env (highest priority).
 */
function applyCustomEnv(env, customEnv, { blockedKeys = [] } = {}) {
    if (!customEnv || typeof customEnv !== 'object') return env;
    const blocked = new Set(blockedKeys);
    const result = { ...env };
    for (const [key, raw] of Object.entries(customEnv)) {
        if (blocked.has(key)) continue;
        const trimmed = raw != null ? String(raw).trim() : '';
        if (trimmed) result[key] = trimmed;
        else delete result[key];
    }
    return result;
}

/**
 * Resolve extra spawn args derived from gateway config or user-configured config files.
 *
 * Returns { prepend: string[], append: string[] } so callers can place
 * global flags (e.g. hermes --ignore-user-config) before the subcommand
 * and model flags (e.g. droid --model) after it.
 *
 * hermes (gateway): prepends --ignore-user-config so env vars take effect
 *   instead of config.yaml.
 * droid (gateway): appends --model <gatewayModel> from the gateway config.
 * droid (byok): appends --model <name> from the first customModel in
 *   .factory/settings.json (user-provided config file).
 *
 * @param {string} agentId
 * @param {Array} configFiles - [{ path, content }] (may be null/empty)
 * @param {object} [options]
 * @param {string} [options.authMode] - 'gateway' | 'byok'
 * @param {string} [options.gatewayModel] - gateway model target (provider/model)
 * @returns {{ prepend: string[], append: string[] }}
 */
function resolveAgentSpawnArgs(agentId, configFiles, options = {}) {
    const { authMode, gatewayModel } = options;
    const prepend = [];
    const append = [];

    if (agentId === 'hermes') {
        if (authMode === 'gateway' && gatewayModel) {
            prepend.push('-m', gatewayModel);
        } else if (configFiles?.length) {
            const cfg = configFiles.find((cf) => cf.path && cf.path.endsWith('config.yaml'));
            if (cfg?.content) {
                const modelMatch = cfg.content.match(/^  model: (.+)$/m);
                if (modelMatch?.[1]) prepend.push('-m', modelMatch[1]);
            }
        }
    }

    if (agentId === 'cline') {
        if (authMode === 'gateway' && gatewayModel) {
            prepend.push('-P', 'openai-compatible', '-m', gatewayModel);
        } else if (configFiles?.length) {
            const cfg = configFiles.find((cf) => cf.path && cf.path.endsWith('providers.json'));
            if (cfg?.content) {
                try {
                    const parsed = JSON.parse(cfg.content);
                    const settings = parsed?.providers?.['openai-compatible']?.settings;
                    if (settings) {
                        prepend.push('-P', 'openai-compatible');
                        if (settings.model) prepend.push('-m', settings.model);
                    }
                } catch (_) {}
            }
        }
    }

    if (agentId === 'droid') {
        if (authMode === 'gateway' && gatewayModel) {
            append.push('--model', gatewayModel);
        } else if (configFiles?.length) {
            const cfg = configFiles.find((cf) => cf.path && cf.path.endsWith('.factory/settings.json'));
            if (cfg?.content) {
                try {
                    const parsed = JSON.parse(cfg.content);
                    const model = parsed?.customModels?.[0]?.model;
                    if (typeof model === 'string' && model.trim()) {
                        append.push('--model', model.trim());
                    }
                } catch (_) { /* invalid json - ignore */ }
            }
        }
    }

    if (agentId === 'pi') {
        if (authMode === 'gateway' && gatewayModel) {
            prepend.push('--provider', 'gateway');
            prepend.push('--model', gatewayModel);
        } else if (configFiles?.length) {
            const cfg = configFiles.find((cf) => cf.path && cf.path.endsWith('models.json'));
            if (cfg?.content) {
                try {
                    const parsed = JSON.parse(cfg.content);
                    const providerName = Object.keys(parsed?.providers || {})[0];
                    if (providerName) {
                        prepend.push('--provider', providerName);
                        const model = parsed.providers[providerName]?.models?.[0]?.id;
                        if (model) prepend.push('--model', model);
                    }
                } catch (_) {}
            }
        }
    }

    if (agentId === 'codebuddy') {
        if (authMode === 'gateway' && gatewayModel) {
            prepend.push('--model', gatewayModel);
        } else if (configFiles?.length) {
            const cfg = configFiles.find((cf) => cf.path && cf.path.endsWith('models.json'));
            if (cfg?.content) {
                try {
                    const parsed = JSON.parse(cfg.content);
                    const model = Array.isArray(parsed)
                        ? parsed[0]?.id
                        : (parsed?.models?.[0]?.id || parsed?.id);
                    if (model) prepend.push('--model', model);
                } catch (_) {}
            }
        }
    }

    return { prepend, append };
}

/**
 * Save session config to DB (upsert).
 */
async function saveSessionConfig(db, schema, sessionId, { configFiles, customEnv }) {
    const now = Date.now();
    const existing = await db.select().from(schema.sessionConfigs)
        .where(eq(schema.sessionConfigs.sessionId, sessionId));
    if (existing.length > 0) {
        await db.update(schema.sessionConfigs)
            .set({
                configFiles: configFiles || [],
                customEnv: customEnv || {},
                updatedAt: now,
            })
            .where(eq(schema.sessionConfigs.sessionId, sessionId));
    } else {
        await db.insert(schema.sessionConfigs)
            .values({
                sessionId,
                configFiles: configFiles || [],
                customEnv: customEnv || {},
                createdAt: now,
                updatedAt: now,
            });
    }
}

/**
 * Get session config from DB.
 * Returns { configFiles: [], customEnv: {} } if not found.
 */
async function getSessionConfig(db, schema, sessionId) {
    const rows = await db.select().from(schema.sessionConfigs)
        .where(eq(schema.sessionConfigs.sessionId, sessionId));
    if (rows.length === 0) {
        return { configFiles: [], customEnv: {} };
    }
    const row = rows[0];
    return {
        configFiles: row.configFiles || [],
        customEnv: row.customEnv || {},
    };
}

module.exports = {
    getAgentConfigSchema,
    resolveConfigFilePath,
    validateConfigFiles,
    writeConfigFilesToVM,
    applyCustomEnv,
    resolveAgentSpawnArgs,
    saveSessionConfig,
    getSessionConfig,
};
