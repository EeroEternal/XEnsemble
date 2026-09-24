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

    const content = JSON.parse(spec.content);
    // Official schema is { models, availableModels }. Without availableModels
    // CodeBuddy shows the full Tencent catalog (Gemini/GPT/...) plus custom.
    assert.ok(Array.isArray(content.models));
    assert.equal(content.models.length, 1);
    assert.equal(content.models[0].id, 'zxs_deepseek/deepseek-v4-flash');
    assert.equal(content.models[0].apiKey, 'xel_test_token');
    assert.equal(content.models[0].url, 'https://xensemble.dev/api/v1/llm/v1/chat/completions');
    assert.equal(content.models[0].vendor, 'custom');
    assert.deepEqual(content.availableModels, ['zxs_deepseek/deepseek-v4-flash']);

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
    const content = JSON.parse(spec.content);
    assert.equal(content.models.length, 2);
    assert.deepEqual(content.models.map((m) => m.id), ['a/m1', 'b/m2']);
    assert.deepEqual(content.availableModels, ['a/m1', 'b/m2']);
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

test('buildGatewayConfigSpec: kimi-code writes config.toml to stateDirPath (not ~/.kimi)', () => {
    const spec = buildGatewayConfigSpec('kimi-code', {
        ...ctx,
        modelTargets: ['deepseek/deepseek-v4-flash', 'zxs/qwen-max'],
        defaultTarget: 'deepseek/deepseek-v4-flash',
    });
    assert.equal(spec.filePath, '/workspace/.xensemble/state/sess_test/config.toml');
    assert.equal(spec.dirPath, '/workspace/.xensemble/state/sess_test');
    const toml = spec.content;
    assert.match(toml, /default_model = "gateway-0"/);
    assert.match(toml, /\[providers\.gateway\]/);
    assert.match(toml, /type = "openai"/);
    assert.match(toml, /base_url = "https:\/\/xensemble\.dev\/api\/v1\/llm\/v1"/);
    assert.match(toml, /\[models\.gateway-0\][\s\S]*model = "deepseek\/deepseek-v4-flash"/);
    assert.match(toml, /\[models\.gateway-1\][\s\S]*model = "zxs\/qwen-max"/);
    assert.doesNotMatch(toml, /HOME\/\.kimi/);
    assert.ok(spec.extraFiles?.some((f) => f.filePath.endsWith('.skip-migration-from-kimi-cli')),
        'must write .skip-migration-from-kimi-cli marker to suppress the kimi-cli migration prompt');
});

test('buildGatewayConfigSpec: kimi-code single target (back-compat) registers one model', () => {
    const spec = buildGatewayConfigSpec('kimi-code', ctx);
    const toml = spec.content;
    assert.match(toml, /default_model = "gateway-0"/);
    assert.match(toml, /\[models\.gateway-0\][\s\S]*model = "zxs_deepseek\/deepseek-v4-flash"/);
    assert.doesNotMatch(toml, /\[models\.gateway-1\]/);
});

test('buildGatewayConfigSpec: qwen-code writes generationConfig.contextWindowSize to override 200K fallback', () => {
    const spec = buildGatewayConfigSpec('qwen-code', ctx);
    assert.ok(spec, 'spec must not be null for qwen-code');
    const content = JSON.parse(spec.content);
    assert.equal(content.modelProviders.gateway.length, 1);
    // guessContextLength('zxs_deepseek/deepseek-v4-flash') -> 1048576 (deepseek-v4 prefix in MODEL_CONTEXT_LENGTHS)
    assert.equal(content.modelProviders.gateway[0].id, 'zxs_deepseek/deepseek-v4-flash');
    assert.equal(content.modelProviders.gateway[0].generationConfig.contextWindowSize, 1048576);
});

test('buildGatewayConfigSpec: qwen-code with unknown model falls back to 1M default', () => {
    const spec = buildGatewayConfigSpec('qwen-code', { ...ctx, modelTarget: 'openrouter-zxs2/nvidia/nemotron-3-ultra-550b-a55b:free' });
    const content = JSON.parse(spec.content);
    assert.equal(content.modelProviders.gateway[0].generationConfig.contextWindowSize, 1048576);
});

test('buildGatewayConfigSpec: qwen-code with multi-targets writes contextWindowSize per model', () => {
    const spec = buildGatewayConfigSpec('qwen-code', {
        ...ctx,
        modelTargets: ['zxs_deepseek/deepseek-v4-flash', 'anthropic/claude-sonnet-4.5'],
        defaultTarget: 'anthropic/claude-sonnet-4.5',
    });
    const content = JSON.parse(spec.content);
    assert.equal(content.modelProviders.gateway.length, 2);
    assert.equal(content.modelProviders.gateway[0].generationConfig.contextWindowSize, 1048576);
    assert.equal(content.modelProviders.gateway[1].generationConfig.contextWindowSize, 200000);
    assert.equal(content.model.name, 'anthropic/claude-sonnet-4.5');
});

test('buildGatewayConfigSpec: pi writes contextWindow per model (camelCase)', () => {
    const spec = buildGatewayConfigSpec('pi', ctx);
    const content = JSON.parse(spec.content);
    const models = content.providers.gateway.models;
    // deepseek-v4 prefix → 1048576
    assert.equal(models[0].contextWindow, 1048576);
    assert.equal(models[0].id, 'zxs_deepseek/deepseek-v4-flash');
});

test('buildGatewayConfigSpec: openclaw writes contextWindow per model', () => {
    const spec = buildGatewayConfigSpec('openclaw', ctx);
    const content = JSON.parse(spec.content);
    const models = content.models.providers.gateway.models;
    assert.equal(models[0].contextWindow, 1048576);
});

test('buildGatewayConfigSpec: cline writes provider contextWindow + per-model models.json', () => {
    const spec = buildGatewayConfigSpec('cline', ctx);
    const modelId = 'zxs_deepseek/deepseek-v4-flash';

    // providers.json：settings.contextWindow 是 cline 3.0.55 里真正生效的
    // auto-compact 旋钮（zod schema 原生接受，映射为 handler maxInputTokens）。
    // 单目标时等于该模型的窗口；多目标时取 min，保证 0.9*触发线不越过任何
    // 已配置模型的真实窗口。嵌套 models 仍会被 strip，不允许出现。
    const content = JSON.parse(spec.content);
    const settings = content.providers['openai-compatible'].settings;
    assert.equal(settings.provider, 'openai-compatible');
    assert.equal(settings.apiKey, 'xel_test_token');
    assert.equal(settings.contextWindow, 1048576);
    assert.equal(settings.models, undefined, 'providers.json 不应带会被 strip 的 models');

    // models.json：注册 per-model 元数据（/model 列表等）；注意它不影响
    // model.info/压缩阈值（见 ensureGatewayConfig.js cline 段注释）。
    assert.ok(Array.isArray(spec.extraFiles), 'cline 必须额外写 models.json');
    const modelsFile = spec.extraFiles.find((f) => f.filePath.endsWith('/models.json'));
    assert.ok(modelsFile, 'models.json extraFile 必须存在');
    assert.equal(modelsFile.filePath, '/workspace/.xensemble/state/sess_test/settings/models.json');

    const modelsJson = JSON.parse(modelsFile.content);
    const entry = modelsJson.providers['openai-compatible'];
    assert.equal(entry.provider.name, 'OpenAI Compatible');
    assert.equal(entry.provider.defaultModelId, modelId);
    assert.equal(entry.models[modelId].id, modelId);
    assert.equal(entry.models[modelId].contextWindow, 1048576);
    assert.equal(entry.models[modelId].maxInputTokens, 1048576);
});

test('buildGatewayConfigSpec: cline provider contextWindow uses min across targets', () => {
    const spec = buildGatewayConfigSpec('cline', {
        ...ctx,
        modelTargets: ['zxs_deepseek/deepseek-v4-flash', 'zxs_anthropic/claude-sonnet-4.5'],
        defaultTarget: 'zxs_deepseek/deepseek-v4-flash',
    });
    const settings = JSON.parse(spec.content).providers['openai-compatible'].settings;
    // guessContextLength: deepseek-v4 → 1048576, claude-sonnet → 200000 → min = 200000
    assert.equal(settings.contextWindow, 200000);

    const modelsFile = spec.extraFiles.find((f) => f.filePath.endsWith('/models.json'));
    const modelsJson = JSON.parse(modelsFile.content);
    assert.equal(modelsJson.providers['openai-compatible'].models['zxs_anthropic/claude-sonnet-4.5'].contextWindow, 200000);
    assert.equal(modelsJson.providers['openai-compatible'].models['zxs_deepseek/deepseek-v4-flash'].contextWindow, 1048576);
});

test('buildGatewayConfigSpec: openclaw with multi-targets respects per-model context', () => {
    const spec = buildGatewayConfigSpec('openclaw', {
        ...ctx,
        modelTargets: ['anthropic/claude-sonnet-4.5', 'openrouter-zxs2/nvidia/nemotron-3-ultra-550b-a55b:free'],
        defaultTarget: 'openrouter-zxs2/nvidia/nemotron-3-ultra-550b-a55b:free',
    });
    const content = JSON.parse(spec.content);
    const models = content.models.providers.gateway.models;
    assert.equal(models[0].contextWindow, 200000);
    assert.equal(models[1].contextWindow, 1048576);
});

test('buildGatewayConfigSpec: opencode writes limit.context per model (official schema)', () => {
    const spec = buildGatewayConfigSpec('opencode', ctx);
    const content = JSON.parse(spec.content);
    const models = content.provider.gateway.models;
    // deepseek-v4 prefix → 1048576
    assert.equal(models['deepseek-v4-flash'].limit.context, 1048576);
    assert.equal(models['deepseek-v4-flash'].limit.output, 8192);
    // the model key is the bare id (no provider prefix) so opencode's
    // provider/model_id parser resolves to our `gateway` provider.
    assert.equal(content.model, 'gateway/deepseek-v4-flash');
    assert.deepEqual(content.enabled_providers, ['gateway']);
});

test('buildGatewayConfigSpec: opencode writes tui.json with adaptive system theme', () => {
    const spec = buildGatewayConfigSpec('opencode', ctx);
    const tui = (spec.extraFiles || []).find((f) => f.filePath === '/root/.config/opencode/tui.json');
    assert.ok(tui, 'expected tui.json in extraFiles');
    assert.equal(tui.dirPath, '/root/.config/opencode');
    const parsed = JSON.parse(tui.content);
    // "system" theme follows the host terminal palette so the TUI matches the
    // embedded xterm light/dark appearance instead of painting a dark canvas.
    assert.equal(parsed.theme, 'system');
    assert.ok(parsed.$schema);
});

test('buildGatewayConfigSpec: opencode with unknown model falls back to 1M', () => {
    const spec = buildGatewayConfigSpec('opencode', {
        ...ctx,
        modelTarget: 'openrouter-zxs2/nvidia/nemotron-3-ultra-550b-a55b:free',
    });
    const content = JSON.parse(spec.content);
    const models = content.provider.gateway.models;
    // opencode's parser splits on `/`, so we hand it a no-`/`/no-`:` alias
    // (`/` and `:` -> `-`); UniGateway's model_mapping translates the alias
    // back to the real upstream model. Models.dev lacks this long-tail model
    // entirely; without our override opencode treats it as having 0-token
    // context. Write 1M via guessContextLength on the real id.
    assert.equal(models['nvidia-nemotron-3-ultra-550b-a55b-free'].limit.context, 1048576);
    assert.equal(models['nvidia-nemotron-3-ultra-550b-a55b-free'].limit.output, 8192);
    assert.equal(content.model, 'gateway/nvidia-nemotron-3-ultra-550b-a55b-free');
});

test('buildGatewayConfigSpec: droid writes compactionTokenLimit + per-model map', () => {
    const spec = buildGatewayConfigSpec('droid', ctx);
    const content = JSON.parse(spec.content);
    // generic fallback = max of all targets
    assert.equal(content.compactionTokenLimit, 1048576);
    // per-model map
    assert.equal(content.compactionTokenLimitPerModel['zxs_deepseek/deepseek-v4-flash'], 1048576);
    // customModels entry still emitted (the model itself)
    assert.equal(content.customModels[0].model, 'zxs_deepseek/deepseek-v4-flash');
});

test('buildGatewayConfigSpec: hermes writes model.context_length + provider.models context_length', () => {
    const spec = buildGatewayConfigSpec('hermes', ctx);
    // YAML output, parse loosely
    assert.match(spec.content, /context_length: 1048576/);
    assert.match(spec.content, /model:\s*\n\s*default: "zxs_deepseek\/deepseek-v4-flash"/);
    // Picker first row is the UniGateway provider, not Hermes' synthetic "auto".
    // Model keys stay the full provider/model target so the request body still
    // routes on UniGateway.
    assert.match(spec.content, /provider: "zxs_deepseek"/);
    assert.match(spec.content, /providers:\s*\n\s*zxs_deepseek:\s*\n\s*base_url:/);
    assert.doesNotMatch(spec.content, /provider: "auto"/);
    assert.match(spec.content, /models:\s*\n\s{6}"zxs_deepseek\/deepseek-v4-flash":\s*\n\s{8}id: "zxs_deepseek\/deepseek-v4-flash"/);
    assert.match(spec.content, /max_tokens: 8192/);
    // Dict-shaped models: is metadata, not an allowlist. Pin the row so
    // Hermes does not probe /v1/models and append extra ids beside Gateway's.
    assert.match(spec.content, /discover_models: false/);
});

test('buildGatewayConfigSpec: codebuddy writes maxInputTokens + autoCompactWindow in settings.json', () => {
    const spec = buildGatewayConfigSpec('codebuddy', ctx);
    const content = JSON.parse(spec.content);
    assert.equal(content.models[0].maxInputTokens, 1048576);
    assert.equal(content.models[0].maxOutputTokens, 8192);
    const settings = JSON.parse(spec.extraFiles[0].content);
    assert.equal(settings.autoCompactEnabled, true);
    // codebuddy clamps autoCompactWindow to [100k, 1M]; 1M stays 1M
    assert.equal(settings.autoCompactWindow, 1000000);
});
