const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalModelId } = require('../modelPortraits');
const { planRoute } = require('./index');

function makeEntry({
    provider,
    canonical_model_id,
    model,
    input = null,
    output = null,
    capability = 0.7,
}) {
    const modelId = model || canonical_model_id;
    return {
        provider,
        model: modelId,
        canonical_model_id: canonical_model_id || modelId,
        capability,
        price: { input, output, cache_read: null, cache_write: null },
    };
}

test('without allowedModels, chosenModel is body canonical, not claims.model', async () => {
    const body = {
        model: 'anthropic.acme/deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
    };
    const claims = {
        sid: 'sess-plan-route-1',
        model: 'claude-sonnet-4',
        agentPrimaryModel: 'other-primary',
    };
    const catalog = {
        entries: [
            makeEntry({
                provider: 'deepseek',
                canonical_model_id: 'deepseek-chat',
                input: 0.14,
                output: 0.28,
            }),
            makeEntry({
                provider: 'openrouter',
                canonical_model_id: 'deepseek-chat',
                input: 0.01,
                output: 0.02,
            }),
        ],
    };

    const result = await planRoute(
        {
            claims,
            body,
            lastUsage: null,
            boundProviderIds: ['deepseek'],
            catalog,
        },
        { getSticky: async () => null },
    );

    assert.equal(typeof result.demand.difficulty, 'number');
    assert.ok(result.demand.difficulty >= 0 && result.demand.difficulty <= 1);
    assert.equal(result.chosen.chosenModel, canonicalModelId(body.model));
    assert.equal(result.chosen.chosenModel, 'deepseek-chat');
    assert.notEqual(result.chosen.chosenModel, claims.model);
    assert.notEqual(result.chosen.chosenModel, canonicalModelId(claims.model));
});

test('allowedModels: cheapest priced model wins over the body model', async () => {
    const body = {
        model: 'anthropic.personal_glm/glm-5.3',
        messages: [{ role: 'user', content: 'hi' }],
    };
    const catalog = {
        entries: [
            makeEntry({
                provider: 'personal_glm',
                canonical_model_id: 'glm-5.3-flash',
                input: 0.15,
                output: 0.5,
                capability: 0.92,
            }),
            makeEntry({
                provider: 'personal_glm',
                canonical_model_id: 'glm-5.2',
                input: 1.4,
                output: 4.4,
                capability: 0.84,
            }),
            makeEntry({
                provider: 'personal_glm',
                canonical_model_id: 'glm-5.1',
                input: 1.4,
                output: 4.4,
                capability: 0.8,
            }),
        ],
    };

    const result = await planRoute(
        {
            claims: { sid: 'sess-cheapest', model: 'claude-sonnet-4' },
            body,
            lastUsage: null,
            boundProviderIds: ['personal_glm'],
            catalog,
            allowedModels: ['glm-5.3-flash', 'glm-5.2', 'glm-5.1'],
            gatewayProvider: 'personal_glm',
        },
        { getSticky: async () => null },
    );

    assert.equal(typeof result.demand.difficulty, 'number');
    assert.ok(result.demand.difficulty < 0.55);
    assert.equal(result.chosen.chosenModel, 'glm-5.3-flash');
    assert.equal(result.chosen.chosenProvider, 'personal_glm');
    assert.notEqual(result.chosen.chosenModel, canonicalModelId(body.model));
});

test('hard prompt skips cheaper low-capability models for the cheapest qualified', async () => {
    const body = {
        model: 'anthropic.personal_glm/glm-5.3-flash',
        messages: [{ role: 'user', content: 'Please explain step by step and prove the theorem' }],
    };
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

    const result = await planRoute(
        {
            claims: { sid: 'sess-hard', model: 'claude-sonnet-4' },
            body,
            lastUsage: null,
            boundProviderIds: ['personal_glm'],
            catalog,
            allowedModels: ['glm-5.3-flash', 'glm-5.3'],
            gatewayProvider: 'personal_glm',
        },
        { getSticky: async () => null },
    );

    assert.ok(result.demand.difficulty >= 0.55);
    assert.equal(result.chosen.chosenModel, 'glm-5.3');
    const flash = result.candidates.find((c) => c.canonical_model_id === 'glm-5.3-flash');
    assert.equal(flash.qualified, false);
    assert.equal(flash.skip_reason, 'below_capability');
});

test('failCount >= 2 sticky tombstone yields provider_fail and reevaluates', async () => {
    const body = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
    };
    const result = await planRoute(
        {
            claims: { sid: 'sess-tombstone', model: 'other' },
            body,
            lastUsage: null,
            boundProviderIds: ['deepseek'],
            catalog: {
                entries: [
                    makeEntry({
                        provider: 'deepseek',
                        canonical_model_id: 'deepseek-chat',
                        input: 1,
                        output: 1,
                    }),
                ],
            },
        },
        {
            getSticky: async () => ({
                chosenModel: 'deepseek-chat',
                chosenProvider: 'deepseek',
                failCount: 2,
                expiresAt: Date.now() + 60_000,
            }),
        },
    );
    assert.equal(result.trig.trigger, 'provider_fail');
    assert.equal(result.trig.reevaluate, true);
});
