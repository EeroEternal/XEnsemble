// PBOC USD/CNY midpoint 2026-09-16. Multiply a native-currency amount by USD_PER[code] to get USD.
const USD_CNY_MIDPOINT = 6.7628;
const USD_PER = {
    USD: 1,
    CNY: 1 / USD_CNY_MIDPOINT,
};

function usdPer(currency) {
    const key = String(currency || 'USD').toUpperCase();
    return Object.prototype.hasOwnProperty.call(USD_PER, key) ? USD_PER[key] : null;
}

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

function toUsdUnitPrice(globalPricing, currency) {
    const fx = usdPer(currency);
    if (fx == null) return null;
    const unit = toUnitPrice(globalPricing);
    if (!isPriced(unit)) return null;
    const conv = (v) => (v == null ? null : v * fx);
    return {
        currency: 'USD',
        cache_read: conv(unit.cacheReadPer1m),
        cache_write: conv(unit.cacheWritePer1m),
        input: conv(unit.inputPer1m),
        output: conv(unit.outputPer1m),
    };
}

function axisCmp(a, b) {
    const av = a == null ? Number.POSITIVE_INFINITY : a;
    const bv = b == null ? Number.POSITIVE_INFINITY : b;
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
}

function compareUsdUnitPrice(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return axisCmp(a.cache_read, b.cache_read)
        || axisCmp(a.cache_write, b.cache_write)
        || axisCmp(a.input, b.input)
        || axisCmp(a.output, b.output);
}

/** Cross-model pick: input/output first so a cache_read quote cannot hide a cheaper model. */
function compareUsdUnitPriceForModelPick(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return axisCmp(a.input, b.input)
        || axisCmp(a.output, b.output)
        || axisCmp(a.cache_read, b.cache_read)
        || axisCmp(a.cache_write, b.cache_write);
}

function calculateCost(unit, {
    promptTokens = 0,
    completionTokens = 0,
    cacheHitTokens = 0,
    cacheZero = false,
    currency = 'USD',
} = {}) {
    if (!isPriced(unit)) return null;
    const fx = usdPer(currency);
    if (fx == null) return null;

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

    const native = miss * inputRate / 1e6
        + hits * cacheRate / 1e6
        + completionTokens * outputRate / 1e6;
    return native * fx;
}

module.exports = {
    toUnitPrice,
    isPriced,
    toUsdUnitPrice,
    compareUsdUnitPrice,
    compareUsdUnitPriceForModelPick,
    calculateCost,
    usdPer,
    USD_CNY_MIDPOINT,
};
