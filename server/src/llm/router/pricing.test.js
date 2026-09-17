const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toUnitPrice, isPriced, calculateCost, toUsdUnitPrice, compareUsdUnitPrice, compareUsdUnitPriceForModelPick } = require('./pricing');

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

test('USD cost is unchanged', () => {
    const u = toUnitPrice({ prompt: 1, completion: 0, cache_read: null, cache_write: null, reasoning: null });
    const cost = calculateCost(u, { promptTokens: 1e6, completionTokens: 0, cacheHitTokens: 0, currency: 'USD' });
    assert.equal(cost, 1);
});

test('CNY cost converts at 2026-09-16 PBOC USD/CNY midpoint 6.7628', () => {
    const u = toUnitPrice({ prompt: 6.7628, completion: 0, cache_read: null, cache_write: null, reasoning: null });
    const cost = calculateCost(u, { promptTokens: 1e6, completionTokens: 0, cacheHitTokens: 0, currency: 'CNY' });
    assert.ok(Math.abs(cost - 1) < 1e-9);
});

test('unknown currency is unpriced even with native rates', () => {
    const u = toUnitPrice({ prompt: 1, completion: 2, cache_read: null, cache_write: null, reasoning: null });
    assert.equal(isPriced(u), true);
    const cost = calculateCost(u, { promptTokens: 1e6, currency: 'EUR' });
    assert.equal(cost, null);
    assert.equal(toUsdUnitPrice({ prompt: 1 }, 'EUR'), null);
});

test('toUsdUnitPrice converts CNY units at PBOC midpoint and leaves USD unchanged', () => {
    const usd = toUsdUnitPrice({ prompt: 0.5, completion: 1, cache_read: 0.05, cache_write: 0.2 }, 'USD');
    assert.deepEqual(usd, {
        currency: 'USD',
        cache_read: 0.05,
        cache_write: 0.2,
        input: 0.5,
        output: 1,
    });
    const cny = toUsdUnitPrice({ prompt: 6.7628, completion: 0, cache_read: null, cache_write: null }, 'CNY');
    assert.equal(cny.currency, 'USD');
    assert.ok(Math.abs(cny.input - 1) < 1e-9);
    assert.equal(cny.cache_read, null);
});

test('compareUsdUnitPrice is lexicographic: cache_read, cache_write, input, output', () => {
    const cheapCache = toUsdUnitPrice({ prompt: 9, completion: 9, cache_read: 0.01, cache_write: 9 }, 'USD');
    const cheapInput = toUsdUnitPrice({ prompt: 0.01, completion: 0.01, cache_read: 0.5, cache_write: 0.01 }, 'USD');
    assert.ok(compareUsdUnitPrice(cheapCache, cheapInput) < 0);

    const cheapWrite = toUsdUnitPrice({ prompt: 9, completion: 9, cache_read: 0.1, cache_write: 0.01 }, 'USD');
    const cheapIn = toUsdUnitPrice({ prompt: 0.01, completion: 0.01, cache_read: 0.1, cache_write: 0.5 }, 'USD');
    assert.ok(compareUsdUnitPrice(cheapWrite, cheapIn) < 0);

    const cheapPrompt = toUsdUnitPrice({ prompt: 0.1, completion: 9, cache_read: null, cache_write: null }, 'USD');
    const cheapOut = toUsdUnitPrice({ prompt: 1, completion: 0.01, cache_read: null, cache_write: null }, 'USD');
    assert.ok(compareUsdUnitPrice(cheapPrompt, cheapOut) < 0);

    const a = toUsdUnitPrice({ prompt: 1, completion: 0.1, cache_read: null, cache_write: null }, 'USD');
    const b = toUsdUnitPrice({ prompt: 1, completion: 0.5, cache_read: null, cache_write: null }, 'USD');
    assert.ok(compareUsdUnitPrice(a, b) < 0);
});

test('model pick ranks cheaper input ahead of cheaper cache_read', () => {
    const cheapCache = toUsdUnitPrice({ prompt: 9, completion: 9, cache_read: 0.01, cache_write: 9 }, 'USD');
    const cheapInput = toUsdUnitPrice({ prompt: 0.01, completion: 0.01, cache_read: 0.5, cache_write: 0.01 }, 'USD');
    assert.ok(compareUsdUnitPrice(cheapCache, cheapInput) < 0);
    assert.ok(compareUsdUnitPriceForModelPick(cheapInput, cheapCache) < 0);
});

test('null unit-price axis loses to a finite price on the same axis', () => {
    const pricedCache = toUsdUnitPrice({ prompt: 9, completion: 9, cache_read: 1, cache_write: null }, 'USD');
    const missingCache = toUsdUnitPrice({ prompt: 0.01, completion: 0.01, cache_read: null, cache_write: null }, 'USD');
    assert.ok(compareUsdUnitPrice(pricedCache, missingCache) < 0);
});
