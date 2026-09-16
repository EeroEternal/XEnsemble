function toUnitPrice(globalPricing) {
    const gp = globalPricing || {};
    return {
        inputPer1m: gp.prompt ?? null,
        outputPer1m: gp.completion ?? null,
        cacheReadPer1m: gp.cache_read ?? null,
        cacheWritePer1m: gp.cache_write ?? null,
    };
}

function isPriced(unit) {
    if (!unit) return false;
    return unit.inputPer1m != null
        || unit.outputPer1m != null
        || unit.cacheReadPer1m != null
        || unit.cacheWritePer1m != null;
}

function calculateCost(unit, {
    promptTokens = 0,
    completionTokens = 0,
    cacheHitTokens = 0,
    cacheZero = false,
} = {}) {
    if (!isPriced(unit)) return null;

    const hits = cacheZero ? 0 : cacheHitTokens;
    const miss = promptTokens - hits;

    let cacheRate = 0;
    if (unit.cacheReadPer1m != null) {
        cacheRate = unit.cacheReadPer1m;
    } else if (hits > 0) {
        cacheRate = (unit.inputPer1m ?? 0) * 0.1;
    }

    const inputRate = unit.inputPer1m ?? 0;
    const outputRate = unit.outputPer1m ?? 0;

    return miss * inputRate / 1e6
        + hits * cacheRate / 1e6
        + completionTokens * outputRate / 1e6;
}

module.exports = { toUnitPrice, isPriced, calculateCost };
