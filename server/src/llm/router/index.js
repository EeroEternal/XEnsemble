const { collectSignals } = require('./signals');
const { evaluateDifficulty } = require('./evaluateDifficulty');
const { resolveTrigger } = require('./triggers');
const { resolveProviderRoute, chooseRoute } = require('./optimizer');

function resolveGetSticky(deps) {
    if (deps.getSticky) return deps.getSticky;
    return require('./sticky').getSticky;
}

async function planRoute({
    claims,
    body,
    lastUsage,
    boundProviderIds,
    catalog,
    agentPrimaryModel,
    allowedModels,
    gatewayProvider,
}, deps = {}) {
    const getSticky = resolveGetSticky(deps);

    const signals = collectSignals({
        sessionId: claims.sid,
        body,
        tokenModel: claims.model,
        agentPrimaryModel: agentPrimaryModel || claims.agentPrimaryModel || '',
        lastUsage,
    });
    const demand = await evaluateDifficulty({ body, signals });
    // 粘性按对话线隔离：同一 session 下的并行子任务各自独立粘性
    const sticky = await getSticky(claims.sid, signals.lineKey);
    const trig = resolveTrigger({
        sticky,
        compacted: signals.compacted,
        stickyReleasedByFailures: !!(sticky && sticky.failCount >= 2),
    });
    // Static difficulty D gates the allowed set; optimizer then picks the
    // cheapest qualified model. Body model is only the fallback when the
    // Agent has no selectable list, and never claims.model.
    const logicalModel = signals.logicalModel;
    const candidates = resolveProviderRoute({
        catalog,
        logicalModel,
        boundProviderIds: boundProviderIds || [],
        demand,
        allowedModels,
        gatewayProvider,
    });
    const chosen = chooseRoute(candidates, {
        sticky,
        reevaluate: trig.reevaluate,
        logicalModel,
        gatewayProvider,
    });
    return { signals, demand, trig, chosen, candidates, sticky };
}

module.exports = { planRoute };
