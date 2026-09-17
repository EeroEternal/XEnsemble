const fs = require('fs');
const path = require('path');
const { canonicalModelId } = require('./modelPortraits');

const DEFAULT_CATALOG = path.join(__dirname, 'modelCatalog.json');
const catalogCache = new Map();

function modelFamily(modelId) {
    const c = canonicalModelId(modelId).toLowerCase();
    if (/^glm-5[.-]3-flash/.test(c)) return 'glm-5.3-flash';
    if (
        c.startsWith('deepseek-v4-flash')
        || c === 'deepseek-flash'
        || c === 'deepseek-chat'
        || c === 'deepseek-reasoner'
    ) {
        return 'deepseek-v4-flash';
    }
    if (c.includes('minimax-m3')) return 'minimax-m3';
    return c;
}

function emptyCatalog() {
    return { version: 1, currency: 'USD', entries: [] };
}

function normalizeCatalog(parsed) {
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return {
        version: parsed?.version || 1,
        currency: parsed?.currency || 'USD',
        priced_at: parsed?.priced_at || null,
        notes: parsed?.notes || '',
        entries: entries.filter((e) => e && e.provider && e.model),
    };
}

function fetchModelCatalog({ catalogPath } = {}) {
    const p = catalogPath || DEFAULT_CATALOG;
    let mtimeMs = 0;
    try {
        mtimeMs = fs.statSync(p).mtimeMs;
    } catch {
        return emptyCatalog();
    }
    const hit = catalogCache.get(p);
    if (hit && hit.mtimeMs === mtimeMs) return hit.catalog;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const catalog = normalizeCatalog(parsed);
    catalogCache.set(p, { mtimeMs, catalog });
    return catalog;
}

function entryFamily(entry) {
    return entry.family || modelFamily(entry.canonical_model_id || entry.model);
}

function entryMatchesModel(entry, modelId) {
    const canon = canonicalModelId(modelId);
    const family = modelFamily(modelId);
    const entryCanon = canonicalModelId(entry.canonical_model_id || entry.model);
    return entry.model === modelId
        || entryCanon === canon
        || entryFamily(entry) === family;
}

function isPricedPrice(price) {
    if (!price) return false;
    return price.input != null
        || price.output != null
        || price.cache_read != null
        || price.cache_write != null;
}

function usdEstimateFromEntry(entry) {
    const price = entry?.price;
    if (!isPricedPrice(price)) return null;
    return {
        currency: 'USD',
        cache_read: price.cache_read ?? null,
        cache_write: price.cache_write ?? null,
        input: price.input ?? null,
        output: price.output ?? null,
    };
}

function findCatalogEntries(catalog, { model } = {}) {
    const entries = catalog?.entries || [];
    if (!model) return [];
    return entries.filter((entry) => entryMatchesModel(entry, model));
}

function lookupCatalog(catalog, { provider, model } = {}) {
    const entries = catalog?.entries || [];
    if (!model) return null;
    const prov = String(provider || '').trim();
    const canon = canonicalModelId(model);
    const family = modelFamily(model);

    const ranked = [];
    for (const entry of entries) {
        if (!entryMatchesModel(entry, model)) continue;
        let rank = 4;
        if (prov && entry.provider === prov && entry.model === model) rank = 0;
        else if (prov && entry.provider === prov && canonicalModelId(entry.canonical_model_id || entry.model) === canon) rank = 1;
        else if (prov && entry.provider === prov && entryFamily(entry) === family) rank = 2;
        else if (entryFamily(entry) === family) rank = 3;
        else continue;
        ranked.push({ rank, entry });
    }
    ranked.sort((a, b) => a.rank - b.rank);
    return ranked[0]?.entry || null;
}

module.exports = {
    DEFAULT_CATALOG,
    fetchModelCatalog,
    lookupCatalog,
    findCatalogEntries,
    usdEstimateFromEntry,
    modelFamily,
};
