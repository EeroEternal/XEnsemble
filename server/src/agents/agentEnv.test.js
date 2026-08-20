const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyGatewayAgentEnv, applyOpencodeGatewayEnv } = require('./agentEnv');

test('applyGatewayAgentEnv: droid enables BYOK airgap mode', () => {
    const env = applyGatewayAgentEnv('droid', { LLM_ROUTER_URL: 'http://gw/v1' }, {}, []);
    assert.equal(env.FACTORY_AIRGAP_ENABLED, '1');
});

test('applyGatewayAgentEnv: non-droid agents are untouched', () => {
    const env = applyGatewayAgentEnv('qwen-code', { LLM_ROUTER_URL: 'http://gw/v1' }, {}, []);
    assert.equal(env.FACTORY_AIRGAP_ENABLED, undefined);
});

test('applyGatewayAgentEnv: github-copilot sets COPILOT_MODEL only (registry in settings.json)', () => {
    const env = applyGatewayAgentEnv('github-copilot', {
        OPENAI_MODEL: 'zxs_deepseek/deepseek-v4-flash',
    }, {
        LLM_ROUTER_URL: 'https://xensemble.dev/api/v1/llm',
        LLM_ROUTER_API_KEY: 'xel_session_token',
    }, []);
    assert.equal(env.COPILOT_MODEL, 'zxs_deepseek/deepseek-v4-flash');
    assert.equal(env.COPILOT_PROVIDER_BASE_URL, undefined,
        'COPILOT_PROVIDER_* must not be set - it conflicts with the providers/models registry in settings.json');
});

test('applyGatewayAgentEnv: github-copilot skips COPILOT_MODEL when no target', () => {
    const env = applyGatewayAgentEnv('github-copilot', {}, {}, []);
    assert.equal(env.COPILOT_MODEL, undefined);
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
    assert.deepEqual(
        Object.keys(config.provider.gateway.models).sort(),
        ['deepseek/deepseek-v4-flash', 'zxs/qwen-max'],
    );
    assert.equal(config.model, 'gateway/deepseek/deepseek-v4-flash');
});

test('applyOpencodeGatewayEnv: single target still works (back-compat)', () => {
    const env = applyOpencodeGatewayEnv(
        { LLM_ROUTER_URL: 'http://gw/v1', LLM_ROUTER_API_KEY: 'key' },
        'deepseek/deepseek-v4-flash',
    );
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(Object.keys(config.provider.gateway.models), ['deepseek/deepseek-v4-flash']);
    assert.equal(config.model, 'gateway/deepseek/deepseek-v4-flash');
});

test('applyOpencodeGatewayEnv: skips when gateway missing', () => {
    const env = applyOpencodeGatewayEnv({}, ['m1'], 'm1');
    assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
});
