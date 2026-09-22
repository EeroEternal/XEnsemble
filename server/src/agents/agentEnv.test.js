const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    applyGatewayAgentEnv,
    applyOpencodeGatewayEnv,
    applyClaudeCodeModelEnv,
    resolveClaudeCodeModelEnv,
    applyKimiCodeGatewayEnv,
    kimiGatewayHasConfiguredModel,
} = require('./agentEnv');

test('applyGatewayAgentEnv: droid enables BYOK airgap mode', () => {
    const env = applyGatewayAgentEnv('droid', { LLM_ROUTER_URL: 'http://gw/v1' }, {}, []);
    assert.equal(env.FACTORY_AIRGAP_ENABLED, '1');
});

test('applyGatewayAgentEnv: non-droid agents are untouched', () => {
    const env = applyGatewayAgentEnv('qwen-code', { LLM_ROUTER_URL: 'http://gw/v1' }, {}, []);
    assert.equal(env.FACTORY_AIRGAP_ENABLED, undefined);
});

test('applyGatewayAgentEnv: github-copilot injects COPILOT_PROVIDER_* env', () => {
    const env = applyGatewayAgentEnv('github-copilot', {
        OPENAI_MODEL: 'zxs_deepseek/deepseek-v4-flash',
    }, {
        LLM_ROUTER_URL: 'https://xensemble.dev/api/v1/llm',
        LLM_ROUTER_API_KEY: 'xel_session_token',
    }, []);
    assert.equal(env.COPILOT_PROVIDER_BASE_URL, 'https://xensemble.dev/api/v1/llm/v1');
    assert.equal(env.COPILOT_PROVIDER_TYPE, 'openai');
    assert.equal(env.COPILOT_PROVIDER_API_KEY, 'xel_session_token');
    assert.equal(env.COPILOT_MODEL, 'zxs_deepseek/deepseek-v4-flash');
});

test('applyGatewayAgentEnv: github-copilot skips injection when gateway missing', () => {
    const env = applyGatewayAgentEnv('github-copilot', { OPENAI_MODEL: 'm' }, {}, []);
    assert.equal(env.COPILOT_PROVIDER_BASE_URL, undefined);
});

test('applyGatewayAgentEnv: codebuddy injects CODEBUDDY_API_KEY to skip login', () => {
    const env = applyGatewayAgentEnv('codebuddy', {}, {
        LLM_ROUTER_API_KEY: 'xel_session_token',
    }, []);
    assert.equal(env.CODEBUDDY_API_KEY, 'xel_session_token');
});

test('applyGatewayAgentEnv: codebuddy skips injection when no gateway key', () => {
    const env = applyGatewayAgentEnv('codebuddy', {}, {}, []);
    assert.equal(env.CODEBUDDY_API_KEY, undefined);
});

test('applyKimiCodeGatewayEnv: does not inject KIMI_MODEL_* (config.toml is the catalog)', () => {
    const env = applyKimiCodeGatewayEnv({
        LLM_ROUTER_URL: 'https://xensemble.dev/api/v1/llm',
        LLM_ROUTER_API_KEY: 'xel_session_token',
        OPENAI_MODEL: 'zxs_glm/glm-5.3',
        KIMI_MODEL: 'zxs_glm/glm-5.3',
    });
    assert.equal(env.KIMI_MODEL_NAME, undefined);
    assert.equal(env.KIMI_MODEL_API_KEY, undefined);
    assert.equal(env.KIMI_MODEL_BASE_URL, undefined);
    assert.equal(env.KIMI_MODEL_PROVIDER_TYPE, undefined);
    assert.equal(env.KIMI_MODEL_MAX_CONTEXT_SIZE, undefined);
    assert.equal(env.OPENAI_MODEL, 'zxs_glm/glm-5.3');
    assert.equal(env.LLM_ROUTER_URL, 'https://xensemble.dev/api/v1/llm');
});

test('kimiGatewayHasConfiguredModel: uses generic gateway model keys, not KIMI_MODEL_NAME', () => {
    assert.equal(kimiGatewayHasConfiguredModel({ OPENAI_MODEL: 'zxs_glm/glm-5.3' }), true);
    assert.equal(kimiGatewayHasConfiguredModel({ LLM_MODEL: 'm' }), true);
    assert.equal(kimiGatewayHasConfiguredModel({ KIMI_MODEL: 'm' }), true);
    assert.equal(kimiGatewayHasConfiguredModel({ KIMI_MODEL_NAME: 'zxs_glm/glm-5.3' }), false);
    assert.equal(kimiGatewayHasConfiguredModel({}), false);
});

test('applyOpencodeGatewayEnv: registers all configured models for /model selector', () => {
    const env = applyOpencodeGatewayEnv(
        { LLM_ROUTER_URL: 'http://gw/v1', LLM_ROUTER_API_KEY: 'key' },
        ['deepseek/deepseek-v4-flash', 'zxs/qwen-max'],
        'deepseek/deepseek-v4-flash',
    );
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    // model ids are stored without the provider prefix: opencode parses
    // `provider/model_id` on the first `/`, so a slash inside the model id
    // would make it resolve the wrong provider (see fix 2709ba8).
    assert.deepEqual(
        Object.keys(config.provider.gateway.models).sort(),
        ['deepseek-v4-flash', 'qwen-max'],
    );
    assert.equal(config.model, 'gateway/deepseek-v4-flash');
    // OpenCode autoloads models.dev providers whenever OPENAI_API_KEY etc. are
    // present (Gateway copies the session token into those names). An allowlist
    // keeps /models to the configured gateway catalog.
    assert.deepEqual(config.enabled_providers, ['gateway']);
});

test('applyOpencodeGatewayEnv: single target still works (back-compat)', () => {
    const env = applyOpencodeGatewayEnv(
        { LLM_ROUTER_URL: 'http://gw/v1', LLM_ROUTER_API_KEY: 'key' },
        'deepseek/deepseek-v4-flash',
    );
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(Object.keys(config.provider.gateway.models), ['deepseek-v4-flash']);
    assert.equal(config.model, 'gateway/deepseek-v4-flash');
});

test('applyOpencodeGatewayEnv: skips when gateway missing', () => {
    const env = applyOpencodeGatewayEnv({}, ['m1'], 'm1');
    assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
});

test('applyGatewayAgentEnv: hermes strips extra provider API keys that light up /model catalogs', () => {
    const env = applyGatewayAgentEnv('hermes', {
        OPENROUTER_API_KEY: 'xel_session',
        ANTHROPIC_API_KEY: 'xel_session',
        ANTHROPIC_AUTH_TOKEN: 'xel_session',
        OPENAI_API_KEY: 'xel_session',
        KIMI_API_KEY: 'xel_session',
        MOONSHOT_API_KEY: 'xel_session',
        DASHSCOPE_API_KEY: 'xel_session',
        ZAI_API_KEY: 'xel_session',
        MINIMAX_API_KEY: 'xel_session',
        HERMES_API_KEY: 'xel_session',
        OPENROUTER_BASE_URL: 'http://gw/v1',
        OPENAI_BASE_URL: 'http://gw/v1',
        ANTHROPIC_BASE_URL: 'http://gw',
        HERMES_MODEL: 'personal_glm/glm-5.3',
        LLM_ROUTER_URL: 'http://gw',
        LLM_ROUTER_API_KEY: 'xel_session',
    }, {}, []);
    // Hermes /model lists every provider whose env key is set (OpenRouter,
    // Anthropic, Qwen, Kimi, MiniMax, Z.AI, openai-api). Routing uses
    // $HERMES_HOME/config.yaml providers.auto, so drop those catalog keys.
    assert.equal(env.OPENROUTER_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.KIMI_API_KEY, undefined);
    assert.equal(env.MOONSHOT_API_KEY, undefined);
    assert.equal(env.DASHSCOPE_API_KEY, undefined);
    assert.equal(env.ZAI_API_KEY, undefined);
    assert.equal(env.MINIMAX_API_KEY, undefined);
    assert.equal(env.HERMES_API_KEY, undefined);
    assert.equal(env.OPENROUTER_BASE_URL, undefined);
    assert.equal(env.OPENAI_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.HERMES_MODEL, 'personal_glm/glm-5.3');
    assert.equal(env.LLM_ROUTER_URL, 'http://gw');
    assert.equal(env.LLM_ROUTER_API_KEY, 'xel_session');
});

test('applyGatewayAgentEnv: pi strips extra provider API keys that light up /model catalogs', () => {
    const env = applyGatewayAgentEnv('pi', {
        OPENROUTER_API_KEY: 'xel_session',
        ANTHROPIC_API_KEY: 'xel_session',
        OPENAI_API_KEY: 'xel_session',
        OPENROUTER_BASE_URL: 'http://gw/v1',
        OPENAI_MODEL: 'personal_glm/glm-5.3',
        LLM_ROUTER_URL: 'http://gw',
        LLM_ROUTER_API_KEY: 'xel_session',
    }, {}, ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    // Pi treats OPENROUTER_API_KEY (and other official env names) as a
    // configured provider, so /model lists the OpenRouter catalog (400+)
    // beside models.json `gateway`. Routing uses that file's apiKey.
    assert.equal(env.OPENROUTER_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.OPENROUTER_BASE_URL, undefined);
    assert.equal(env.OPENAI_MODEL, 'personal_glm/glm-5.3');
    assert.equal(env.LLM_ROUTER_URL, 'http://gw');
    assert.equal(env.LLM_ROUTER_API_KEY, 'xel_session');
});

test('applyGatewayAgentEnv: non-hermes agents keep synthesized provider keys', () => {
    const env = applyGatewayAgentEnv('qwen-code', {
        OPENROUTER_API_KEY: 'xel_session',
        DASHSCOPE_API_KEY: 'xel_session',
    }, {}, []);
    assert.equal(env.OPENROUTER_API_KEY, 'xel_session');
    assert.equal(env.DASHSCOPE_API_KEY, 'xel_session');
});

test('applyClaudeCodeModelEnv: < 2.1.236 keeps ANTHROPIC_MODEL', () => {
    const env = applyClaudeCodeModelEnv({ ANTHROPIC_MODEL: 'x/model' }, 'x/model', '2.1.223');
    assert.equal(env.ANTHROPIC_MODEL, 'x/model');
    assert.equal(env.ANTHROPIC_DEFAULT_MODEL, undefined);
});

test('applyClaudeCodeModelEnv: >= 2.1.236 switches to ANTHROPIC_DEFAULT_MODEL', () => {
    const env = applyClaudeCodeModelEnv({ ANTHROPIC_MODEL: 'x/model' }, 'x/model', '2.1.236');
    assert.equal(env.ANTHROPIC_MODEL, undefined);
    assert.equal(env.ANTHROPIC_DEFAULT_MODEL, 'x/model');
});

test('applyClaudeCodeModelEnv: unknown version keeps ANTHROPIC_MODEL', () => {
    const env = applyClaudeCodeModelEnv({ ANTHROPIC_MODEL: 'x/model' }, 'x/model', '');
    assert.equal(env.ANTHROPIC_MODEL, 'x/model');
    assert.equal(env.ANTHROPIC_DEFAULT_MODEL, undefined);
});

test('resolveClaudeCodeModelEnv: non-claude agent is a no-op', async () => {
    const env = { ANTHROPIC_MODEL: 'x/model' };
    const out = await resolveClaudeCodeModelEnv('opencode', env, {});
    assert.equal(out, env);
});

test('resolveClaudeCodeModelEnv: probes old version and keeps ANTHROPIC_MODEL', async () => {
    const runtime = { exec: { exec: async () => ({ stdout: '2.1.224 (Claude Code)', stderr: '', exitCode: 0 }) } };
    const out = await resolveClaudeCodeModelEnv('claude-code', { ANTHROPIC_MODEL: 'personal_glm/glm-5.3-flash' }, runtime, {});
    assert.equal(out.ANTHROPIC_MODEL, 'personal_glm/glm-5.3-flash');
    assert.equal(out.ANTHROPIC_DEFAULT_MODEL, undefined);
});

test('resolveClaudeCodeModelEnv: probes new version and switches key', async () => {
    const runtime = { exec: { exec: async () => ({ stdout: '2.1.240', stderr: '', exitCode: 0 }) } };
    const out = await resolveClaudeCodeModelEnv('claude-code', { ANTHROPIC_MODEL: 'personal_glm/glm-5.3-flash' }, runtime, {});
    assert.equal(out.ANTHROPIC_MODEL, undefined);
    assert.equal(out.ANTHROPIC_DEFAULT_MODEL, 'personal_glm/glm-5.3-flash');
});

test('resolveClaudeCodeModelEnv: probe failure keeps env unchanged', async () => {
    const runtime = { exec: { exec: async () => { throw new Error('boom'); } } };
    const env = { ANTHROPIC_MODEL: 'x/model' };
    const out = await resolveClaudeCodeModelEnv('claude-code', env, runtime, {});
    assert.equal(out, env);
});
