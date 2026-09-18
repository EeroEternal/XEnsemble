const { canonicalModelId } = require('../modelPortraits');
const { lookupCatalog, findCatalogEntries, usdEstimateFromEntry } = require('../modelCatalog');
const { compareUsdUnitPrice, compareUsdUnitPriceForModelPick } = require('./pricing');
const { capabilityQualified, requiredCapability } = require('./evaluateDifficulty');

function rankGroup(candidate) {
    if (candidate.bound && candidate.priced && candidate.qualified !== false) return 0;
    if (candidate.bound && candidate.priced) return 1;
    if (candidate.bound) return 2;
    return 3;
}

function difficultyOf(demand) {
    if (demand == null) return null;
    if (typeof demand === 'number') return demand;
    if (typeof demand.difficulty === 'number') return demand.difficulty;
    return null;
}

function applyCapabilityGate(candidates, demand) {
    const difficulty = difficultyOf(demand);
    if (difficulty == null) return candidates;
    const anyCap = candidates.some((c) => c.capability != null && Number.isFinite(Number(c.capability)));
    const required = requiredCapability(difficulty);
    return candidates.map((c) => {
        let qualified = true;
        if (anyCap) {
            qualified = c.capability == null
                ? false
                : capabilityQualified(c.capability, difficulty);
        }
        return {
            ...c,
            qualified,
            required_capability: required,
            skip_reason: c.skip_reason || (c.bound && !qualified ? 'below_capability' : null),
        };
    });
}

function uniqueModelIds(allowedModels, logicalModel) {
    const seen = new Set();
    const ids = [];
    const add = (raw) => {
        const id = canonicalModelId(raw);
        if (!id || seen.has(id)) return;
        seen.add(id);
        ids.push(id);
    };
    for (const m of allowedModels || []) add(m);
    if (ids.length === 0) add(logicalModel);
    return ids;
}

function candidateFromEntry(entry, boundIds, { providerOverride, modelId } = {}) {
    const cost_estimate = usdEstimateFromEntry(entry);
    const provider_id = providerOverride || entry.provider;
    const bound = boundIds.includes(provider_id);
    return {
        provider_id,
        canonical_model_id: modelId || entry.canonical_model_id || canonicalModelId(entry.model),
        model_id: entry.model,
        bound,
        priced: cost_estimate != null,
        cost_estimate,
        capability: entry.capability ?? null,
        skip_reason: bound ? null : 'provider_not_bound',
    };
}

function unpricedBound(providerId, modelId) {
    return {
        provider_id: providerId,
        canonical_model_id: modelId,
        model_id: modelId,
        bound: true,
        priced: false,
        cost_estimate: null,
        capability: null,
        skip_reason: null,
    };
}

function resolveProviderRoute({
    catalog,
    logicalModel,
    boundProviderIds,
    demand,
    allowedModels,
    gatewayProvider,
}) {
    const boundIds = boundProviderIds || [];
    const modelIds = uniqueModelIds(allowedModels, logicalModel);
    const gw = String(gatewayProvider || '').trim();

    let candidates;
    if (gw) {
        candidates = modelIds.map((modelId) => {
            const entry = lookupCatalog(catalog, { provider: gw, model: modelId });
            if (!entry) return unpricedBound(gw, modelId);
            return candidateFromEntry(entry, [gw], { providerOverride: gw, modelId });
        });
    } else {
        candidates = [];
        for (const modelId of modelIds) {
            const entries = findCatalogEntries(catalog, { model: modelId });
            for (const entry of entries) {
                candidates.push(candidateFromEntry(entry, boundIds, { modelId }));
            }
        }
    }

    candidates = applyCapabilityGate(candidates, demand);

    const multiModel = new Set(candidates.map((c) => c.canonical_model_id)).size > 1;
    const cmpPrice = multiModel ? compareUsdUnitPriceForModelPick : compareUsdUnitPrice;

    candidates.sort((a, b) => {
        const ga = rankGroup(a);
        const gb = rankGroup(b);
        if (ga !== gb) return ga - gb;
        if (a.priced && b.priced) {
            const d = cmpPrice(a.cost_estimate, b.cost_estimate);
            if (d) return d;
        }
        if (logicalModel) {
            if (a.canonical_model_id === logicalModel && b.canonical_model_id !== logicalModel) return -1;
            if (b.canonical_model_id === logicalModel && a.canonical_model_id !== logicalModel) return 1;
        }
        return 0;
    });
    return candidates;
}

function chooseRoute(candidates, { sticky, reevaluate, logicalModel, gatewayProvider } = {}) {
    const list = candidates || [];
    if (!reevaluate && sticky) {
        return {
            chosenModel: sticky.chosenModel,
            chosenProvider: sticky.chosenProvider,
            candidates: list,
        };
    }

    const hasQualifiedPriced = list.some((c) => c.bound && c.priced && c.qualified !== false);
    let chosen;
    if (hasQualifiedPriced) {
        chosen = list.find((c) => c.bound && c.priced && c.qualified !== false);
    } else {
        const wanted = canonicalModelId(logicalModel);
        if (wanted) {
            chosen = list.find((c) => c.bound && c.canonical_model_id === wanted)
                || list.find((c) => c.canonical_model_id === wanted);
            if (!chosen) {
                return {
                    chosenModel: wanted,
                    chosenProvider: String(gatewayProvider || '').trim(),
                    candidates: list,
                };
            }
        } else {
            const hasPricedBound = list.some((c) => c.bound && c.priced);
            chosen = list.find((c) => c.bound && (c.priced || !hasPricedBound));
        }
    }
    if (!chosen) {
        return {
            chosenModel: canonicalModelId(logicalModel) || list[0]?.canonical_model_id || '',
            chosenProvider: String(gatewayProvider || '').trim(),
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
