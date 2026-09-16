const { findOfferings, canonicalModelId } = require('../modelPortraits');
const { calculateCost, isPriced, toUnitPrice } = require('./pricing');

function rankGroup(candidate) {
    if (candidate.bound && candidate.priced) return 0;
    if (candidate.bound) return 1;
    return 2;
}

function resolveProviderRoute({
    portraits,
    logicalModel,
    boundProviderIds,
    cacheHitTokens,
    promptTokens,
    completionTokensGuess = 0,
    cacheZero,
    demand,
}) {
    // v1: IGNORE demand even if non-null. Capability gating (filter offerings
    // by evaluator vector before ranking) goes here when evaluateDifficulty
    // returns a real demand instead of null.
    void demand;

    const boundIds = boundProviderIds || [];
    const offerings = findOfferings(portraits, { modelId: logicalModel });
    const candidates = offerings.map((offering) => {
        const unit = toUnitPrice(offering.global_pricing);
        const bound = boundIds.includes(offering.provider_id);
        return {
            provider_id: offering.provider_id,
            canonical_model_id: offering.canonical_model_id || canonicalModelId(offering.model_id),
            model_id: offering.model_id,
            bound,
            priced: isPriced(unit),
            cost_estimate: calculateCost(unit, {
                promptTokens,
                completionTokens: completionTokensGuess,
                cacheHitTokens,
                cacheZero,
            }),
            skip_reason: bound ? null : 'provider_not_bound',
        };
    });

    candidates.sort((a, b) => {
        const ga = rankGroup(a);
        const gb = rankGroup(b);
        if (ga !== gb) return ga - gb;
        if (ga === 0) return a.cost_estimate - b.cost_estimate;
        return 0;
    });
    return candidates;
}

function chooseRoute(candidates, { sticky, reevaluate, logicalModel } = {}) {
    const list = candidates || [];
    if (!reevaluate && sticky) {
        return {
            chosenModel: sticky.chosenModel,
            chosenProvider: sticky.chosenProvider,
            candidates: list,
        };
    }

    const hasPricedBound = list.some((c) => c.bound && c.priced);
    const chosen = list.find((c) => c.bound && (c.priced || !hasPricedBound));
    if (!chosen) {
        return {
            chosenModel: logicalModel || list[0]?.canonical_model_id || '',
            chosenProvider: '',
            candidates: list,
        };
    }
    return {
        chosenModel: chosen.canonical_model_id,
        chosenProvider: chosen.provider_id,
        candidates: list,
    };
}

module.exports = { resolveProviderRoute, chooseRoute };
