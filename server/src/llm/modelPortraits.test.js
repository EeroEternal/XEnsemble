const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { canonicalModelId, fetchModelPortraits, findOfferings } = require('./modelPortraits');

test('canonicalModelId strips anthropic. and aggregator prefix', () => {
    assert.equal(canonicalModelId('anthropic.deepseek/deepseek-chat'), 'deepseek-chat');
    assert.equal(canonicalModelId('google/gemini-3.5-flash'), 'gemini-3.5-flash');
    assert.equal(canonicalModelId('deepseek-chat'), 'deepseek-chat');
});

test('fetchModelPortraits reads JSON and findOfferings matches canonical id', () => {
    const portraits = fetchModelPortraits({
        registryPath: path.join(__dirname, 'modelPortraits.registry.json'),
    });
    const hits = findOfferings(portraits, { modelId: 'deepseek-chat' });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].canonical_model_id, 'deepseek-chat');
    assert.equal(typeof hits[0].global_pricing.prompt, 'number');
});
