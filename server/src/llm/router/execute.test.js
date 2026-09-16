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

test('applyChosenModel uses canonical model only when provider is empty', () => {
    const out = applyChosenModel(
        { model: 'x' },
        { chosenProvider: '', chosenModel: 'deepseek-chat' },
    );
    assert.equal(out.model, 'deepseek-chat');
});
