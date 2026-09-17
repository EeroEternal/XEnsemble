const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolvePortraitProviderIds } = require('./boundProviders');

test('resolvePortraitProviderIds always includes the gateway instance name', () => {
    assert.deepEqual(resolvePortraitProviderIds('deepseek'), ['deepseek']);
    assert.deepEqual(resolvePortraitProviderIds(''), []);
});

test('resolvePortraitProviderIds adds endpoint_id and its provider_id prefix', () => {
    const ids = resolvePortraitProviderIds('deepseek-main', [
        { name: 'deepseek-main', endpoint_id: 'deepseek' },
        { name: 'openrouter-global', endpoint_id: 'openrouter:global' },
    ]);
    assert.deepEqual(ids.sort(), ['deepseek', 'deepseek-main'].sort());
});

test('resolvePortraitProviderIds splits endpoint_id on colon', () => {
    const ids = resolvePortraitProviderIds('or-1', [
        { name: 'or-1', endpoint_id: 'openrouter:global' },
    ]);
    assert.ok(ids.includes('or-1'));
    assert.ok(ids.includes('openrouter:global'));
    assert.ok(ids.includes('openrouter'));
});
