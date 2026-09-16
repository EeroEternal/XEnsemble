const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalModelId } = require('../modelPortraits');
const { planRoute } = require('./index');

function makeOffering({
    provider_id,
    canonical_model_id,
    model_id,
    prompt = null,
    completion = null,
}) {
    return {
        provider_id,
        endpoint_id: `${provider_id}:global`,
        model_id: model_id || canonical_model_id,
        canonical_model_id,
        price_currency: 'USD',
        global_pricing: { prompt, completion, cache_read: null, cache_write: null, reasoning: null },
    };
}

test('demand null: chosenModel is body canonical, not claims.model', async () => {
    const body = {
        model: 'anthropic.acme/deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
    };
    const claims = {
        sid: 'sess-plan-route-1',
        model: 'claude-sonnet-4',
        agentPrimaryModel: 'other-primary',
    };
    const portraits = {
        offerings: [
            makeOffering({
                provider_id: 'deepseek',
                canonical_model_id: 'deepseek-chat',
                prompt: 0.14,
                completion: 0.28,
            }),
            makeOffering({
                provider_id: 'openrouter',
                canonical_model_id: 'deepseek-chat',
                prompt: 0.01,
                completion: 0.02,
            }),
        ],
    };

    const result = await planRoute(
        {
            claims,
            body,
            lastUsage: null,
            boundProviderIds: ['deepseek'],
            portraits,
        },
        { getSticky: async () => null },
    );

    assert.equal(result.demand, null);
    assert.equal(result.chosen.chosenModel, canonicalModelId(body.model));
    assert.equal(result.chosen.chosenModel, 'deepseek-chat');
    assert.notEqual(result.chosen.chosenModel, claims.model);
    assert.notEqual(result.chosen.chosenModel, canonicalModelId(claims.model));
});
