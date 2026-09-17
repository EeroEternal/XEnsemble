const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toOpencodeModelAlias, resolveOpencodeRoutedModel } = require('./agentModelAlias');

test('toOpencodeModelAlias replaces slash and colon', () => {
    assert.equal(toOpencodeModelAlias('nvidia/foo:bar'), 'nvidia-foo-bar');
    assert.equal(toOpencodeModelAlias('google/gemini-2.0-flash'), 'google-gemini-2.0-flash');
});

test('resolveOpencodeRoutedModel maps pre-route alias plus bound provider to real id', () => {
    const out = resolveOpencodeRoutedModel('google-gemini-2.0-flash', {
        reals: ['google/gemini-2.0-flash'],
        chosenProvider: 'openrouter',
    });
    assert.equal(out, 'openrouter/google/gemini-2.0-flash');
});

test('resolveOpencodeRoutedModel recovers real id after routing prefixes the alias', () => {
    const out = resolveOpencodeRoutedModel('openrouter/google-gemini-2.0-flash', {
        reals: ['google/gemini-2.0-flash'],
        chosenProvider: 'openrouter',
    });
    assert.equal(out, 'openrouter/google/gemini-2.0-flash');
    assert.notEqual(out, 'openrouter/google-gemini-2.0-flash');
});

test('resolveOpencodeRoutedModel strips gateway/ prefix from opencode default model', () => {
    const out = resolveOpencodeRoutedModel('gateway/nvidia-foo-bar', {
        reals: ['nvidia/foo:bar'],
        chosenProvider: '',
    });
    assert.equal(out, 'nvidia/foo:bar');
});
