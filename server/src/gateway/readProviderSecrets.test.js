process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseProvidersFromToml, modelsFromProviderEntry } = require('./readProviderSecrets');

const TOML = [
    '[[providers]]',
    "name = 'local-vllm'",
    "provider_type = 'openai'",
    "model_mapping = '{\"qwen3-coder-30b-fp8\":\"qwen3-coder-30b-fp8\"}'",
    'is_enabled = true',
    '',
    '[[providers]]',
    'name = "double-quoted"',
    'model_mapping = "{\\"a\\":\\"a\\"}"',
    '',
    '[[bindings]]',
    'service_id = "codebuddy"',
    'provider_name = "local-vllm"',
    '',
].join('\n');

test('parseProvidersFromToml reads single-quoted TOML literal strings', () => {
    const providers = parseProvidersFromToml(TOML);
    const local = providers.find((p) => p.name === 'local-vllm');
    assert.ok(local, 'local-vllm provider should be parsed');
    assert.equal(local.model_mapping, '{"qwen3-coder-30b-fp8":"qwen3-coder-30b-fp8"}');
    assert.equal(local.is_enabled, true);
});

test('parseProvidersFromToml still reads double-quoted strings', () => {
    const providers = parseProvidersFromToml(TOML);
    const dq = providers.find((p) => p.name === 'double-quoted');
    assert.equal(dq.model_mapping, '{"a":"a"}');
});

test('modelsFromProviderEntry extracts keys from a literal-string model_mapping', () => {
    const providers = parseProvidersFromToml(TOML);
    const local = providers.find((p) => p.name === 'local-vllm');
    assert.deepEqual(modelsFromProviderEntry(local), ['qwen3-coder-30b-fp8']);
});
