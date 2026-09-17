const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyChosenModel } = require('./execute');

test('applyChosenModel prefixes nonempty provider onto canonical model', () => {
    const out = applyChosenModel(
        { model: 'x' },
        { chosenProvider: 'deepseek', chosenModel: 'deepseek-chat' },
    );
    assert.equal(out.model, 'deepseek/deepseek-chat');
});

test('applyChosenModel keeps the original body model when provider is empty', () => {
    const out = applyChosenModel(
        { model: 'openrouter/google/gemini-2.0-flash' },
        { chosenProvider: '', chosenModel: 'gemini-2.0-flash' },
    );
    assert.equal(out.model, 'openrouter/google/gemini-2.0-flash');
});
