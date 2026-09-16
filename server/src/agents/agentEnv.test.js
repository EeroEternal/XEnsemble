const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyGatewayAgentEnv, applyOpencodeGatewayEnv, applyClaudeCodeModelEnv, resolveClaudeCodeModelEnv } = require('./agentEnv');

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
