const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toUnitPrice, isPriced, calculateCost } = require('./pricing');

test('unpriced is not cheapest', () => {
    const u = toUnitPrice({ prompt: null, completion: null, cache_read: null, cache_write: null, reasoning: null });
    assert.equal(isPriced(u), false);
    assert.equal(calculateCost(u, { promptTokens: 1000, completionTokens: 10, cacheHitTokens: 0 }), null);
});

test('explicit zero is priced and free', () => {
    const u = toUnitPrice({ prompt: 0, completion: 0, cache_read: null, cache_write: null, reasoning: null });
    assert.equal(isPriced(u), true);
    assert.equal(calculateCost(u, { promptTokens: 1e6, completionTokens: 1e6, cacheHitTokens: 0 }), 0);
});

test('cache hit uses 10% default when cache_read missing', () => {
    const u = toUnitPrice({ prompt: 1, completion: 2, cache_read: null, cache_write: null, reasoning: null });
    const cost = calculateCost(u, { promptTokens: 1e6, completionTokens: 1e5, cacheHitTokens: 5e5 });
    assert.ok(Math.abs(cost - 0.75) < 1e-6);
});

test('compaction zeros cache hits', () => {
    const u = toUnitPrice({ prompt: 1, completion: 0, cache_read: 0.02, cache_write: null, reasoning: null });
    const cost = calculateCost(u, { promptTokens: 1e6, completionTokens: 0, cacheHitTokens: 9e5, cacheZero: true });
    assert.equal(cost, 1);
});
