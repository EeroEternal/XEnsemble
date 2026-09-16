const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveProviderRoute, chooseRoute } = require('./optimizer');

function makeOffering({
    provider_id,
    canonical_model_id,
    model_id,
    prompt = null,
    completion = null,
    cache_read = null,
    cache_write = null,
}) {
    return {
        provider_id,
        endpoint_id: `${provider_id}:global`,
        model_id: model_id || canonical_model_id,
        canonical_model_id,
        price_currency: 'USD',
        global_pricing: { prompt, completion, cache_read, cache_write, reasoning: null },
    };
}

function resolve(portraits, extra = {}) {
    return resolveProviderRoute({
        portraits,
        logicalModel: 'deepseek-chat',
        boundProviderIds: ['deepseek'],
        cacheHitTokens: 0,
        promptTokens: 1e6,
        completionTokensGuess: 0,
        cacheZero: false,
        demand: null,
        ...extra,
    });
}

test('bound offering wins over cheaper unbound sibling of the same model', () => {
    const portraits = {
        offerings: [
            makeOffering({
                provider_id: 'openrouter',
                canonical_model_id: 'deepseek-chat',
                prompt: 0.01,
                completion: 0.02,
            }),
            makeOffering({
                provider_id: 'deepseek',
                canonical_model_id: 'deepseek-chat',
                prompt: 0.14,
                completion: 0.28,
            }),
        ],
    };
    const candidates = resolve(portraits);
    const chosen = chooseRoute(candidates, {
        sticky: null,
        reevaluate: true,
        logicalModel: 'deepseek-chat',
    });

    assert.equal(chosen.chosenProvider, 'deepseek');
    assert.equal(chosen.chosenModel, 'deepseek-chat');
    const unbound = chosen.candidates.find((c) => c.provider_id === 'openrouter');
    assert.ok(unbound);
    assert.equal(unbound.bound, false);
    assert.equal(unbound.skip_reason, 'provider_not_bound');
    const bound = chosen.candidates.find((c) => c.provider_id === 'deepseek');
    assert.equal(bound.bound, true);
    assert.equal(bound.skip_reason, null);
});

test('unknown price must not rank before a priced bound offering', () => {
    const portraits = {
        offerings: [
            makeOffering({
                provider_id: 'mystery',
                canonical_model_id: 'deepseek-chat',
            }),
            makeOffering({
                provider_id: 'deepseek',
                canonical_model_id: 'deepseek-chat',
                prompt: 1,
                completion: 2,
            }),
        ],
    };
    const candidates = resolve(portraits, {
        boundProviderIds: ['mystery', 'deepseek'],
    });

    assert.equal(candidates[0].provider_id, 'deepseek');
    assert.ok(candidates[0].cost_estimate != null);
    assert.equal(candidates[1].provider_id, 'mystery');
    assert.equal(candidates[1].cost_estimate, null);

    const chosen = chooseRoute(candidates, {
        sticky: null,
        reevaluate: true,
        logicalModel: 'deepseek-chat',
    });
    assert.equal(chosen.chosenProvider, 'deepseek');
});

test('demand=null does not switch to a different canonical_model_id in offerings', () => {
    const portraits = {
        offerings: [
            makeOffering({
                provider_id: 'moonshot',
                canonical_model_id: 'kimi-k2.5',
                prompt: 0.001,
                completion: 0.001,
            }),
            makeOffering({
                provider_id: 'deepseek',
                canonical_model_id: 'deepseek-chat',
                prompt: 0.14,
                completion: 0.28,
            }),
        ],
    };
    const candidates = resolve(portraits, {
        logicalModel: 'deepseek-chat',
        boundProviderIds: ['moonshot', 'deepseek'],
        demand: null,
    });

    assert.ok(candidates.every((c) => c.canonical_model_id === 'deepseek-chat'));
    const chosen = chooseRoute(candidates, {
        sticky: null,
        reevaluate: true,
        logicalModel: 'deepseek-chat',
    });
    assert.equal(chosen.chosenModel, 'deepseek-chat');
    assert.equal(chosen.chosenProvider, 'deepseek');
});

test('reevaluate=false reuses sticky provider even if it is not cheapest', () => {
    const portraits = {
        offerings: [
            makeOffering({
                provider_id: 'cheap',
                canonical_model_id: 'deepseek-chat',
                prompt: 0.01,
                completion: 0.02,
            }),
            makeOffering({
                provider_id: 'sticky-co',
                canonical_model_id: 'deepseek-chat',
                prompt: 1,
                completion: 2,
            }),
        ],
    };
    const candidates = resolve(portraits, {
        boundProviderIds: ['cheap', 'sticky-co'],
    });
    assert.equal(candidates[0].provider_id, 'cheap');

    const chosen = chooseRoute(candidates, {
        sticky: { chosenModel: 'deepseek-chat', chosenProvider: 'sticky-co', failCount: 0 },
        reevaluate: false,
        logicalModel: 'deepseek-chat',
    });
    assert.equal(chosen.chosenProvider, 'sticky-co');
    assert.equal(chosen.chosenModel, 'deepseek-chat');
});
