const { collectSignals } = require('./signals');
const { evaluateDifficulty } = require('./evaluateDifficulty');
const { resolveTrigger } = require('./triggers');
const { resolveProviderRoute, chooseRoute } = require('./optimizer');

function resolveGetSticky(deps) {
    if (deps.getSticky) return deps.getSticky;
    return require('./sticky').getSticky;
}

async function planRoute({ claims, body, lastUsage, boundProviderIds, portraits }, deps = {}) {
    const getSticky = resolveGetSticky(deps);

    const signals = collectSignals({
        sessionId: claims.sid,
        body,
        tokenModel: claims.model,
        agentPrimaryModel: claims.agentPrimaryModel || '',
        lastUsage,
    });
    const demand = await evaluateDifficulty(signals);
    const sticky = await getSticky(claims.sid);
    const trig = resolveTrigger({
        sticky,
        compacted: signals.compacted,
        stickyReleasedByFailures: !!(sticky && sticky.failCount >= 2),
    });
    // v1 always uses body-derived signals.logicalModel. If demand is later
    // used for capability gating, still do NOT fall back to claims.model.
    const logicalModel = demand == null ? signals.logicalModel : signals.logicalModel;
    const candidates = resolveProviderRoute({
        portraits,
        logicalModel,
        boundProviderIds: boundProviderIds || [],
        cacheHitTokens: signals.lastCachedTokens || 0,
        promptTokens: signals.lastPromptTokens || 0,
        completionTokensGuess: 0,
        cacheZero: trig.trigger === 'compaction',
        demand,
    });
    const chosen = chooseRoute(candidates, {
        sticky,
        reevaluate: trig.reevaluate,
        logicalModel,
    });
    return { signals, demand, trig, chosen, candidates, sticky };
}

module.exports = { planRoute };
