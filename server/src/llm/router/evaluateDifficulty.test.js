const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateDifficulty } = require('./evaluateDifficulty');

test('evaluateDifficulty returns null for empty signals', async () => {
    assert.equal(await evaluateDifficulty({}), null);
});
