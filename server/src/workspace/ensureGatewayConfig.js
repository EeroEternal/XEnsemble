/**
 * Write agent-specific config files in gateway mode so the agent's LLM
 * requests are routed through the platform gateway (UniGateway).
 *
 * Only runs when authMode === 'gateway'.  BYOK mode is never affected.
 */

const GATEWAY_CONFIG_AGENTS = new Set([
    'qwen-code',
    'droid',
    'qoder',
    'openclaw',
    'minimax-cli',
    'pi',
    'cline',
    'glm-agent',
    'hermes',
    'codebuddy',
]);

function buildGatewayConfigSpec(agentId, { stateDirPath, sessionToken, routerUrl, modelTarget }) {
    switch (agentId) {
        case 'qwen-code':
            return {
                dirPath: stateDirPath,
                filePath: `${stateDirPath}/settings.json`,
                content: JSON.stringify({
                    general: { enableAutoUpdate: false },
                    model: { name: modelTarget },
                    modelProviders: {
                        gateway: [{
                            id: modelTarget,
                            baseUrl: `${routerUrl}/v1`,
                            envKey: 'OPENAI_API_KEY',
                        }],
                    },
                    providerProtocol: { gateway: 'openai' },
                    security: { auth: { selectedType: 'openai' } },
                }, null, 2),
            };

        case 'droid':
            return {
                dirPath: `${stateDirPath}/.factory`,
                filePath: `${stateDirPath}/.factory/settings.json`,
                content: JSON.stringify({
                    customModels: [{
                        provider: 'generic-chat-completion-api',
                        model: modelTarget,
                        displayName: modelTarget,
                        baseUrl: `${routerUrl}/v1`,
                        apiKey: sessionToken,
                    }],
                }, null, 2),
            };

        case 'qoder':
            return {
                dirPath: stateDirPath,
                filePath: `${stateDirPath}/settings.json`,
                content: JSON.stringify({
                    general: { enableAutoUpdate: false },
                    model: `gateway/${modelTarget}`,
                    providers: {
                        gateway: {
                            baseUrl: routerUrl,
                            apiKey: sessionToken,
                            displayName: 'XEnsemble Gateway',
                            model: modelTarget,
                            type: 'openai-compatible',
                            maxOutputTokens: 8192,
                            models: [{
                                model: modelTarget,
                                displayName: modelTarget,
                                maxOutputTokens: 8192,
                            }],
                        },
                    },
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
                            model: { primary: `gateway/${modelTarget}` },
                        },
                    },
                    models: {
                        mode: 'merge',
                        providers: {
                            gateway: {
                                baseUrl: `${routerUrl}/v1`,
                                apiKey: sessionToken,
                                api: 'openai-completions',
                                models: [{
                                    id: modelTarget,
                                    name: modelTarget,
                                }],
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
                            models: [{
                                id: modelTarget,
                                name: modelTarget,
                            }],
                        },
                    },
                }, null, 2),
            };
        case 'cline':
            // cline reads provider config from ${CLINE_DATA_DIR}/settings/providers.json.
            // Default provider is "cline" (cline's own API); must override the
            // "openai-compatible" provider to point at the gateway, otherwise
            // cline requests go to api.openai.com and reject the session token.
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
                                model: modelTarget,
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
                    defaultModel: modelTarget,
                    models: [modelTarget],
                    watchEnabled: false,
                    watchDebounceMs: 300,
                    enableHistory: true,
                    apiKey: sessionToken,
                }, null, 2),
            };

        case 'codebuddy': {
            // CodeBuddy reads models.json from $CODEBUDDY_CONFIG_DIR — which
            // resumeSession sets to the session state dir (stateEnv) — NOT from
            // ~/.codebuddy. Writes must target that dir, otherwise the custom
            // model is not registered and CodeBuddy falls back to its official
            // models (gemini/gpt/deepseek-v3-2-volc/...), which require a Tencent
            // CodeBuddy login; CODEBUDDY_API_KEY then overrides /login (blocked)
            // and the gateway JWT is rejected. The url must be a full
            // /chat/completions path. trustAll/trustedDirectories avoid the
            // interactive "trust this folder?" prompt (CodeBuddy treats /tmp,
            // /root and $HOME as dangerous).
            const configDir = stateDirPath || '$HOME/.codebuddy';
            return {
                dirPath: configDir,
                filePath: `${configDir}/models.json`,
                content: JSON.stringify([{
                    id: modelTarget,
                    name: modelTarget,
                    vendor: 'custom',
                    apiKey: sessionToken,
                    url: `${routerUrl}/v1/chat/completions`,
                    maxOutputTokens: 8192,
                }], null, 2),
                extraFiles: [{
                    dirPath: configDir,
                    filePath: `${configDir}/settings.json`,
                    content: JSON.stringify({
                        trustAll: true,
                        trustedDirectories: ['/workspace', '/tmp'],
                    }, null, 2),
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
            return {
                dirPath: stateDirPath,
                filePath: `${stateDirPath}/config.yaml`,
                content: [
                    'model:',
                    `  default: "${modelTarget}"`,
                    '  provider: "auto"',
                    `  base_url: "${routerUrl}/v1"`,
                    `  api_key: "${sessionToken}"`,
                ].join('\n') + '\n',
            };

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

async function ensureGatewayConfig({ runtime, runtimeRef, agentId, authMode, stateDirPath, sessionToken, routerUrl, modelTarget, warn }) {
    if (authMode !== 'gateway') {
        return { skipped: true, reason: 'not_gateway' };
    }
    if (!GATEWAY_CONFIG_AGENTS.has(agentId)) {
        return { skipped: true, reason: 'no_config_needed' };
    }
    if (!sessionToken || !routerUrl || !modelTarget) {
        return { skipped: true, reason: 'no_gateway_credentials' };
    }
    if (!runtime?.exec?.exec) {
        return { skipped: true, reason: 'no_runtime_exec' };
    }
    // minimax-cli and pi use $HOME (no state dir); codebuddy prefers the
    // state dir (CODEBUDDY_CONFIG_DIR) but falls back to $HOME/.codebuddy;
    // all others require a state dir path.
    if (agentId !== 'minimax-cli' && agentId !== 'pi' && agentId !== 'codebuddy' && !stateDirPath) {
        return { skipped: true, reason: 'no_state_dir' };
    }

    const spec = buildGatewayConfigSpec(agentId, { stateDirPath, sessionToken, routerUrl, modelTarget });
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
