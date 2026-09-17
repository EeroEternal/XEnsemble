const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveProviderRoute, chooseRoute } = require('./optimizer');

function makeEntry({
    provider,
    canonical_model_id,
    model,
    input = null,
    output = null,
    cache_read = null,
    cache_write = null,
    capability = 0.7,
    family,
}) {
    const modelId = model || canonical_model_id;
    return {
        provider,
        model: modelId,
        canonical_model_id: canonical_model_id || modelId,
        family,
        capability,
        price: { input, output, cache_read, cache_write },
    };
}

function resolve(catalog, extra = {}) {
    return resolveProviderRoute({
        catalog,
        logicalModel: 'deepseek-chat',
        boundProviderIds: ['deepseek'],
        demand: null,
        ...extra,
    });
}

test('bound catalog entry wins over cheaper unbound sibling of the same model', () => {
    const catalog = {
        entries: [
            makeEntry({
                provider: 'openrouter',
                canonical_model_id: 'deepseek-chat',
                input: 0.01,
                output: 0.02,
            }),
            makeEntry({
                provider: 'deepseek',
                canonical_model_id: 'deepseek-chat',
                input: 0.14,
                output: 0.28,
            }),
        ],
    };
    const candidates = resolve(catalog);
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
    const catalog = {
        entries: [
            makeEntry({
                provider: 'mystery',
                canonical_model_id: 'deepseek-chat',
            }),
            makeEntry({
                provider: 'deepseek',
                canonical_model_id: 'deepseek-chat',
                input: 1,
                output: 2,
            }),
        ],
    };
    const candidates = resolve(catalog, {
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

test('without allowedModels, demand=null does not scan other models in the catalog', () => {
    const catalog = {
        entries: [
            makeEntry({
                provider: 'moonshot',
                canonical_model_id: 'kimi-k2.5',
                input: 0.001,
                output: 0.001,
            }),
            makeEntry({
                provider: 'deepseek',
                canonical_model_id: 'deepseek-chat',
                input: 0.14,
                output: 0.28,
            }),
        ],
    };
    const candidates = resolve(catalog, {
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

test('allowedModels picks the cheapest priced model even when demand is null', () => {
    const catalog = {
        entries: [
            makeEntry({
                provider: 'personal_glm',
                canonical_model_id: 'glm-5.3-flash',
                input: 0.15,
                output: 0.5,
                cache_read: 0.03,
                capability: 0.92,
            }),
            makeEntry({
                provider: 'personal_glm',
                canonical_model_id: 'glm-5.2',
                input: 1.4,
                output: 4.4,
                cache_read: 0.26,
                capability: 0.84,
            }),
            makeEntry({
                provider: 'personal_glm',
                canonical_model_id: 'glm-5.1',
                input: 1.4,
                output: 4.4,
                cache_read: 0.26,
                capability: 0.8,
            }),
        ],
    };
    const candidates = resolve(catalog, {
        logicalModel: 'glm-5.3-flash',
        allowedModels: ['glm-5.3-flash', 'glm-5.2', 'glm-5.1'],
        gatewayProvider: 'personal_glm',
        boundProviderIds: ['personal_glm'],
        demand: null,
    });
    const chosen = chooseRoute(candidates, {
        sticky: null,
        reevaluate: true,
        logicalModel: 'glm-5.3-flash',
        gatewayProvider: 'personal_glm',
    });

    assert.equal(chosen.chosenModel, 'glm-5.3-flash');
    assert.equal(chosen.chosenProvider, 'personal_glm');
    assert.equal(chosen.candidates.find((c) => c.canonical_model_id === 'glm-5.3-flash').capability, 0.92);
    const glm51 = chosen.candidates.find((c) => c.canonical_model_id === 'glm-5.1');
    assert.ok(glm51.priced);
    assert.equal(glm51.bound, true);
});

test('unpriced allowed models rank after priced siblings', () => {
    const catalog = {
        entries: [
            makeEntry({
                provider: 'personal_glm',
                canonical_model_id: 'glm-5.1',
                input: 1.4,
                output: 4.4,
            }),
        ],
    };
    const candidates = resolve(catalog, {
        logicalModel: 'mystery-flash',
        allowedModels: ['mystery-flash', 'glm-5.1'],
        gatewayProvider: 'personal_glm',
    });
    assert.equal(candidates[0].canonical_model_id, 'glm-5.1');
    assert.equal(candidates[1].canonical_model_id, 'mystery-flash');
    assert.equal(candidates[1].priced, false);
});

test('gateway provider reuses the same model price from another catalog vendor', () => {
    const catalog = {
        entries: [
            makeEntry({
                provider: 'personal_deepseek',
                canonical_model_id: 'deepseek-v4-flash',
                family: 'deepseek-v4-flash',
                input: 0.15,
                output: 0.6,
                cache_read: 0.003,
                capability: 0.9,
            }),
        ],
    };
    const candidates = resolve(catalog, {
        logicalModel: 'deepseek-chat',
        allowedModels: ['deepseek-chat'],
        gatewayProvider: 'deepseek',
        boundProviderIds: ['deepseek'],
    });
    assert.equal(candidates[0].provider_id, 'deepseek');
    assert.equal(candidates[0].canonical_model_id, 'deepseek-chat');
    assert.equal(candidates[0].priced, true);
    assert.equal(candidates[0].cost_estimate.input, 0.15);
    assert.equal(candidates[0].capability, 0.9);
});

test('hard difficulty picks the cheapest capability-qualified model', () => {
    const catalog = {
        entries: [
            makeEntry({
                provider: 'personal_glm',
                canonical_model_id: 'glm-5.3-flash',
                input: 0.15,
                output: 0.5,
                capability: 0.50,
            }),
            makeEntry({
                provider: 'personal_glm',
                canonical_model_id: 'glm-5.3',
                input: 1.4,
                output: 4.4,
                capability: 0.95,
            }),
        ],
    };
    const candidates = resolve(catalog, {
        logicalModel: 'glm-5.3-flash',
        allowedModels: ['glm-5.3-flash', 'glm-5.3'],
        gatewayProvider: 'personal_glm',
        boundProviderIds: ['personal_glm'],
        demand: { difficulty: 0.70 },
    });
    const chosen = chooseRoute(candidates, {
        sticky: null,
        reevaluate: true,
        logicalModel: 'glm-5.3-flash',
        gatewayProvider: 'personal_glm',
    });
    assert.equal(chosen.chosenModel, 'glm-5.3');
    const flash = chosen.candidates.find((c) => c.canonical_model_id === 'glm-5.3-flash');
    assert.equal(flash.qualified, false);
    assert.equal(flash.skip_reason, 'below_capability');
    const strong = chosen.candidates.find((c) => c.canonical_model_id === 'glm-5.3');
    assert.equal(strong.qualified, true);
});

test('easy difficulty still picks the cheapest model that meets required capability', () => {
    const catalog = {
        entries: [
            makeEntry({
                provider: 'personal_glm',
                canonical_model_id: 'glm-5.3-flash',
                input: 0.15,
                output: 0.5,
                capability: 0.50,
            }),
            makeEntry({
                provider: 'personal_glm',
                canonical_model_id: 'glm-5.3',
                input: 1.4,
                output: 4.4,
                capability: 0.95,
            }),
        ],
    };
    const candidates = resolve(catalog, {
        logicalModel: 'glm-5.3-flash',
        allowedModels: ['glm-5.3-flash', 'glm-5.3'],
        gatewayProvider: 'personal_glm',
        boundProviderIds: ['personal_glm'],
        demand: { difficulty: 0.15 },
    });
    const chosen = chooseRoute(candidates, {
        sticky: null,
        reevaluate: true,
        logicalModel: 'glm-5.3-flash',
        gatewayProvider: 'personal_glm',
    });
    assert.equal(chosen.chosenModel, 'glm-5.3-flash');
    assert.equal(chosen.candidates.find((c) => c.canonical_model_id === 'glm-5.3-flash').qualified, true);
});

test('if nobody qualifies, fall back to the user-selected model, not the cheapest', () => {
    const catalog = {
        entries: [
            makeEntry({
                provider: 'personal_glm',
                canonical_model_id: 'glm-5.3-flash',
                input: 0.15,
                output: 0.5,
                capability: 0.40,
            }),
            makeEntry({
                provider: 'personal_glm',
                canonical_model_id: 'glm-5.3',
                input: 1.4,
                output: 4.4,
                capability: 0.45,
            }),
        ],
    };
    const candidates = resolve(catalog, {
        logicalModel: 'glm-5.3',
        allowedModels: ['glm-5.3-flash', 'glm-5.3'],
        gatewayProvider: 'personal_glm',
        boundProviderIds: ['personal_glm'],
        demand: { difficulty: 0.50 },
    });
    const chosen = chooseRoute(candidates, {
        sticky: null,
        reevaluate: true,
        logicalModel: 'glm-5.3',
        gatewayProvider: 'personal_glm',
    });
    assert.equal(chosen.chosenModel, 'glm-5.3');
    assert.equal(chosen.chosenProvider, 'personal_glm');
    assert.equal(candidates.every((c) => c.qualified === false), true);
});

test('reevaluate=false reuses sticky provider even if it is not cheapest', () => {
    const catalog = {
        entries: [
            makeEntry({
                provider: 'cheap',
                canonical_model_id: 'deepseek-chat',
                input: 0.01,
                output: 0.02,
            }),
            makeEntry({
                provider: 'sticky-co',
                canonical_model_id: 'deepseek-chat',
                input: 1,
                output: 2,
            }),
        ],
    };
    const candidates = resolve(catalog, {
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

test('catalog prices are compared as USD without a currency conversion step', () => {
    const catalog = {
        entries: [
            makeEntry({
                provider: 'yuan',
                canonical_model_id: 'deepseek-chat',
                input: 1,
                output: 0,
            }),
            makeEntry({
                provider: 'dollar',
                canonical_model_id: 'deepseek-chat',
                input: 0.5,
                output: 0,
            }),
        ],
    };
    const candidates = resolve(catalog, {
        boundProviderIds: ['yuan', 'dollar'],
    });
    assert.equal(candidates[0].provider_id, 'dollar');

    const chosen = chooseRoute(candidates, {
        sticky: null,
        reevaluate: true,
        logicalModel: 'deepseek-chat',
    });
    assert.equal(chosen.chosenProvider, 'dollar');
});

test('bound ranking prefers cheaper cache_read over cheaper input', () => {
    const catalog = {
        entries: [
            makeEntry({
                provider: 'input-cheap',
                canonical_model_id: 'deepseek-chat',
                input: 0.01,
                output: 0.01,
                cache_read: 0.5,
            }),
            makeEntry({
                provider: 'cache-cheap',
                canonical_model_id: 'deepseek-chat',
                input: 9,
                output: 9,
                cache_read: 0.02,
            }),
        ],
    };
    const candidates = resolve(catalog, {
        boundProviderIds: ['input-cheap', 'cache-cheap'],
    });
    assert.equal(candidates[0].provider_id, 'cache-cheap');
    const chosen = chooseRoute(candidates, {
        sticky: null,
        reevaluate: true,
        logicalModel: 'deepseek-chat',
    });
    assert.equal(chosen.chosenProvider, 'cache-cheap');
});

test('unit-price ranking does not depend on last-turn token counts', () => {
    const catalog = {
        entries: [
            makeEntry({
                provider: 'low-input',
                canonical_model_id: 'deepseek-chat',
                input: 0.1,
                output: 5,
            }),
            makeEntry({
                provider: 'high-input',
                canonical_model_id: 'deepseek-chat',
                input: 1,
                output: 0.01,
            }),
        ],
    };
    const a = resolve(catalog, {
        boundProviderIds: ['low-input', 'high-input'],
        promptTokens: 0,
        cacheHitTokens: 0,
    });
    const b = resolve(catalog, {
        boundProviderIds: ['low-input', 'high-input'],
        promptTokens: 1e9,
        cacheHitTokens: 9e8,
        cacheZero: true,
    });
    assert.equal(a[0].provider_id, 'low-input');
    assert.equal(b[0].provider_id, 'low-input');
});
