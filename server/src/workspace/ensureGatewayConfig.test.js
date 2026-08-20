const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildGatewayConfigSpec, GATEWAY_CONFIG_AGENTS } = require('./ensureGatewayConfig');

const ctx = {
    stateDirPath: '/workspace/.xensemble/state/sess_test',
    sessionToken: 'xel_test_token',
    routerUrl: 'https://xensemble.dev/api/v1/llm',
    modelTarget: 'zxs_deepseek/deepseek-v4-flash',
};

test('glm-agent is in GATEWAY_CONFIG_AGENTS', () => {
    assert.ok(GATEWAY_CONFIG_AGENTS.has('glm-agent'), 'glm-agent must be in GATEWAY_CONFIG_AGENTS');
});

test('buildGatewayConfigSpec: glm-agent writes user-settings.json with gateway credentials', () => {
    const spec = buildGatewayConfigSpec('glm-agent', ctx);
    assert.ok(spec, 'spec must not be null for glm-agent');
    assert.equal(spec.filePath, '/workspace/.xensemble/state/sess_test/.zai/user-settings.json');
    assert.equal(spec.dirPath, '/workspace/.xensemble/state/sess_test/.zai');

    const content = JSON.parse(spec.content);
    assert.equal(content.baseURL, 'https://xensemble.dev/api/v1/llm/v1');
    assert.equal(content.apiKey, 'xel_test_token');
    assert.equal(content.defaultModel, 'zxs_deepseek/deepseek-v4-flash');
    assert.deepEqual(content.models, ['zxs_deepseek/deepseek-v4-flash']);
    assert.equal(content.watchEnabled, false);
    assert.equal(content.enableHistory, true);
});

test('buildGatewayConfigSpec: glm-agent uses routerUrl/v1 for baseURL', () => {
    const spec = buildGatewayConfigSpec('glm-agent', { ...ctx, routerUrl: 'https://custom.example.com/api/v1/llm' });
    const content = JSON.parse(spec.content);
    assert.equal(content.baseURL, 'https://custom.example.com/api/v1/llm/v1');
});

test('buildGatewayConfigSpec: glm-agent uses modelTarget for defaultModel and models', () => {
    const spec = buildGatewayConfigSpec('glm-agent', { ...ctx, modelTarget: 'zai/glm-4.6' });
    const content = JSON.parse(spec.content);
    assert.equal(content.defaultModel, 'zai/glm-4.6');
    assert.deepEqual(content.models, ['zai/glm-4.6']);
});

test('buildGatewayConfigSpec: unknown agent returns null', () => {
    assert.equal(buildGatewayConfigSpec('unknown-agent', ctx), null);
});

test('buildGatewayConfigSpec: cline still works (regression check)', () => {
    const spec = buildGatewayConfigSpec('cline', ctx);
    assert.ok(spec, 'cline spec must not be null');
    assert.equal(spec.filePath, '/workspace/.xensemble/state/sess_test/settings/providers.json');
    const content = JSON.parse(spec.content);
    assert.equal(content.providers['openai-compatible'].settings.apiKey, 'xel_test_token');
});

test('codebuddy is in GATEWAY_CONFIG_AGENTS', () => {
    assert.ok(GATEWAY_CONFIG_AGENTS.has('codebuddy'), 'codebuddy must be in GATEWAY_CONFIG_AGENTS');
});

test('buildGatewayConfigSpec: codebuddy writes models.json to CODEBUDDY_CONFIG_DIR (state dir)', () => {
    const spec = buildGatewayConfigSpec('codebuddy', ctx);
    assert.ok(spec, 'codebuddy spec must not be null');
    // CodeBuddy reads models.json from $CODEBUDDY_CONFIG_DIR (set to the
    // session state dir by resumeSession via stateEnv), not ~/.codebuddy.
    assert.equal(spec.filePath, '/workspace/.xensemble/state/sess_test/models.json');
    assert.equal(spec.dirPath, '/workspace/.xensemble/state/sess_test');

    const models = JSON.parse(spec.content);
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'zxs_deepseek/deepseek-v4-flash');
    assert.equal(models[0].apiKey, 'xel_test_token');
    assert.equal(models[0].url, 'https://xensemble.dev/api/v1/llm/v1/chat/completions');
    assert.equal(models[0].vendor, 'custom');

    // trust settings to skip the interactive folder-trust prompt
    assert.equal(spec.extraFiles.length, 1);
    assert.equal(spec.extraFiles[0].filePath, '/workspace/.xensemble/state/sess_test/settings.json');
    const settings = JSON.parse(spec.extraFiles[0].content);
    assert.equal(settings.trustAll, true);
    assert.deepEqual(settings.trustedDirectories, ['/workspace', '/tmp']);
});

test('buildGatewayConfigSpec: codebuddy falls back to $HOME/.codebuddy without a state dir', () => {
    const spec = buildGatewayConfigSpec('codebuddy', { ...ctx, stateDirPath: null });
    assert.ok(spec, 'codebuddy spec must not be null');
    assert.equal(spec.filePath, '$HOME/.codebuddy/models.json');
    assert.equal(spec.dirPath, '$HOME/.codebuddy');
    assert.equal(spec.extraFiles[0].filePath, '$HOME/.codebuddy/settings.json');
});

test('buildGatewayConfigSpec: qwen-code registers all configured models for /model', () => {
    const spec = buildGatewayConfigSpec('qwen-code', {
        ...ctx,
        modelTargets: ['deepseek/deepseek-v4-flash', 'zxs/qwen-max'],
        defaultTarget: 'deepseek/deepseek-v4-flash',
    });
    const content = JSON.parse(spec.content);
    const ids = content.modelProviders.gateway.map((p) => p.id);
    assert.deepEqual(ids, ['deepseek/deepseek-v4-flash', 'zxs/qwen-max']);
    assert.equal(content.model.name, 'deepseek/deepseek-v4-flash');
});

test('buildGatewayConfigSpec: qwen-code single target (back-compat) registers one model', () => {
    const spec = buildGatewayConfigSpec('qwen-code', ctx);
    const content = JSON.parse(spec.content);
    const ids = content.modelProviders.gateway.map((p) => p.id);
    assert.deepEqual(ids, ['zxs_deepseek/deepseek-v4-flash']);
    assert.equal(content.model.name, 'zxs_deepseek/deepseek-v4-flash');
});

test('buildGatewayConfigSpec: glm-agent registers all targets in models array', () => {
    const spec = buildGatewayConfigSpec('glm-agent', {
        ...ctx,
        modelTargets: ['zai/glm-4.6', 'deepseek/deepseek-v4-flash'],
        defaultTarget: 'zai/glm-4.6',
    });
    const content = JSON.parse(spec.content);
    assert.equal(content.defaultModel, 'zai/glm-4.6');
    assert.deepEqual(content.models, ['zai/glm-4.6', 'deepseek/deepseek-v4-flash']);
});

test('buildGatewayConfigSpec: codebuddy registers one entry per target', () => {
    const spec = buildGatewayConfigSpec('codebuddy', {
        ...ctx,
        modelTargets: ['a/m1', 'b/m2'],
        defaultTarget: 'a/m1',
    });
    const models = JSON.parse(spec.content);
    assert.equal(models.length, 2);
    assert.deepEqual(models.map((m) => m.id), ['a/m1', 'b/m2']);
});

test('buildGatewayConfigSpec: droid registers all targets in customModels', () => {
    const spec = buildGatewayConfigSpec('droid', {
        ...ctx,
        modelTargets: ['a/m1', 'b/m2'],
        defaultTarget: 'a/m1',
    });
    const content = JSON.parse(spec.content);
    assert.deepEqual(content.customModels.map((m) => m.model), ['a/m1', 'b/m2']);
});

test('buildGatewayConfigSpec: returns null when no targets at all', () => {
    assert.equal(buildGatewayConfigSpec('qwen-code', { ...ctx, modelTarget: null, modelTargets: [] }), null);
});

test('kimi-code is in GATEWAY_CONFIG_AGENTS', () => {
    assert.ok(GATEWAY_CONFIG_AGENTS.has('kimi-code'), 'kimi-code must be in GATEWAY_CONFIG_AGENTS');
});

test('buildGatewayConfigSpec: kimi-code writes ~/.kimi/config.toml with all models', () => {
    const spec = buildGatewayConfigSpec('kimi-code', {
        ...ctx,
        modelTargets: ['deepseek/deepseek-v4-flash', 'zxs/qwen-max'],
        defaultTarget: 'deepseek/deepseek-v4-flash',
    });
    assert.equal(spec.filePath, '$HOME/.kimi/config.toml');
    assert.equal(spec.dirPath, '$HOME/.kimi');
    const toml = spec.content;
    assert.match(toml, /default_model = "gateway-0"/);
    assert.match(toml, /\[providers\.gateway\]/);
    assert.match(toml, /type = "openai"/);
    assert.match(toml, /base_url = "https:\/\/xensemble\.dev\/api\/v1\/llm\/v1"/);
    assert.match(toml, /\[models\.gateway-0\][\s\S]*model = "deepseek\/deepseek-v4-flash"/);
    assert.match(toml, /\[models\.gateway-1\][\s\S]*model = "zxs\/qwen-max"/);
});

test('buildGatewayConfigSpec: kimi-code single target (back-compat) registers one model', () => {
    const spec = buildGatewayConfigSpec('kimi-code', ctx);
    const toml = spec.content;
    assert.match(toml, /default_model = "gateway-0"/);
    assert.match(toml, /\[models\.gateway-0\][\s\S]*model = "zxs_deepseek\/deepseek-v4-flash"/);
    assert.doesNotMatch(toml, /\[models\.gateway-1\]/);
});
