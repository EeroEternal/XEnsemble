/** Built-in agent catalog — synced on DB init via INSERT OR IGNORE + UPDATE for cmd/args/env. */

const DEFAULT_AGENTS = [
    {
        id: 'kimi-code',
        name: 'Kimi Code',
        cmd: 'kimi',
        args: [],
        // Kimi Code authenticates via `kimi login` / config.toml - no BYOK env injection.
        env_required: [],
        resume: {
            level: 'L2',
            stateEnv: 'KIMI_CODE_HOME',
            resumeArgs: ['--continue'],
        },
        configSchema: {
            configFiles: [{
                path: '${STATE_DIR}/config.toml',
                format: 'toml',
                label: 'config.toml',
                description: 'Kimi Code 配置文件（模型、Provider、API Key）',
                example: [
                    'default_model = "kimi-default"',
                    'default_provider = "kimi"',
                    '',
                    '[providers.kimi]',
                    'type = "kimi"',
                    'base_url = "https://api.moonshot.cn/v1"',
                    'api_key = "your-api-key"',
                    '',
                    '[models.kimi-default]',
                    'provider = "kimi"',
                    'model = "kimi-k2.5"',
                    'max_context_size = 1048576',
                ].join('\n'),
            }],
        },
    },
    {
        id: 'claude-code',
        name: 'Claude Code',
        cmd: 'claude',
        args: [],
        env_required: ['ANTHROPIC_API_KEY'],
        // P4：技能注入目标文件（仅 claude-code 用 CLAUDE.md，其余默认 AGENTS.md）
        instructionFile: 'CLAUDE.md',
        resume: {
            level: 'L2',
            stateEnv: 'CLAUDE_CONFIG_DIR',
            resumeArgs: ['--continue'],
            resumeCheckSubdir: 'projects',
        },
        configSchema: {
            configFiles: [{
                path: '${STATE_DIR}/settings.json',
                format: 'json',
                label: 'settings.json',
                description: 'Claude Code 用户设置（权限、模型、环境变量等）',
                example: JSON.stringify({
                    permissions: {
                        allow: ['Bash(git:*)', 'Read(//**)'],
                        deny: [],
                    },
                }, null, 2),
            }],
        },
    },
    {
        id: 'cursor',
        name: 'Cursor Agent',
        cmd: 'agent',
        args: [],
        env_required: [],
        resume: {
            level: 'L2',
            stateEnv: 'CURSOR_DATA_DIR',
            resumeArgs: ['--continue'],
        },
    },
    {
        id: 'opencode',
        name: 'OpenCode',
        cmd: 'opencode',
        args: [],
        env_required: [],
        resume: {
            level: 'L2',
            stateEnv: 'XDG_DATA_HOME',
            resumeArgs: ['--continue'],
        },
        configSchema: {
            configFiles: [{
                path: '/root/.config/opencode/opencode.json',
                format: 'json',
                label: 'opencode.json',
                description: 'OpenCode 配置文件（Provider、模型、自动更新等）',
                example: JSON.stringify({
                    autoupdate: false,
                    model: 'openai/gpt-4o',
                    provider: {
                        'openai': {
                            name: 'OpenAI',
                            npm: '@ai-sdk/openai-compatible',
                            options: {
                                baseURL: 'https://api.openai.com/v1',
                                apiKey: 'sk-xxxx',
                            },
                            models: {
                                'gpt-4o': {
                                    name: 'GPT-4o',
                                },
                            },
                        },
                    },
                }, null, 2),
            }],
        },
    },
    {
        id: 'amp',
        name: 'AMP',
        cmd: 'amp',
        args: [],
        env_required: [],
        resume: {
            level: 'L2',
            stateEnv: 'XDG_CONFIG_HOME',
            resumeArgs: ['last'],
            resumeCheckSubdir: 'amp',
        },
    },
    {
        id: 'cline',
        name: 'Cline',
        cmd: 'cline',
        args: ['-i'],
        env_required: ['ANTHROPIC_API_KEY'],
        resume: {
            level: 'L2',
            stateEnv: 'CLINE_DATA_DIR',
            resolveResumeArgs: async ({ exec, env, runtimeRef }) => {
                const result = await exec('cline', ['history', '--json', '--limit', '1'], env, { runtimeRef, timeoutMs: 5000 }).catch(() => null);
                if (!result?.stdout) return [];
                try {
                    const sessions = JSON.parse(result.stdout);
                    if (Array.isArray(sessions) && sessions.length > 0) {
                        const sessionId = sessions[0].sessionId || sessions[0].id;
                        if (sessionId) return ['--id', sessionId];
                    }
                } catch { /* ignore */ }
                return [];
            },
        },
    },
    {
        id: 'codebuddy',
        name: 'CodeBuddy Code',
        cmd: 'codebuddy',
        args: [],
        env_required: [],
        resume: {
            level: 'L2',
            stateEnv: 'CODEBUDDY_CONFIG_DIR',
            resumeArgs: ['--continue'],
        },
    },
    {
        id: 'droid',
        name: 'Factory Droid',
        cmd: 'droid',
        args: [],
        env_required: [],
        resume: {
            level: 'L2',
            stateEnv: 'FACTORY_HOME_OVERRIDE',
            resumeArgs: ['--resume'],
        },
        configSchema: {
            configFiles: [{
                path: '${STATE_DIR}/.factory/settings.json',
                format: 'json',
                label: 'settings.json',
                description: 'Factory Droid 配置文件。配置 customModels 后，droid 将使用自定义 Provider 而非 Factory 官方 API（可绕过 Factory 组织绑定）。首个 customModel 的 model 字段会自动作为 --model 参数传入。支持 provider: openai / anthropic / bedrock-converse / generic-chat-completion-api（OpenAI 兼容）。',
                example: JSON.stringify({
                    customModels: [
                        {
                            provider: 'generic-chat-completion-api',
                            model: 'gpt-4o',
                            baseUrl: 'https://api.openai.com/v1',
                            apiKey: 'your-api-key',
                        },
                    ],
                }, null, 2),
            }],
        },
    },
    {
        id: 'glm-agent',
        name: 'GLM Agent',
        cmd: 'zai',
        args: [],
        env_required: [],
        resume: {
            level: 'L2',
            redirectHome: true,
            resolveResumeArgs: async ({ exec, env, runtimeRef, stateDirPath }) => {
                const sessionsDir = `${stateDirPath}/.zai/sessions`;
                const lsResult = await exec('sh', ['-c', `ls -t "${sessionsDir}"/*.json 2>/dev/null | head -1`], env, { runtimeRef, cwd: '/', timeoutMs: 5000 }).catch(() => null);
                if (!lsResult?.stdout?.trim()) return [];
                const filePath = lsResult.stdout.trim();
                const catResult = await exec('sh', ['-c', `cat "${filePath}"`], env, { runtimeRef, cwd: '/', timeoutMs: 5000 }).catch(() => null);
                if (!catResult?.stdout) return [];
                try {
                    const session = JSON.parse(catResult.stdout);
                    if (session.metadata?.name) {
                        return ['load-session', session.metadata.name];
                    }
                } catch { /* ignore */ }
                return [];
            },
        },
        configSchema: {
            configFiles: [{
                path: '${STATE_DIR}/.zai/user-settings.json',
                format: 'json',
                label: 'user-settings.json',
                description: 'GLM Agent 配置文件（API Key、模型、监听等）',
                example: JSON.stringify({
                    baseURL: 'https://api.z.ai/api/coding/paas/v4',
                    defaultModel: 'glm-4.6',
                    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air'],
                    watchEnabled: false,
                    watchDebounceMs: 300,
                    enableHistory: true,
                    apiKey: '',
                }, null, 2),
            }],
        },
    },
    {
        id: 'qoder',
        name: 'Qoder CLI',
        cmd: 'qodercli',
        args: [],
        env_required: ['QODER_PERSONAL_ACCESS_TOKEN'],
        resume: {
            level: 'L2',
            stateArgs: ['--config-dir'],
            resumeArgs: ['--continue'],
            resumeCheckSubdir: 'logs/sessions',
        },
        configSchema: {
            configFiles: [{
                path: '${STATE_DIR}/settings.json',
                format: 'json',
                label: 'settings.json',
                description: 'Qoder CLI 配置文件（Provider、模型、权限等）',
                example: JSON.stringify({
                    general: {
                        enableAutoUpdate: false,
                    },
                    model: 'openai/gpt-4o',
                    permissions: {
                        allow: ['Bash(git:*)', 'Read(//**)'],
                        deny: [],
                    },
                    providers: {
                        'openai': {
                            baseUrl: 'https://api.openai.com/v1',
                            apiKey: 'sk-xxxx',
                            displayName: 'OpenAI',
                            model: 'gpt-4o',
                            maxOutputTokens: 8192,
                            models: [
                                {
                                    model: 'gpt-4o',
                                    displayName: 'GPT-4o',
                                    maxOutputTokens: 8192,
                                },
                            ],
                        },
                    },
                }, null, 2),
            }],
        },
    },
    {
        id: 'qwen-code',
        name: 'Qwen Code',
        cmd: 'qwen',
        args: [],
        env_required: ['DASHSCOPE_API_KEY'],
        resume: {
            level: 'L2',
            stateEnv: 'QWEN_HOME',
            resumeArgs: ['--continue'],
        },
        configSchema: {
            configFiles: [{
                path: '${STATE_DIR}/settings.json',
                format: 'json',
                label: 'settings.json',
                description: 'Qwen Code 配置文件（Provider、模型、自动更新等）',
                example: JSON.stringify({
                    general: {
                        enableAutoUpdate: false,
                    },
                    model: {
                        name: 'gpt-4o',
                    },
                    modelProviders: {
                        'openai': [
                            {
                                id: 'gpt-4o',
                                baseUrl: 'https://api.openai.com/v1',
                                envKey: 'OPENAI_API_KEY',
                            },
                        ],
                    },
                    providerProtocol: {
                        'openai': 'openai',
                    },
                    security: {
                        auth: {
                            selectedType: 'openai',
                        },
                    },
                    env: {
                        OPENAI_API_KEY: 'sk-xxxx',
                    },
                }, null, 2),
            }],
        },
    },
    {
        id: 'minimax-cli',
        name: 'MiniMax CLI',
        cmd: 'mmx',
        args: [],
        env_required: ['MINIMAX_API_KEY'],
    },
    {
        id: 'pi',
        name: 'Pi',
        cmd: 'pi',
        args: [],
        env_required: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
        resume: {
            level: 'L2',
            stateArgs: ['--session-dir'],
            resumeArgs: ['--continue'],
        },
        configSchema: {
            configFiles: [{
                path: '/root/.pi/agent/models.json',
                format: 'json',
                label: 'models.json',
                description: 'Pi 模型配置文件（自定义 Provider、模型、API Key）',
                example: JSON.stringify({
                    providers: {
                        'openai': {
                            baseUrl: 'https://api.openai.com/v1',
                            api: 'openai-completions',
                            apiKey: 'sk-xxxx',
                            models: [
                                {
                                    id: 'gpt-4o',
                                    name: 'GPT-4o',
                                },
                            ],
                        },
                    },
                }, null, 2),
            }],
        },
    },
    {
        id: 'github-copilot',
        name: 'GitHub Copilot',
        cmd: 'copilot',
        args: [],
        env_required: [],
    },
    {
        id: 'commandcode',
        name: 'CommandCode',
        cmd: 'commandcode',
        args: [],
        env_required: ['COHERE_API_KEY'],
        resume: {
            level: 'L2',
            redirectHome: true,
            resumeArgs: ['--continue'],
        },
    },
    {
        id: 'hermes',
        name: 'Hermes',
        cmd: 'hermes',
        args: ['chat'],
        env_required: [],
        resume: {
            level: 'L2',
            stateEnv: 'HERMES_HOME',
            resumeArgs: ['--continue'],
        },
        configSchema: {
            configFiles: [{
                path: '${STATE_DIR}/config.yaml',
                format: 'yaml',
                label: 'config.yaml',
                description: 'Hermes 配置文件（Provider、模型、API Key）',
                example: [
                    'model:',
                    '  model: gpt-4o',
                    '  provider: openai',
                    '',
                    'providers:',
                    '  openai:',
                    '    name: DeepSeek',
                    '    base_url: https://api.openai.com/v1',
                    '    api_key: sk-xxxx',
                    '    api_mode: openai',
                    '    model: gpt-4o',
                ].join('\n'),
            }],
        },
    },
    {
        id: 'openclaw',
        name: 'OpenClaw',
        cmd: 'openclaw',
        args: [],
        env_required: [],
        resume: {
            level: 'L2',
            stateEnv: 'OPENCLAW_STATE_DIR',
            extraStateEnvs: {
                'OPENCLAW_WORKSPACE_DIR': 'workspace',
            },
        },
        configSchema: {
            configFiles: [{
                path: '${STATE_DIR}/openclaw.json',
                format: 'json',
                label: 'openclaw.json',
                description: 'OpenClaw 配置文件（Provider、模型、日志等）',
                example: JSON.stringify({
                    logging: {
                        level: 'info',
                    },
                    agents: {
                        defaults: {
                            model: {
                                primary: 'openai/gpt-4o',
                            },
                        },
                    },
                    models: {
                        mode: 'merge',
                        providers: {
                            'openai': {
                                baseUrl: 'https://api.openai.com/v1',
                                apiKey: 'sk-xxxx',
                                api: 'openai-completions',
                                models: [
                                    {
                                        id: 'gpt-4o',
                                        name: 'GPT-4o',
                                    },
                                ],
                            },
                        },
                    },
                }, null, 2),
            }],
        },
    },
];

/**
 * P4：解析某 agent 的技能注入目标指令文件。
 * 仅 claude-code 声明 CLAUDE.md；未声明默认 AGENTS.md；自定义 agent → AGENTS.md。
 * @param {string} agentId
 * @returns {string} 'CLAUDE.md' | 'AGENTS.md'
 */
function getInstructionFile(agentId) {
    const agent = DEFAULT_AGENTS.find((a) => a.id === agentId);
    return agent?.instructionFile || 'AGENTS.md';
}

module.exports = { DEFAULT_AGENTS, getInstructionFile };
