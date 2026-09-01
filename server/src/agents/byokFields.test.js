const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    BYOK_FIELDS,
    byokStorageKey,
    getByokFieldValues,
    generateByokConfig,
    applyByokToSecrets,
    removeByokFromSecrets,
    mergeByokConfigFiles,
} = require('./byokFields');

// ── BYOK_FIELDS ──

test('BYOK_FIELDS: covers all configurable agents', () => {
    const expected = [
        'kimi-code', 'claude-code', 'opencode', 'cline', 'droid',
        'glm-agent', 'qoder', 'qwen-code', 'minimax-cli', 'pi',
        'commandcode', 'hermes', 'openclaw',
        'github-copilot', 'codebuddy', 'cursor', 'amp',
    ];
    for (const id of expected) {
        const entry = BYOK_FIELDS[id];
        assert.ok(entry, `missing entry for ${id}`);
        assert.ok(Array.isArray(entry.fields), `missing fields array for ${id}`);
        assert.ok(entry.fields.length >= 1, `${id} should have at least 1 field`);
        assert.ok(entry.description, `${id} should have a description`);
    }
});

test('BYOK_FIELDS: truly non-configurable agents are absent', () => {
    assert.equal(BYOK_FIELDS['nonexistent-agent'], undefined);
});

test('BYOK_FIELDS: each field has required shape', () => {
    for (const [agentId, entry] of Object.entries(BYOK_FIELDS)) {
        for (const f of entry.fields) {
            assert.ok(f.key, `${agentId}: field missing key`);
            assert.ok(f.label, `${agentId}: field missing label`);
            assert.ok(f.tooltip, `${agentId}: field missing tooltip`);
            assert.ok(['string', 'secret', 'number'].includes(f.type), `${agentId}: invalid type ${f.type}`);
            assert.equal(typeof f.required, 'boolean', `${agentId}: required must be boolean`);
        }
    }
});

test('BYOK_FIELDS: required fields have no defaultValue', () => {
    for (const [agentId, entry] of Object.entries(BYOK_FIELDS)) {
        for (const f of entry.fields) {
            if (f.required) {
                assert.equal(f.defaultValue, '', `${agentId}.${f.key}: required field should have empty defaultValue`);
            }
        }
    }
});

// ── byokStorageKey ──

test('byokStorageKey: returns __byok_ prefix', () => {
    assert.equal(byokStorageKey('kimi-code'), '__byok_kimi-code');
    assert.equal(byokStorageKey('claude-code'), '__byok_claude-code');
});

// ── getByokFieldValues ──

test('getByokFieldValues: returns parsed values from blob', () => {
    const secrets = { '__byok_cline': JSON.stringify({ ANTHROPIC_API_KEY: 'sk-test' }) };
    const values = getByokFieldValues('cline', secrets);
    assert.deepEqual(values, { ANTHROPIC_API_KEY: 'sk-test' });
});

test('getByokFieldValues: returns empty for missing blob', () => {
    assert.deepEqual(getByokFieldValues('cline', {}), {});
    assert.deepEqual(getByokFieldValues('cline', null), {});
});

test('getByokFieldValues: returns empty for invalid JSON', () => {
    const secrets = { '__byok_cline': 'not-json' };
    assert.deepEqual(getByokFieldValues('cline', secrets), {});
});

// ── generateByokConfig: kimi-code ──

test('generateByokConfig kimi-code: generates TOML with fixed fields', () => {
    const { env, configFiles } = generateByokConfig('kimi-code', {
        api_key: 'sk-kimi',
        base_url: 'https://api.moonshot.cn/v1',
        model: 'kimi-k2.5',
        max_context_size: 256000,
    });
    assert.deepEqual(env, {});
    assert.equal(configFiles.length, 1);
    assert.equal(configFiles[0].path, '${STATE_DIR}/config.toml');
    const content = configFiles[0].content;
    assert.ok(content.includes('default_model = "kimi-default"'));
    assert.ok(content.includes('default_provider = "kimi"'));
    assert.ok(content.includes('type = "kimi"'));
    assert.ok(content.includes('provider = "kimi"'));
    assert.ok(content.includes('api_key = "sk-kimi"'));
    assert.ok(content.includes('model = "kimi-k2.5"'));
    assert.ok(content.includes('max_context_size = 256000'));
});

test('generateByokConfig kimi-code: uses defaults for missing optional fields', () => {
    const { configFiles } = generateByokConfig('kimi-code', { api_key: 'sk-kimi' });
    const content = configFiles[0].content;
    assert.ok(content.includes('base_url = "https://api.moonshot.cn/v1"'));
    assert.ok(content.includes('model = "kimi-k2.5"'));
    assert.ok(content.includes('max_context_size = 256000'));
});

test('generateByokConfig kimi-code: no config file when api_key empty', () => {
    const { configFiles } = generateByokConfig('kimi-code', { api_key: '' });
    assert.equal(configFiles.length, 0);
});

test('generateByokConfig kimi-code: uses openai type when base_url is custom', () => {
    const { configFiles } = generateByokConfig('kimi-code', {
        api_key: 'sk-ds',
        base_url: 'https://api.deepseek.com/v1',
    });
    const content = configFiles[0].content;
    assert.ok(content.includes('type = "openai"'));
    assert.ok(content.includes('base_url = "https://api.deepseek.com/v1"'));
});

// ── generateByokConfig: claude-code ──

test('generateByokConfig claude-code: generates env only', () => {
    const { env, configFiles } = generateByokConfig('claude-code', {
        ANTHROPIC_API_KEY: 'sk-ant',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_MODEL: 'claude-sonnet-4',
        ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku',
    });
    assert.deepEqual(env, {
        ANTHROPIC_API_KEY: 'sk-ant',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_MODEL: 'claude-sonnet-4',
        ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku',
    });
    assert.equal(configFiles.length, 0);
});

test('generateByokConfig claude-code: skips empty optional fields', () => {
    const { env } = generateByokConfig('claude-code', {
        ANTHROPIC_API_KEY: 'sk-ant',
        ANTHROPIC_MODEL: '',
    });
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant');
    assert.equal(env.ANTHROPIC_MODEL, undefined);
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
});

// ── generateByokConfig: cline ──

test('generateByokConfig cline: only apiKey generates env only', () => {
    const { env, configFiles } = generateByokConfig('cline', { ANTHROPIC_API_KEY: 'sk-test' });
    assert.deepEqual(env, { ANTHROPIC_API_KEY: 'sk-test' });
    assert.equal(configFiles.length, 0);
});

test('generateByokConfig cline: apiKey + baseUrl generates providers.json', () => {
    const { env, configFiles } = generateByokConfig('cline', {
        ANTHROPIC_API_KEY: 'sk-test',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
    });
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-test');
    assert.equal(configFiles.length, 1);
    assert.ok(configFiles[0].path.endsWith('providers.json'));
    const parsed = JSON.parse(configFiles[0].content);
    assert.equal(parsed.providers['openai-compatible'].settings.apiKey, 'sk-test');
    assert.equal(parsed.providers['openai-compatible'].settings.baseUrl, 'https://api.deepseek.com/v1');
    assert.equal(parsed.providers['openai-compatible'].settings.model, 'deepseek-chat');
});

test('generateByokConfig cline: no apiKey returns empty', () => {
    const { env, configFiles } = generateByokConfig('cline', {});
    assert.deepEqual(env, {});
    assert.equal(configFiles.length, 0);
});

// ── generateByokConfig: minimax-cli / commandcode ──

test('generateByokConfig minimax-cli: single env var', () => {
    const { env } = generateByokConfig('minimax-cli', { MINIMAX_API_KEY: 'mmx-test' });
    assert.deepEqual(env, { MINIMAX_API_KEY: 'mmx-test' });
});

test('generateByokConfig commandcode: single env var', () => {
    const { env } = generateByokConfig('commandcode', { COHERE_API_KEY: 'co-test' });
    assert.deepEqual(env, { COHERE_API_KEY: 'co-test' });
});

// ── generateByokConfig: opencode ──

test('generateByokConfig opencode: generates JSON with npm and name from provider', () => {
    const { env, configFiles } = generateByokConfig('opencode', {
        apiKey: 'sk-ds',
        baseURL: 'https://api.deepseek.com',
        model: 'my-deepseek/deepseek-chat',
        provider: 'my-deepseek',
    });
    assert.deepEqual(env, {});
    assert.equal(configFiles.length, 1);
    assert.equal(configFiles[0].path, '/root/.config/opencode/opencode.json');
    const parsed = JSON.parse(configFiles[0].content);
    assert.equal(parsed.autoupdate, false);
    assert.equal(parsed.model, 'my-deepseek/deepseek-chat');
    assert.equal(parsed.provider['my-deepseek'].npm, '@ai-sdk/openai-compatible');
    assert.equal(parsed.provider['my-deepseek'].name, 'my-deepseek');
    assert.equal(parsed.provider['my-deepseek'].options.apiKey, 'sk-ds');
    assert.equal(parsed.provider['my-deepseek'].options.baseURL, 'https://api.deepseek.com');
    assert.ok(parsed.provider['my-deepseek'].models['deepseek-chat']);
});

// ── generateByokConfig: droid ──

test('generateByokConfig droid: generates settings.json with customModels', () => {
    const { env, configFiles } = generateByokConfig('droid', {
        apiKey: 'sk-ds',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        provider: 'generic-chat-completion-api',
    });
    assert.deepEqual(env, { FACTORY_AIRGAP_ENABLED: '1' });
    assert.equal(configFiles.length, 1);
    assert.equal(configFiles[0].path, '${STATE_DIR}/.factory/settings.json');
    const parsed = JSON.parse(configFiles[0].content);
    assert.equal(parsed.customModels.length, 1);
    assert.equal(parsed.customModels[0].provider, 'generic-chat-completion-api');
    assert.equal(parsed.customModels[0].model, 'deepseek-chat');
    assert.equal(parsed.customModels[0].apiKey, 'sk-ds');
});

// ── generateByokConfig: glm-agent ──

test('generateByokConfig glm-agent: preserves models whitelist and appends defaultModel', () => {
    const { configFiles } = generateByokConfig('glm-agent', {
        apiKey: 'sk-zai',
        defaultModel: 'glm-custom',
    });
    const parsed = JSON.parse(configFiles[0].content);
    assert.deepEqual(parsed.models, ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-custom']);
    assert.equal(parsed.defaultModel, 'glm-custom');
    assert.equal(parsed.apiKey, 'sk-zai');
    assert.equal(parsed.watchEnabled, false);
});

test('generateByokConfig glm-agent: does not duplicate when defaultModel in whitelist', () => {
    const { configFiles } = generateByokConfig('glm-agent', {
        apiKey: 'sk-zai',
        defaultModel: 'glm-4.6',
    });
    const parsed = JSON.parse(configFiles[0].content);
    assert.deepEqual(parsed.models, ['glm-4.6', 'glm-4.5', 'glm-4.5-air']);
});

// ── generateByokConfig: qoder ──

test('generateByokConfig qoder: generates env + settings.json', () => {
    const { env, configFiles } = generateByokConfig('qoder', {
        QODER_PERSONAL_ACCESS_TOKEN: 'tok-qoder',
        apiKey: 'sk-ds',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
    });
    assert.equal(env.QODER_PERSONAL_ACCESS_TOKEN, 'tok-qoder');
    assert.equal(configFiles.length, 1);
    assert.equal(configFiles[0].path, '${STATE_DIR}/settings.json');
    const parsed = JSON.parse(configFiles[0].content);
    assert.equal(parsed.model, 'custom/deepseek-chat');
    assert.equal(parsed.providers['custom'].apiKey, 'sk-ds');
    assert.equal(parsed.general.enableAutoUpdate, false);
});

// ── generateByokConfig: qwen-code ──

test('generateByokConfig qwen-code: env only when customApiKey empty', () => {
    const { env, configFiles } = generateByokConfig('qwen-code', {
        DASHSCOPE_API_KEY: 'sk-dash',
    });
    assert.equal(env.DASHSCOPE_API_KEY, 'sk-dash');
    assert.equal(configFiles.length, 0);
});

test('generateByokConfig qwen-code: generates settings.json when customApiKey filled', () => {
    const { env, configFiles } = generateByokConfig('qwen-code', {
        DASHSCOPE_API_KEY: 'sk-dash',
        customApiKey: 'sk-custom',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
    });
    assert.equal(env.DASHSCOPE_API_KEY, 'sk-dash');
    assert.equal(configFiles.length, 1);
    const parsed = JSON.parse(configFiles[0].content);
    assert.equal(parsed.env.CUSTOM_API_KEY, 'sk-custom');
    assert.equal(parsed.modelProviders['custom'][0].envKey, 'CUSTOM_API_KEY');
    // generationConfig.contextWindowSize must be written to override qwen's
    // internal DEFAULT_TOKEN_LIMIT=200000 fallback; default 1048576.
    assert.equal(parsed.modelProviders['custom'][0].generationConfig.contextWindowSize, 1048576);
});

test('generateByokConfig qwen-code: respects custom max_context_size', () => {
    const { configFiles } = generateByokConfig('qwen-code', {
        DASHSCOPE_API_KEY: 'sk-dash',
        customApiKey: 'sk-custom',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        max_context_size: 131072,
    });
    const parsed = JSON.parse(configFiles[0].content);
    assert.equal(parsed.modelProviders['custom'][0].generationConfig.contextWindowSize, 131072);
});

// ── generateByokConfig: pi ──

test('generateByokConfig pi: env only when apiKey empty', () => {
    const { env, configFiles } = generateByokConfig('pi', {
        ANTHROPIC_API_KEY: 'sk-ant',
        OPENAI_API_KEY: 'sk-oai',
    });
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant');
    assert.equal(env.OPENAI_API_KEY, 'sk-oai');
    assert.equal(configFiles.length, 0);
});

test('generateByokConfig pi: generates models.json when apiKey filled', () => {
    const { env, configFiles } = generateByokConfig('pi', {
        ANTHROPIC_API_KEY: 'sk-ant',
        OPENAI_API_KEY: 'sk-oai',
        apiKey: 'sk-custom',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
    });
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant');
    assert.equal(env.OPENAI_API_KEY, 'sk-oai');
    assert.equal(configFiles.length, 1);
    assert.equal(configFiles[0].path, '/root/.pi/agent/models.json');
    const parsed = JSON.parse(configFiles[0].content);
    assert.equal(parsed.providers['custom'].apiKey, 'sk-custom');
    assert.equal(parsed.providers['custom'].api, 'openai-completions');
});

// ── generateByokConfig: hermes ──

test('generateByokConfig hermes: generates YAML', () => {
    const { env, configFiles } = generateByokConfig('hermes', {
        api_key: 'sk-ds',
        base_url: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        api_mode: 'openai',
    });
    assert.deepEqual(env, {});
    assert.equal(configFiles.length, 1);
    assert.equal(configFiles[0].path, '${STATE_DIR}/config.yaml');
    const content = configFiles[0].content;
    assert.ok(content.includes('provider: auto'));
    assert.ok(content.includes('name: Custom'));
    assert.ok(content.includes('api_key: sk-ds'));
    assert.ok(content.includes('api_mode: openai'));
    assert.ok(content.includes('model: deepseek-chat'));
    // context_length written so hermes doesn't fall back to its hardcoded 200K default
    assert.ok(content.includes('context_length: 1048576'));
});

test('generateByokConfig hermes: respects custom max_context_size', () => {
    const { configFiles } = generateByokConfig('hermes', {
        api_key: 'sk-ds',
        base_url: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        max_context_size: 131072,
    });
    const content = configFiles[0].content;
    assert.ok(content.includes('context_length: 131072'));
});

// ── generateByokConfig: openclaw ──

test('generateByokConfig openclaw: generates JSON with mode=merge and logging.level=info', () => {
    const { env, configFiles } = generateByokConfig('openclaw', {
        apiKey: 'sk-ds',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        api: 'openai-completions',
    });
    assert.deepEqual(env, {});
    assert.equal(configFiles.length, 1);
    assert.equal(configFiles[0].path, '${STATE_DIR}/openclaw.json');
    const parsed = JSON.parse(configFiles[0].content);
    assert.equal(parsed.models.mode, 'merge');
    assert.equal(parsed.logging.level, 'info');
    assert.equal(parsed.agents.defaults.model.primary, 'openai/deepseek-chat');
    assert.equal(parsed.models.providers['openai'].apiKey, 'sk-ds');
});

// ── generateByokConfig: github-copilot ──

test('generateByokConfig github-copilot: generates env only', () => {
    const { env, configFiles } = generateByokConfig('github-copilot', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
    });
    assert.deepEqual(env, {
        COPILOT_PROVIDER_API_KEY: 'sk-test',
        COPILOT_PROVIDER_BASE_URL: 'https://api.openai.com/v1',
        COPILOT_PROVIDER_TYPE: 'openai',
        COPILOT_MODEL: 'gpt-4o',
    });
    assert.equal(configFiles.length, 0);
});

test('generateByokConfig github-copilot: no env when apiKey empty', () => {
    const { env, configFiles } = generateByokConfig('github-copilot', { apiKey: '' });
    assert.deepEqual(env, {});
    assert.equal(configFiles.length, 0);
});

// ── generateByokConfig: codebuddy ──

test('generateByokConfig codebuddy: generates env + models.json + settings.json', () => {
    const { env, configFiles } = generateByokConfig('codebuddy', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4o',
    });
    assert.equal(env.CODEBUDDY_API_KEY, 'sk-test');
    assert.equal(configFiles.length, 2);
    const modelsJson = configFiles.find((f) => f.path.endsWith('models.json'));
    assert.ok(modelsJson);
    const parsed = JSON.parse(modelsJson.content);
    assert.equal(parsed[0].apiKey, 'sk-test');
    assert.equal(parsed[0].id, 'gpt-4o');
    assert.equal(parsed[0].name, 'gpt-4o');
    assert.equal(parsed[0].vendor, 'custom');
    const settingsJson = configFiles.find((f) => f.path.endsWith('settings.json'));
    assert.ok(settingsJson);
    const settings = JSON.parse(settingsJson.content);
    assert.equal(settings.trustAll, true);
});

test('generateByokConfig codebuddy: no config when apiKey empty', () => {
    const { env, configFiles } = generateByokConfig('codebuddy', { apiKey: '' });
    assert.deepEqual(env, {});
    assert.equal(configFiles.length, 0);
});

test('generateByokConfig codebuddy: writes maxInputTokens + autoCompactWindow', () => {
    const { configFiles } = generateByokConfig('codebuddy', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1/chat/completions',
        model: 'claude-sonnet-4-5',
    });
    const modelsJson = configFiles.find((f) => f.path.endsWith('models.json'));
    const parsed = JSON.parse(modelsJson.content);
    // maxInputTokens is the context window field; default 1048576 here
    assert.equal(parsed[0].maxInputTokens, 1048576);
    const settingsJson = configFiles.find((f) => f.path.endsWith('settings.json'));
    const settings = JSON.parse(settingsJson.content);
    assert.equal(settings.autoCompactEnabled, true);
    // 1M stays 1M (within codebuddy's [100k, 1M] clamp)
    assert.equal(settings.autoCompactWindow, 1000000);
});

test('generateByokConfig codebuddy: clamps autoCompactWindow to [100k, 1M]', () => {
    const { configFiles } = generateByokConfig('codebuddy', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4o',
        max_context_size: 64000, // below codebuddy's 100k floor
    });
    const modelsJson = configFiles.find((f) => f.path.endsWith('models.json'));
    const parsed = JSON.parse(modelsJson.content);
    // models.json stores the real value; settings.json is the clamped one
    assert.equal(parsed[0].maxInputTokens, 64000);
    const settingsJson = configFiles.find((f) => f.path.endsWith('settings.json'));
    const settings = JSON.parse(settingsJson.content);
    assert.equal(settings.autoCompactWindow, 100000);
});

// ── generateByokConfig: cursor ──

test('generateByokConfig cursor: generates env only', () => {
    const { env, configFiles } = generateByokConfig('cursor', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
    });
    assert.deepEqual(env, {
        OPENAI_API_KEY: 'sk-test',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_MODEL: 'gpt-4o',
    });
    assert.equal(configFiles.length, 0);
});

// ── generateByokConfig: amp ──

test('generateByokConfig amp: generates env only', () => {
    const { env, configFiles } = generateByokConfig('amp', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
    });
    assert.deepEqual(env, {
        OPENAI_API_KEY: 'sk-test',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_MODEL: 'gpt-4o',
    });
    assert.equal(configFiles.length, 0);
});

// ── generateByokConfig: edge cases ──

test('generateByokConfig: unknown agent returns empty', () => {
    const { env, configFiles } = generateByokConfig('unknown', { foo: 'bar' });
    assert.deepEqual(env, {});
    assert.deepEqual(configFiles, []);
});

test('generateByokConfig: null values returns empty', () => {
    const { env, configFiles } = generateByokConfig('kimi-code', null);
    assert.deepEqual(env, {});
    assert.deepEqual(configFiles, []);
});

// ── applyByokToSecrets ──

test('applyByokToSecrets: stores blob + individual env keys', () => {
    const updated = applyByokToSecrets('cline', { ANTHROPIC_API_KEY: 'sk-test' }, {});
    assert.ok(updated['__byok_cline']);
    assert.equal(updated.ANTHROPIC_API_KEY, 'sk-test');
    const blob = JSON.parse(updated['__byok_cline']);
    assert.deepEqual(blob, { ANTHROPIC_API_KEY: 'sk-test' });
});

test('applyByokToSecrets: removes old env keys when values change', () => {
    const oldSecrets = applyByokToSecrets('claude-code', {
        ANTHROPIC_API_KEY: 'sk-old',
        ANTHROPIC_MODEL: 'old-model',
    }, {});
    const updated = applyByokToSecrets('claude-code', {
        ANTHROPIC_API_KEY: 'sk-new',
    }, oldSecrets);
    assert.equal(updated.ANTHROPIC_API_KEY, 'sk-new');
    assert.equal(updated.ANTHROPIC_MODEL, undefined);
});

test('applyByokToSecrets: preserves non-BYOK secrets', () => {
    const existing = { MY_OTHER_SECRET: 'keep-me' };
    const updated = applyByokToSecrets('cline', { ANTHROPIC_API_KEY: 'sk-test' }, existing);
    assert.equal(updated.MY_OTHER_SECRET, 'keep-me');
});

// ── removeByokFromSecrets ──

test('removeByokFromSecrets: removes blob and env keys', () => {
    const withByok = applyByokToSecrets('cline', { ANTHROPIC_API_KEY: 'sk-test' }, { OTHER: 'val' });
    const cleaned = removeByokFromSecrets('cline', withByok);
    assert.equal(cleaned['__byok_cline'], undefined);
    assert.equal(cleaned.ANTHROPIC_API_KEY, undefined);
    assert.equal(cleaned.OTHER, 'val');
});

// ── mergeByokConfigFiles ──

test('mergeByokConfigFiles: session files override BYOK files with same path', () => {
    const byok = [{ path: '${STATE_DIR}/settings.json', content: '{"byok":true}' }];
    const session = [{ path: '${STATE_DIR}/settings.json', content: '{"session":true}' }];
    const merged = mergeByokConfigFiles(byok, session);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].content, '{"session":true}');
});

test('mergeByokConfigFiles: different paths are both kept', () => {
    const byok = [{ path: '${STATE_DIR}/config.toml', content: 'toml' }];
    const session = [{ path: '${STATE_DIR}/settings.json', content: 'json' }];
    const merged = mergeByokConfigFiles(byok, session);
    assert.equal(merged.length, 2);
});

test('mergeByokConfigFiles: handles empty inputs', () => {
    assert.deepEqual(mergeByokConfigFiles([], []), []);
    assert.deepEqual(mergeByokConfigFiles(null, null), []);
});
