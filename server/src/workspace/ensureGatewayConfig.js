/**
 * Write agent-specific config files in gateway mode so the agent's LLM
 * requests are routed through the platform gateway (UniGateway).
 *
 * Only runs when authMode === 'gateway'.  BYOK mode is never affected.
 */

const { guessContextLength } = require('../llm/modelContext');

const GATEWAY_CONFIG_AGENTS = new Set([
    'qwen-code',
    'droid',
    'openclaw',
    'minimax-cli',
    'pi',
    'cline',
    'glm-agent',
    'hermes',
    'codebuddy',
    'kimi-code',
    'opencode',
]);

function buildGatewayConfigSpec(agentId, { stateDirPath, sessionToken, routerUrl, modelTarget, modelTargets, defaultTarget }) {
    const targets = (Array.isArray(modelTargets) && modelTargets.length
        ? modelTargets.map((t) => String(t ?? '').trim())
        : (modelTarget ? [String(modelTarget).trim()] : [])
    ).filter(Boolean);
    const def = (defaultTarget ?? modelTarget ?? targets[0] ?? '').trim();
    if (targets.length === 0) return null;
    switch (agentId) {
        case 'qwen-code':
            return {
                dirPath: stateDirPath,
                filePath: `${stateDirPath}/settings.json`,
                content: JSON.stringify({
                    general: { enableAutoUpdate: false },
                    model: { name: def },
                    modelProviders: {
                        gateway: targets.map((t) => ({
                            id: t,
                            baseUrl: `${routerUrl}/v1`,
                            envKey: 'OPENAI_API_KEY',
                            generationConfig: { contextWindowSize: guessContextLength(t) },
                        })),
                    },
                    providerProtocol: { gateway: 'openai' },
                    security: { auth: { selectedType: 'openai' } },
                }, null, 2),
            };

        case 'droid':
            // Factory Droid uses compactionTokenLimit (and per-model overrides
            // compactionTokenLimitPerModel) as the context-window knob. The
            // threshold that triggers auto-compaction. guessContextLength feeds
            // both a per-model map (best effort) and a generic fallback.
            return {
                dirPath: `${stateDirPath}/.factory`,
                filePath: `${stateDirPath}/.factory/settings.json`,
                content: JSON.stringify({
                    customModels: targets.map((t) => ({
                        provider: 'generic-chat-completion-api',
                        model: t,
                        displayName: t,
                        baseUrl: `${routerUrl}/v1`,
                        apiKey: sessionToken,
                    })),
                    compactionTokenLimit: Math.max(...targets.map((t) => guessContextLength(t))),
                    compactionTokenLimitPerModel: Object.fromEntries(
                        targets.map((t) => [t, guessContextLength(t)]),
                    ),
                }, null, 2),
            };

        case 'openclaw':
            return {
                dirPath: stateDirPath,
                filePath: `${stateDirPath}/openclaw.json`,
                content: JSON.stringify({
                    logging: { level: 'info' },
                    agents: {
                        defaults: {
                            model: { primary: `gateway/${def}` },
                        },
                    },
                    models: {
                        mode: 'replace',
                        providers: {
                            gateway: {
                                baseUrl: `${routerUrl}/v1`,
                                apiKey: sessionToken,
                                api: 'openai-completions',
                                models: targets.map((t) => ({
                                    id: t,
                                    name: t,
                                    contextWindow: guessContextLength(t),
                                })),
                            },
                        },
                    },
                }, null, 2),
            };

        case 'minimax-cli':
            return {
                dirPath: null,
                filePath: '$HOME/.mmx/config.json',
                content: JSON.stringify({
                    api_key: sessionToken,
                    base_url: routerUrl,
                }, null, 2),
            };

        case 'pi':
            return {
                dirPath: '$HOME/.pi/agent',
                filePath: '$HOME/.pi/agent/models.json',
                content: JSON.stringify({
                    providers: {
                        gateway: {
                            baseUrl: `${routerUrl}/v1`,
                            api: 'openai-completions',
                            apiKey: sessionToken,
                            models: targets.map((t) => ({
                                id: t,
                                name: t,
                                contextWindow: guessContextLength(t),
                            })),
                        },
                    },
                }, null, 2),
            };
        case 'cline':
            // cline reads provider config from ${CLINE_DATA_DIR}/settings/providers.json.
            // Default provider is "cline" (cline's own API); must override the
            // "openai-compatible" provider to point at the gateway, otherwise
            // cline requests go to api.openai.com and reject the session token.
            // The provider `models` record enumerates selectable models so /model
            // offers every configured gateway model (not just the default).
            // contextWindow is written per the cline UI "Context Window size" field;
            // the exact JSON key isn't fully documented, but writing a camelCase
            // variant is the closest match and harmless if ignored.
            return {
                dirPath: `${stateDirPath}/settings`,
                filePath: `${stateDirPath}/settings/providers.json`,
                content: JSON.stringify({
                    version: 1,
                    lastUsedProvider: 'openai-compatible',
                    providers: {
                        'openai-compatible': {
                            settings: {
                                provider: 'openai-compatible',
                                model: def,
                                models: Object.fromEntries(targets.map((t) => [t, { id: t, contextWindow: guessContextLength(t) }])),
                                baseUrl: `${routerUrl}/v1`,
                                apiKey: sessionToken,
                            },
                            updatedAt: new Date().toISOString(),
                            tokenSource: 'manual',
                        },
                    },
                }, null, 2),
            };

        case 'glm-agent':
            // zai reads baseURL / apiKey / defaultModel from user-settings.json.
            // env vars (ZAI_BASE_URL / ZAI_API_KEY / ZAI_MODEL) are injected but
            // zai does not read them; without this file zai prompts for config.
            return {
                dirPath: `${stateDirPath}/.zai`,
                filePath: `${stateDirPath}/.zai/user-settings.json`,
                content: JSON.stringify({
                    baseURL: `${routerUrl}/v1`,
                    defaultModel: def,
                    models: targets.slice(),
                    watchEnabled: false,
                    watchDebounceMs: 300,
                    enableHistory: true,
                    apiKey: sessionToken,
                }, null, 2),
            };

        case 'codebuddy': {
            // CodeBuddy reads models.json from $CODEBUDDY_CONFIG_DIR - which
            // resumeSession sets to the session state dir (stateEnv) - NOT from
            // ~/.codebuddy. Writes must target that dir, otherwise the custom
            // model is not registered and CodeBuddy falls back to its official
            // models (gemini/gpt/deepseek-v3-2-volc/...), which require a Tencent
            // CodeBuddy login; CODEBUDDY_API_KEY then overrides /login (blocked)
            // and the gateway JWT is rejected. The url must be a full
            // /chat/completions path. trustAll/trustedDirectories avoid the
            // interactive "trust this folder?" prompt (CodeBuddy treats /tmp,
            // /root and $HOME as dangerous).
            //
            // The context window is `maxInputTokens` (NOT `maxOutputTokens`),
            // per CodeBuddy's official models.json schema. The settings.json
            // we also write here carries autoCompactWindow so the compaction
            // threshold matches the model's real context (clamped by CodeBuddy
            // to [100k, 1M] regardless).
            const configDir = stateDirPath || '$HOME/.codebuddy';
            return {
                dirPath: configDir,
                filePath: `${configDir}/models.json`,
                content: JSON.stringify(targets.map((t) => ({
                    id: t,
                    name: t,
                    vendor: 'custom',
                    apiKey: sessionToken,
                    url: `${routerUrl}/v1/chat/completions`,
                    maxInputTokens: guessContextLength(t),
                    maxOutputTokens: 8192,
                })), null, 2),
                extraFiles: [{
                    dirPath: configDir,
                    filePath: `${configDir}/settings.json`,
                    content: JSON.stringify({
                        autoCompactEnabled: true,
                        // codebuddy clamps autoCompactWindow to [100k, 1M], so
                        // writing the model's actual context here just lets it
                        // reach the upper bound for known 1M models.
                        autoCompactWindow: Math.max(
                            100000,
                            Math.min(1000000, ...targets.map((t) => guessContextLength(t))),
                        ),
                        trustAll: true,
                        trustedDirectories: ['/workspace', '/tmp'],
                    }, null, 2),
                }],
            };
        }

        case 'kimi-code': {
            // Kimi Code reads config from $KIMI_CODE_HOME/config.toml (the session
            // state dir, NOT ~/.kimi/ which is the legacy kimi-cli home - writing
            // there triggers kimi-code's "Migrate from kimi-cli" prompt). In
            // gateway mode, list every configured model under a gateway
            // (openai-compatible) provider so /model offers all of them; the
            // primary is the default. KIMI_MODEL_* env vars
            // (applyKimiCodeGatewayEnv) still synthesize the active model, but
            // kimi's applyEnvModelConfig MERGES (not replaces) config.toml
            // models, so every entry here stays selectable.
            //
            // The .skip-migration-from-kimi-cli marker is written alongside
            // config.toml so kimi-code never prompts to migrate from a legacy
            // ~/.kimi/ installation (which ensureKimiConfig in BYOK mode or a
            // stale sandbox might leave behind).
            const defaultIndex = Math.max(0, targets.indexOf(def));
            const defaultAlias = `gateway-${defaultIndex}`;
            const sections = targets.map((t, i) => [
                `[models.gateway-${i}]`,
                'provider = "gateway"',
                `model = ${JSON.stringify(t)}`,
                `max_context_size = ${guessContextLength(t)}`,
            ].join('\n'));
            return {
                dirPath: stateDirPath,
                filePath: `${stateDirPath}/config.toml`,
                content: [
                    '# Generated by XEnsemble - gateway provider for Kimi Code',
                    `default_model = ${JSON.stringify(defaultAlias)}`,
                    'default_provider = "gateway"',
                    '',
                    '[providers.gateway]',
                    'type = "openai"',
                    `base_url = ${JSON.stringify(`${routerUrl}/v1`)}`,
                    `api_key = ${JSON.stringify(sessionToken)}`,
                    '',
                    ...sections,
                    '',
                ].join('\n') + '\n',
                extraFiles: [{
                    dirPath: stateDirPath,
                    filePath: `${stateDirPath}/.skip-migration-from-kimi-cli`,
                    content: '',
                }],
            };
        }

        case 'hermes':
            // hermes loads $HERMES_HOME/config.yaml and its _resolve_openrouter_runtime
            // prioritises config.yaml base_url over OPENROUTER_BASE_URL env var when
            // provider is "auto" and cfg_base_url is set. The hermes installer creates
            // a default config.yaml with base_url: "https://openrouter.ai/api/v1",
            // which overrides the gateway env vars. We must write a config.yaml that
            // points at the gateway so requests route correctly.
            //
            // provider must be "auto" (not "openrouter") because
            // _resolve_openrouter_runtime only honours cfg_base_url when
            // cfg_provider is empty or "auto". With provider: "openrouter",
            // the env var OPENROUTER_BASE_URL would win instead.
            //
            // model.context_length and model.max_tokens are the official knobs for
            // the model metadata (see minimax mmx-cli Hermes schema). Each per-provider
            // model entry also accepts context_length so providers can override it.
            return {
                dirPath: stateDirPath,
                filePath: `${stateDirPath}/config.yaml`,
                content: [
                    'model:',
                    `  default: "${def}"`,
                    '  provider: "auto"',
                    `  base_url: "${routerUrl}/v1"`,
                    `  api_key: "${sessionToken}"`,
                    `  context_length: ${guessContextLength(def)}`,
                    `  max_tokens: 8192`,
                    'providers:',
                    '  auto:',
                    '    base_url: "' + routerUrl + '/v1"',
                    '    api_key: "' + sessionToken + '"',
                    '    models:',
                    ...targets.map((t) => `      "${t}":`),
                    ...targets.map((t) => [
                        '        id: "' + t + '"',
                        `        context_length: ${guessContextLength(t)}`,
                    ].join('\n')),
                ].join('\n') + '\n',
            };

        case 'opencode': {
            const { toOpencodeModelAlias } = require('../agents/agentModelAlias');
            const ocModels = {};
            for (const t of targets) {
                const realId = t.includes('/') ? t.split('/').slice(1).join('/') : t;
                const modelId = toOpencodeModelAlias(realId);
                ocModels[modelId] = {
                    name: modelId,
                    // limit.context overrides the context window that opencode
                    // would otherwise pull from Models.dev; the latter is often
                    // missing for newly-released / long-tail models, which is
                    // why we set it from guessContextLength() instead.
                    limit: { context: guessContextLength(realId), output: 8192 },
                };
            }
            const defReal = def.includes('/') ? def.split('/').slice(1).join('/') : def;
            const defId = toOpencodeModelAlias(defReal);
            return {
                dirPath: '/root/.config/opencode',
                filePath: '/root/.config/opencode/opencode.json',
                content: JSON.stringify({
                    autoupdate: false,
                    model: `gateway/${defId}`,
                    provider: {
                        gateway: {
                            npm: '@ai-sdk/openai-compatible',
                            name: 'gateway',
                            options: {
                                baseURL: routerUrl,
                                apiKey: sessionToken,
                            },
                            models: ocModels,
                        },
                    },
                }, null, 2),
            };
        }

        default:
            return null;
    }
}

function buildWriteScript(spec) {
    const lines = ['set -e'];

    const writeFile = (dirPath, filePath, content) => {
        const encoded = Buffer.from(content, 'utf8').toString('base64');
        if (dirPath && dirPath.includes('$')) {
            lines.push(`mkdir -p "${dirPath}"`);
        } else if (dirPath) {
            lines.push(`mkdir -p '${dirPath.replace(/'/g, "'\\''")}'`);
        } else {
            lines.push('mkdir -p "$HOME/.mmx"');
        }
        if (filePath.includes('$')) {
            lines.push(`printf '%s' ${JSON.stringify(encoded)} | base64 -d > "${filePath}"`);
        } else {
            lines.push(`printf '%s' ${JSON.stringify(encoded)} | base64 -d > '${filePath.replace(/'/g, "'\\''")}'`);
        }
    };

    writeFile(spec.dirPath, spec.filePath, spec.content);
    for (const extra of spec.extraFiles || []) {
        writeFile(extra.dirPath, extra.filePath, extra.content);
    }
    return lines.join('\n');
}

async function ensureGatewayConfig({ runtime, runtimeRef, agentId, authMode, stateDirPath, sessionToken, routerUrl, modelTarget, modelTargets, defaultTarget, warn }) {
    if (authMode !== 'gateway') {
        return { skipped: true, reason: 'not_gateway' };
    }
    if (!GATEWAY_CONFIG_AGENTS.has(agentId)) {
        return { skipped: true, reason: 'no_config_needed' };
    }
    const hasTargets = Array.isArray(modelTargets) && modelTargets.some((t) => String(t ?? '').trim());
    if (!sessionToken || !routerUrl || (!modelTarget && !hasTargets)) {
        return { skipped: true, reason: 'no_gateway_credentials' };
    }
    if (!runtime?.exec?.exec) {
        return { skipped: true, reason: 'no_runtime_exec' };
    }
    // minimax-cli and pi use $HOME (no state dir); codebuddy prefers the
    // state dir (CODEBUDDY_CONFIG_DIR) but falls back to $HOME/.codebuddy;
    // all others require a state dir path.
    if (agentId !== 'minimax-cli' && agentId !== 'pi' && agentId !== 'codebuddy' && agentId !== 'kimi-code' && agentId !== 'opencode' && !stateDirPath) {
        return { skipped: true, reason: 'no_state_dir' };
    }

    const spec = buildGatewayConfigSpec(agentId, { stateDirPath, sessionToken, routerUrl, modelTarget, modelTargets, defaultTarget });
    if (!spec) {
        return { skipped: true, reason: 'no_config_needed' };
    }

    const script = buildWriteScript(spec);

    try {
        const result = await runtime.exec.exec(
            'sh',
            ['-lc', script],
            {},
            { runtimeRef, cwd: '/' },
        );
        if (result.exitCode !== 0) {
            const message = `gateway config bootstrap failed with exit ${result.exitCode}`;
            warn?.(message);
            return { skipped: false, ok: false, error: message };
        }
        return { skipped: false, ok: true };
    } catch (err) {
        const message = err?.message || 'gateway config bootstrap failed';
        warn?.(message);
        return { skipped: false, ok: false, error: message };
    }
}

module.exports = {
    ensureGatewayConfig,
    GATEWAY_CONFIG_AGENTS,
    buildGatewayConfigSpec,
};
