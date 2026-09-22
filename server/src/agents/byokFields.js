/**
 * BYOK (Bring Your Own Key) field definitions and config generators.
 *
 * Each field definition: { key, label, tooltip, type, defaultValue, required }
 *   type: 'string' | 'secret' | 'number'
 *
 * Storage: all field values for an agent are stored as a JSON blob in the
 * user's encrypted secrets under the key `__byok_<agentId>`. Env field values
 * are ALSO stored as individual secret keys so resolveSpawnEnv() can pick up
 * required env vars without changes.
 */

const BYOK_FIELDS = {
    'kimi-code': {
        description: 'Only fill API Key to use Kimi/Moonshot. Fill a custom Base URL to use a different OpenAI-compatible endpoint.',
        fields: [
            { key: 'api_key', label: 'API Key', tooltip: 'Moonshot/Kimi API 密钥', type: 'secret', defaultValue: '', required: true },
            { key: 'base_url', label: 'Base URL', tooltip: 'API 基础地址', type: 'string', defaultValue: 'https://api.moonshot.cn/v1', required: false },
            { key: 'model', label: 'Model', tooltip: '模型 ID', type: 'string', defaultValue: 'kimi-k2.5', required: false },
            { key: 'max_context_size', label: 'Max Context Size', tooltip: '最大上下文窗口（token 数）', type: 'number', defaultValue: 1048576, required: false },
        ],
    },
    'claude-code': {
        description: 'Only fill API Key to use Anthropic Claude. Fill Base URL + Model to customize the endpoint.',
        fields: [
            { key: 'ANTHROPIC_API_KEY', label: 'API Key', tooltip: 'Anthropic API 密钥', type: 'secret', defaultValue: '', required: true },
            { key: 'ANTHROPIC_BASE_URL', label: 'Base URL', tooltip: 'API 基础地址，可填代理地址', type: 'string', defaultValue: 'https://api.anthropic.com', required: false },
            { key: 'ANTHROPIC_MODEL', label: 'Model', tooltip: '主模型 ID', type: 'string', defaultValue: '', required: false },
            { key: 'ANTHROPIC_SMALL_FAST_MODEL', label: 'Small/Fast Model', tooltip: '轻量快速模型 ID（用于简单任务）', type: 'string', defaultValue: '', required: false },
        ],
    },
    'opencode': {
        description: 'Only fill API Key to use OpenAI. Fill Base URL + Model + Provider to customize.',
        fields: [
            { key: 'apiKey', label: 'API Key', tooltip: 'LLM Provider API 密钥', type: 'secret', defaultValue: '', required: true },
            { key: 'baseURL', label: 'Base URL', tooltip: 'API 基础地址', type: 'string', defaultValue: 'https://api.openai.com/v1', required: false },
            { key: 'model', label: 'Model', tooltip: '默认模型，格式为 provider/model', type: 'string', defaultValue: 'openai/gpt-4o', required: false },
            { key: 'provider', label: 'Provider Name', tooltip: 'Provider 标识名', type: 'string', defaultValue: 'openai', required: false },
        ],
    },
    'cline': {
        description: 'Only fill API Key to use Anthropic Claude (official default). Fill Base URL + Model to use a custom OpenAI-compatible provider.',
        fields: [
            { key: 'ANTHROPIC_API_KEY', label: 'API Key', tooltip: 'Anthropic API 密钥（仅填此项, cline 使用官方 Anthropic 默认配置）', type: 'secret', defaultValue: '', required: true },
            { key: 'baseUrl', label: 'Base URL', tooltip: '自定义 Provider API 基础地址（填了此项后, cline 将使用自定义 OpenAI 兼容 provider）', type: 'string', defaultValue: '', required: false },
            { key: 'model', label: 'Model', tooltip: '模型 ID（配合自定义 Base URL 使用）', type: 'string', defaultValue: '', required: false },
        ],
    },
    'droid': {
        description: 'Only fill API Key to use a custom model. Fill Base URL + Model to customize the endpoint.',
        fields: [
            { key: 'apiKey', label: 'API Key', tooltip: 'LLM Provider API 密钥', type: 'secret', defaultValue: '', required: true },
            { key: 'baseUrl', label: 'Base URL', tooltip: 'API 基础地址', type: 'string', defaultValue: 'https://api.openai.com/v1', required: false },
            { key: 'model', label: 'Model', tooltip: '模型 ID', type: 'string', defaultValue: 'gpt-4o', required: false },
            { key: 'provider', label: 'Provider Type', tooltip: 'Provider 类型', type: 'string', defaultValue: 'generic-chat-completion-api', required: false },
        ],
    },
    'glm-agent': {
        description: 'Only fill API Key to use Z.AI GLM. Fill Base URL + Model to customize.',
        fields: [
            { key: 'apiKey', label: 'API Key', tooltip: 'Z.AI API 密钥', type: 'secret', defaultValue: '', required: true },
            { key: 'baseURL', label: 'Base URL', tooltip: 'API 基础地址', type: 'string', defaultValue: 'https://api.z.ai/api/coding/paas/v4', required: false },
            { key: 'defaultModel', label: 'Model', tooltip: '默认模型 ID', type: 'string', defaultValue: 'glm-4.6', required: false },
        ],
    },
    'qoder': {
        description: 'Only fill Qoder Token for Qoder official API. Fill Custom Provider to add your own endpoint.',
        fields: [
            { key: 'QODER_PERSONAL_ACCESS_TOKEN', label: 'Access Token', tooltip: 'Qoder 平台访问令牌', type: 'secret', defaultValue: '', required: true },
            { key: 'apiKey', label: 'Provider API Key', tooltip: 'LLM Provider API 密钥（选填，不填则使用 Qoder 官方 API）', type: 'secret', defaultValue: '', required: false },
            { key: 'baseUrl', label: 'Base URL', tooltip: 'API 基础地址（选填）', type: 'string', defaultValue: '', required: false },
            { key: 'model', label: 'Model', tooltip: '模型 ID（选填）', type: 'string', defaultValue: '', required: false },
        ],
    },
    'qwen-code': {
        description: 'Only fill DashScope Key for Qwen official API. Fill Custom Provider to add your own endpoint.',
        fields: [
            { key: 'DASHSCOPE_API_KEY', label: 'API Key', tooltip: '阿里云 DashScope API 密钥（用于 Qwen 默认模型）', type: 'secret', defaultValue: '', required: true },
            { key: 'customApiKey', label: 'Custom Provider Key', tooltip: '自定义 Provider 的 API 密钥（选填，填了则使用自定义 Provider 而非 DashScope）', type: 'secret', defaultValue: '', required: false },
            { key: 'baseUrl', label: 'Custom Base URL', tooltip: '自定义 Provider API 基础地址（选填，配合 customApiKey 使用）', type: 'string', defaultValue: '', required: false },
            { key: 'model', label: 'Custom Model', tooltip: '自定义模型 ID（选填，配合 customApiKey 使用）', type: 'string', defaultValue: '', required: false },
            { key: 'max_context_size', label: 'Max Context Size', tooltip: '自定义模型的上下文窗口（token 数；填了则写入 generationConfig.contextWindowSize，覆盖 qwen 内置 200K 兜底）', type: 'number', defaultValue: 1048576, required: false },
        ],
    },
    'minimax-cli': {
        description: 'Only fill API Key to use MiniMax.',
        fields: [
            { key: 'MINIMAX_API_KEY', label: 'API Key', tooltip: 'MiniMax API 密钥', type: 'secret', defaultValue: '', required: true },
        ],
    },
    'pi': {
        description: 'Only fill Anthropic/OpenAI API Keys for Pi\'s built-in providers. Fill Custom Provider to add your own OpenAI-compatible endpoint.',
        fields: [
            { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key', tooltip: 'Anthropic API 密钥', type: 'secret', defaultValue: '', required: true },
            { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', tooltip: 'OpenAI API 密钥', type: 'secret', defaultValue: '', required: true },
            { key: 'apiKey', label: 'Custom Provider Key', tooltip: '自定义 Provider API 密钥（选填，填了则注册自定义 OpenAI 兼容 provider）', type: 'secret', defaultValue: '', required: false },
            { key: 'baseUrl', label: 'Custom Base URL', tooltip: '自定义 Provider API 地址（选填）', type: 'string', defaultValue: '', required: false },
            { key: 'model', label: 'Custom Model', tooltip: '自定义模型 ID（选填）', type: 'string', defaultValue: '', required: false },
        ],
    },
    'commandcode': {
        description: 'Only fill API Key to use Cohere.',
        fields: [
            { key: 'COHERE_API_KEY', label: 'API Key', tooltip: 'Cohere API 密钥', type: 'secret', defaultValue: '', required: true },
        ],
    },
    'hermes': {
        description: 'Only fill API Key to use Hermes with a custom provider. Fill Base URL + Model to customize the endpoint.',
        fields: [
            { key: 'api_key', label: 'API Key', tooltip: 'LLM Provider API 密钥', type: 'secret', defaultValue: '', required: true },
            { key: 'base_url', label: 'Base URL', tooltip: 'API 基础地址', type: 'string', defaultValue: 'https://api.openai.com/v1', required: false },
            { key: 'model', label: 'Model', tooltip: '模型 ID', type: 'string', defaultValue: 'gpt-4o', required: false },
            { key: 'api_mode', label: 'API Mode', tooltip: 'API 协议模式', type: 'string', defaultValue: 'openai', required: false },
            { key: 'max_context_size', label: 'Max Context Size', tooltip: '模型的上下文窗口（token 数；填了则写入 model.context_length）', type: 'number', defaultValue: 1048576, required: false },
        ],
    },
    'openclaw': {
        description: 'Only fill API Key to use OpenAI. Fill Base URL + Model to customize.',
        fields: [
            { key: 'apiKey', label: 'API Key', tooltip: 'LLM Provider API 密钥', type: 'secret', defaultValue: '', required: true },
            { key: 'baseUrl', label: 'Base URL', tooltip: 'API 基础地址', type: 'string', defaultValue: 'https://api.openai.com/v1', required: false },
            { key: 'model', label: 'Model', tooltip: '模型 ID', type: 'string', defaultValue: 'gpt-4o', required: false },
            { key: 'api', label: 'API Type', tooltip: 'API 协议类型', type: 'string', defaultValue: 'openai-completions', required: false },
        ],
    },
    'github-copilot': {
        description: 'Only fill API Key to use OpenAI. Fill Base URL + Model to customize.',
        fields: [
            { key: 'apiKey', label: 'API Key', tooltip: 'LLM Provider API 密钥', type: 'secret', defaultValue: '', required: true },
            { key: 'baseUrl', label: 'Base URL', tooltip: 'API 基础地址', type: 'string', defaultValue: 'https://api.openai.com/v1', required: false },
            { key: 'model', label: 'Model', tooltip: '模型 ID', type: 'string', defaultValue: 'gpt-4o', required: false },
        ],
    },
    'codebuddy': {
        description: 'Only fill API Key to use a custom model. Fill Base URL + Model to customize the endpoint.',
        fields: [
            { key: 'apiKey', label: 'API Key', tooltip: 'LLM Provider API 密钥', type: 'secret', defaultValue: '', required: true },
            { key: 'baseUrl', label: 'Base URL', tooltip: 'API 基础地址（需包含 /v1/chat/completions 路径）', type: 'string', defaultValue: 'https://api.openai.com/v1/chat/completions', required: false },
            { key: 'model', label: 'Model', tooltip: '模型 ID', type: 'string', defaultValue: 'gpt-4o', required: false },
            { key: 'max_context_size', label: 'Max Context Size', tooltip: '模型的上下文窗口（token 数；填了则写入 models.json 的 maxInputTokens）', type: 'number', defaultValue: 1048576, required: false },
        ],
    },
    'cursor': {
        description: 'Only fill API Key to use OpenAI. Fill Base URL + Model to customize.',
        fields: [
            { key: 'apiKey', label: 'API Key', tooltip: 'LLM Provider API 密钥', type: 'secret', defaultValue: '', required: true },
            { key: 'baseUrl', label: 'Base URL', tooltip: 'API 基础地址', type: 'string', defaultValue: 'https://api.openai.com/v1', required: false },
            { key: 'model', label: 'Model', tooltip: '模型 ID', type: 'string', defaultValue: 'gpt-4o', required: false },
        ],
    },
    'amp': {
        description: 'Only fill API Key to use OpenAI. Fill Base URL + Model to customize.',
        fields: [
            { key: 'apiKey', label: 'API Key', tooltip: 'LLM Provider API 密钥', type: 'secret', defaultValue: '', required: true },
            { key: 'baseUrl', label: 'Base URL', tooltip: 'API 基础地址', type: 'string', defaultValue: 'https://api.openai.com/v1', required: false },
            { key: 'model', label: 'Model', tooltip: '模型 ID', type: 'string', defaultValue: 'gpt-4o', required: false },
        ],
    },
};

function byokStorageKey(agentId) {
    return `__byok_${agentId}`;
}

function str(v) {
    return v != null ? String(v).trim() : '';
}

/**
 * Read BYOK field values from the user's decrypted secrets blob.
 * @param {string} agentId
 * @param {object} secrets - decrypted user secrets (key -> string value)
 * @returns {object} field values keyed by field.key
 */
function getByokFieldValues(agentId, secrets) {
    if (!secrets) return {};
    const blob = secrets[byokStorageKey(agentId)];
    if (!blob) return {};
    try {
        const parsed = JSON.parse(blob);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * Generate env vars + config files from BYOK field values.
 * @param {string} agentId
 * @param {object} values - field values keyed by field.key
 * @returns {{ env: object, configFiles: Array<{path: string, content: string}> }}
 */
function generateByokConfig(agentId, values) {
    if (!values || typeof values !== 'object') return { env: {}, configFiles: [] };
    switch (agentId) {
        case 'kimi-code': return generateKimiCode(values);
        case 'claude-code': return generateClaudeCode(values);
        case 'opencode': return generateOpencode(values);
        case 'cline': return generateCline(values);
        case 'droid': return generateDroid(values);
        case 'glm-agent': return generateGlmAgent(values);
        case 'qoder': return generateQoder(values);
        case 'qwen-code': return generateQwenCode(values);
        case 'minimax-cli': return generateSimpleEnv(values, ['MINIMAX_API_KEY']);
        case 'pi': return generatePi(values);
        case 'commandcode': return generateSimpleEnv(values, ['COHERE_API_KEY']);
        case 'hermes': return generateHermes(values);
        case 'openclaw': return generateOpenclaw(values);
        case 'github-copilot': return generateGithubCopilot(values);
        case 'codebuddy': return generateCodebuddy(values);
        case 'cursor': return generateCursor(values);
        case 'amp': return generateAmp(values);
        default: return { env: {}, configFiles: [] };
    }
}

// ── Env-only generator for single-key agents (minimax-cli, commandcode) ──

function generateSimpleEnv(values, keys) {
    const env = {};
    for (const k of keys) {
        const v = str(values[k]);
        if (v) env[k] = v;
    }
    return { env, configFiles: [] };
}

// ── cline (env-only for default, config file for custom provider) ──

function generateCline(values) {
    const env = {};
    const configFiles = [];
    const apiKey = str(values.ANTHROPIC_API_KEY);
    const baseUrl = str(values.baseUrl);
    const model = str(values.model);

    if (!apiKey) return { env, configFiles };

    env.ANTHROPIC_API_KEY = apiKey;

    // Only generate providers.json when user explicitly fills baseUrl (custom provider).
    if (baseUrl) {
        const configDir = '${STATE_DIR}';
        configFiles.push({
            path: `${configDir}/settings/providers.json`,
            content: JSON.stringify({
                version: 1,
                lastUsedProvider: 'openai-compatible',
                providers: {
                    'openai-compatible': {
                        settings: {
                            provider: 'openai-compatible',
                            model: model || 'gpt-4o',
                            baseUrl: baseUrl,
                            apiKey: apiKey,
                        },
                        updatedAt: new Date().toISOString(),
                        tokenSource: 'manual',
                    },
                },
            }, null, 2),
        });
    }

    return { env, configFiles };
}

// ── claude-code (env only) ──

function generateClaudeCode(values) {
    const env = {};
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) {
        const v = str(values[k]);
        if (v) env[k] = v;
    }
    return { env, configFiles: [] };
}

// ── kimi-code (config.toml) ──

function generateKimiCode(values) {
    const env = {};
    const configFiles = [];
    const apiKey = str(values.api_key);
    const baseUrl = str(values.base_url) || 'https://api.moonshot.cn/v1';
    const model = str(values.model) || 'kimi-k2.5';
    const maxContext = str(values.max_context_size) || '1048576';
    // Use kimi type for Moonshot default, openai type for custom endpoints
    const isDefaultUrl = baseUrl === 'https://api.moonshot.cn/v1';
    const providerType = isDefaultUrl ? 'kimi' : 'openai';

    if (apiKey) {
        const toml = [
            'default_model = "kimi-default"',
            'default_provider = "kimi"',
            '',
            '[providers.kimi]',
            `type = "${providerType}"`,
            `base_url = "${baseUrl}"`,
            `api_key = "${apiKey}"`,
            '',
            '[models.kimi-default]',
            'provider = "kimi"',
            `model = "${model}"`,
            `max_context_size = ${maxContext}`,
        ].join('\n');
        configFiles.push({ path: '${STATE_DIR}/config.toml', content: toml });
    }
    return { env, configFiles };
}

// ── opencode (opencode.json) ──

// Built-in "system" theme: text/background stay on terminal defaults and
// ANSI colors come from the host palette, so the TUI follows the light /
// dark appearance of the embedded xterm instead of covering it with the
// default dark canvas. Written unconditionally for opencode sessions
// (BYOK and gateway modes alike); user-provided tui.json wins via merge.
function opencodeThemeConfigFile() {
    return {
        path: '/root/.config/opencode/tui.json',
        content: JSON.stringify({
            $schema: 'https://opencode.ai/tui.json',
            theme: 'system',
        }, null, 2),
    };
}

function generateOpencode(values) {
    const env = {};
    const configFiles = [];
    const apiKey = str(values.apiKey);
    const baseURL = str(values.baseURL) || 'https://api.openai.com/v1';
    const model = str(values.model) || 'openai/gpt-4o';
    const provider = str(values.provider) || 'openai';

    if (apiKey) {
        const modelPart = model.includes('/') ? model.split('/').slice(1).join('/') : model;
        const config = {
            autoupdate: false,
            model: model,
            provider: {
                [provider]: {
                    name: provider,
                    npm: '@ai-sdk/openai-compatible',
                    options: {
                        baseURL: baseURL,
                        apiKey: apiKey,
                    },
                    models: {
                        [modelPart]: {
                            name: modelPart,
                        },
                    },
                },
            },
        };
        configFiles.push({ path: '/root/.config/opencode/opencode.json', content: JSON.stringify(config, null, 2) });
        configFiles.push(opencodeThemeConfigFile());
    }
    return { env, configFiles };
}

// ── droid (settings.json) ──

function generateDroid(values) {
    const env = {};
    const configFiles = [];
    const apiKey = str(values.apiKey);
    const baseUrl = str(values.baseUrl) || 'https://api.openai.com/v1';
    const model = str(values.model) || 'gpt-4o';
    const provider = str(values.provider) || 'generic-chat-completion-api';

    if (apiKey) {
        env.FACTORY_AIRGAP_ENABLED = '1';
        const config = {
            customModels: [
                {
                    provider: provider,
                    model: model,
                    baseUrl: baseUrl,
                    apiKey: apiKey,
                },
            ],
        };
        configFiles.push({ path: '${STATE_DIR}/.factory/settings.json', content: JSON.stringify(config, null, 2) });
    }
    return { env, configFiles };
}

// ── glm-agent (user-settings.json) ──

function generateGlmAgent(values) {
    const env = {};
    const configFiles = [];
    const apiKey = str(values.apiKey);
    const baseURL = str(values.baseURL) || 'https://api.z.ai/api/coding/paas/v4';
    const defaultModel = str(values.defaultModel) || 'glm-4.6';

    if (apiKey) {
        const models = ['glm-4.6', 'glm-4.5', 'glm-4.5-air'];
        if (!models.includes(defaultModel)) {
            models.push(defaultModel);
        }
        const config = {
            baseURL: baseURL,
            defaultModel: defaultModel,
            models: models,
            watchEnabled: false,
            watchDebounceMs: 300,
            enableHistory: true,
            apiKey: apiKey,
        };
        configFiles.push({ path: '${STATE_DIR}/.zai/user-settings.json', content: JSON.stringify(config, null, 2) });
    }
    return { env, configFiles };
}

// ── qoder (env + settings.json) ──

function generateQoder(values) {
    const env = {};
    const configFiles = [];
    const token = str(values.QODER_PERSONAL_ACCESS_TOKEN);
    const apiKey = str(values.apiKey);
    const baseUrl = str(values.baseUrl) || 'https://api.openai.com/v1';
    const model = str(values.model) || 'gpt-4o';

    if (token) env.QODER_PERSONAL_ACCESS_TOKEN = token;

    if (apiKey) {
        const providerName = 'custom';
        const config = {
            general: {
                enableAutoUpdate: false,
            },
            model: `${providerName}/${model}`,
            permissions: {
                allow: ['Bash(git:*)', 'Read(//**)'],
                deny: [],
            },
            providers: {
                [providerName]: {
                    baseUrl: baseUrl,
                    apiKey: apiKey,
                    displayName: 'Custom',
                    model: model,
                    maxOutputTokens: 8192,
                    models: [
                        {
                            model: model,
                            displayName: model,
                            maxOutputTokens: 8192,
                        },
                    ],
                },
            },
        };
        configFiles.push({ path: '${STATE_DIR}/settings.json', content: JSON.stringify(config, null, 2) });
    }
    return { env, configFiles };
}

// ── qwen-code (env + optional settings.json) ──

function generateQwenCode(values) {
    const env = {};
    const configFiles = [];
    const dashscopeKey = str(values.DASHSCOPE_API_KEY);
    const customApiKey = str(values.customApiKey);
    const baseUrl = str(values.baseUrl) || 'https://api.openai.com/v1';
    const model = str(values.model) || 'gpt-4o';
    const maxContextSize = Number(values.max_context_size) || 1048576;

    if (dashscopeKey) env.DASHSCOPE_API_KEY = dashscopeKey;

    // Only generate settings.json if customApiKey is filled
    if (customApiKey) {
        const providerName = 'custom';
        const config = {
            general: {
                enableAutoUpdate: false,
            },
            model: {
                name: model,
            },
            modelProviders: {
                [providerName]: [
                    {
                        id: model,
                        baseUrl: baseUrl,
                        envKey: 'CUSTOM_API_KEY',
                        generationConfig: { contextWindowSize: maxContextSize },
                    },
                ],
            },
            providerProtocol: {
                [providerName]: 'openai',
            },
            security: {
                auth: {
                    selectedType: 'openai',
                },
            },
            env: {
                CUSTOM_API_KEY: customApiKey,
            },
        };
        configFiles.push({ path: '${STATE_DIR}/settings.json', content: JSON.stringify(config, null, 2) });
    }
    return { env, configFiles };
}

// ── pi (env + optional models.json) ──

function generatePi(values) {
    const env = {};
    const configFiles = [];
    const anthropicKey = str(values.ANTHROPIC_API_KEY);
    const openaiKey = str(values.OPENAI_API_KEY);
    const apiKey = str(values.apiKey);
    const baseUrl = str(values.baseUrl) || 'https://api.openai.com/v1';
    const model = str(values.model) || 'gpt-4o';

    if (anthropicKey) env.ANTHROPIC_API_KEY = anthropicKey;
    if (openaiKey) env.OPENAI_API_KEY = openaiKey;

    // Only generate models.json if apiKey (custom provider key) is filled
    if (apiKey) {
        const providerName = 'custom';
        const config = {
            providers: {
                [providerName]: {
                    baseUrl: baseUrl,
                    api: 'openai-completions',
                    apiKey: apiKey,
                    models: [
                        {
                            id: model,
                            name: model,
                        },
                    ],
                },
            },
        };
        configFiles.push({ path: '/root/.pi/agent/models.json', content: JSON.stringify(config, null, 2) });
    }
    return { env, configFiles };
}

// ── hermes (config.yaml) ──

function generateHermes(values) {
    const env = {};
    const configFiles = [];
    const apiKey = str(values.api_key);
    const baseUrl = str(values.base_url) || 'https://api.openai.com/v1';
    const model = str(values.model) || 'gpt-4o';
    const apiMode = str(values.api_mode) || 'openai';
    const maxContextSize = Number(values.max_context_size) || 1048576;

    if (apiKey) {
        const providerName = 'auto';
        const yaml = [
            'model:',
            `  model: ${model}`,
            `  provider: ${providerName}`,
            `  context_length: ${maxContextSize}`,
            '',
            'providers:',
            `  ${providerName}:`,
            '    name: Custom',
            `    base_url: ${baseUrl}`,
            `    api_key: ${apiKey}`,
            `    api_mode: ${apiMode}`,
            `    model: ${model}`,
            `    context_length: ${maxContextSize}`,
        ].join('\n');
        configFiles.push({ path: '${STATE_DIR}/config.yaml', content: yaml });
    }
    return { env, configFiles };
}

// ── openclaw (openclaw.json) ──

function generateOpenclaw(values) {
    const env = {};
    const configFiles = [];
    const apiKey = str(values.apiKey);
    const baseUrl = str(values.baseUrl) || 'https://api.openai.com/v1';
    const model = str(values.model) || 'gpt-4o';
    const api = str(values.api) || 'openai-completions';

    if (apiKey) {
        const providerName = 'openai';
        const config = {
            logging: {
                level: 'info',
            },
            agents: {
                defaults: {
                    model: {
                        primary: `${providerName}/${model}`,
                    },
                },
            },
            models: {
                mode: 'merge',
                providers: {
                    [providerName]: {
                        baseUrl: baseUrl,
                        apiKey: apiKey,
                        api: api,
                        models: [
                            {
                                id: model,
                                name: model,
                            },
                        ],
                    },
                },
            },
        };
        configFiles.push({ path: '${STATE_DIR}/openclaw.json', content: JSON.stringify(config, null, 2) });
    }
    return { env, configFiles };
}

// ── github-copilot (env only) ──

function generateGithubCopilot(values) {
    const env = {};
    const apiKey = str(values.apiKey);
    const baseUrl = str(values.baseUrl) || 'https://api.openai.com/v1';
    const model = str(values.model) || 'gpt-4o';
    if (apiKey) {
        env.COPILOT_PROVIDER_API_KEY = apiKey;
        env.COPILOT_PROVIDER_BASE_URL = baseUrl;
        env.COPILOT_PROVIDER_TYPE = 'openai';
        env.COPILOT_MODEL = model;
    }
    return { env, configFiles: [] };
}

// ── codebuddy (env + models.json + settings.json) ──

function generateCodebuddy(values) {
    const env = {};
    const configFiles = [];
    const apiKey = str(values.apiKey);
    const baseUrl = str(values.baseUrl) || 'https://api.openai.com/v1/chat/completions';
    const model = str(values.model) || 'gpt-4o';
    const maxInputTokens = Number(values.max_context_size) || 1048576;

    if (apiKey) {
        env.CODEBUDDY_API_KEY = apiKey;
        const configDir = '${STATE_DIR}';
        configFiles.push({
            path: `${configDir}/models.json`,
            content: JSON.stringify({
                models: [{
                    id: model,
                    name: model,
                    vendor: 'custom',
                    apiKey: apiKey,
                    url: baseUrl,
                    maxInputTokens: maxInputTokens,
                    maxOutputTokens: 8192,
                }],
                availableModels: [model],
            }, null, 2),
        });
        configFiles.push({
            path: `${configDir}/settings.json`,
            content: JSON.stringify({
                autoCompactEnabled: true,
                autoCompactWindow: Math.max(100000, Math.min(1000000, maxInputTokens)),
                trustAll: true,
                trustedDirectories: ['/workspace', '/tmp'],
            }, null, 2),
        });
    }
    return { env, configFiles };
}

// ── cursor (env only) ──

function generateCursor(values) {
    const env = {};
    const apiKey = str(values.apiKey);
    const baseUrl = str(values.baseUrl) || 'https://api.openai.com/v1';
    const model = str(values.model) || 'gpt-4o';
    if (apiKey) {
        env.OPENAI_API_KEY = apiKey;
        env.OPENAI_BASE_URL = baseUrl;
        env.OPENAI_MODEL = model;
    }
    return { env, configFiles: [] };
}

// ── amp (env only) ──

function generateAmp(values) {
    const env = {};
    const apiKey = str(values.apiKey);
    const baseUrl = str(values.baseUrl) || 'https://api.openai.com/v1';
    const model = str(values.model) || 'gpt-4o';
    if (apiKey) {
        env.OPENAI_API_KEY = apiKey;
        env.OPENAI_BASE_URL = baseUrl;
        env.OPENAI_MODEL = model;
    }
    return { env, configFiles: [] };
}

// ── Secret management helpers ──

/**
 * Update user secrets with BYOK field values for an agent.
 * Stores all values as a JSON blob under `__byok_<agentId>` and also writes
 * generated env vars as individual secret keys (removing old BYOK env keys first).
 *
 * @param {string} agentId
 * @param {object} values - field values keyed by field.key
 * @param {object} currentSecrets - current decrypted secrets
 * @returns {object} updated secrets
 */
function applyByokToSecrets(agentId, values, currentSecrets) {
    const updated = { ...currentSecrets };

    // Remove old BYOK env vars
    const oldValues = getByokFieldValues(agentId, updated);
    const oldConfig = generateByokConfig(agentId, oldValues);
    for (const oldKey of Object.keys(oldConfig.env || {})) {
        delete updated[oldKey];
    }

    // Store the blob
    updated[byokStorageKey(agentId)] = JSON.stringify(values);

    // Store new env vars as individual keys
    const newConfig = generateByokConfig(agentId, values);
    for (const [k, v] of Object.entries(newConfig.env || {})) {
        if (v) updated[k] = v;
    }

    return updated;
}

/**
 * Remove all BYOK data for an agent from user secrets.
 * @param {string} agentId
 * @param {object} currentSecrets - current decrypted secrets
 * @returns {object} updated secrets
 */
function removeByokFromSecrets(agentId, currentSecrets) {
    const updated = { ...currentSecrets };

    // Remove BYOK env vars
    const oldValues = getByokFieldValues(agentId, updated);
    const oldConfig = generateByokConfig(agentId, oldValues);
    for (const oldKey of Object.keys(oldConfig.env || {})) {
        delete updated[oldKey];
    }

    // Remove the blob
    delete updated[byokStorageKey(agentId)];

    return updated;
}

/**
 * Merge BYOK config files with session-level config files.
 * Session-level files take precedence (override BYOK files with the same path).
 *
 * @param {Array} byokConfigFiles - [{ path, content }]
 * @param {Array} sessionConfigFiles - [{ path, content }]
 * @returns {Array} merged config files
 */
function mergeByokConfigFiles(byokConfigFiles, sessionConfigFiles) {
    const byPath = new Map();
    for (const cf of byokConfigFiles || []) {
        if (cf && cf.path && cf.content) byPath.set(cf.path, cf);
    }
    for (const cf of sessionConfigFiles || []) {
        if (cf && cf.path && cf.content) byPath.set(cf.path, cf);
    }
    return Array.from(byPath.values());
}

module.exports = {
    BYOK_FIELDS,
    byokStorageKey,
    getByokFieldValues,
    generateByokConfig,
    applyByokToSecrets,
    removeByokFromSecrets,
    mergeByokConfigFiles,
    opencodeThemeConfigFile,
};
