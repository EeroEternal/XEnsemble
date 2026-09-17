const fs = require('fs');
const path = require('path');

const DEFAULT_REGISTRY = path.join(__dirname, 'modelPortraits.registry.json');
const portraitsCache = new Map();

function canonicalModelId(raw) {
    let s = String(raw || '').trim();
    if (s.startsWith('anthropic.')) s = s.slice('anthropic.'.length);
    const slash = s.indexOf('/');
    if (slash > 0) s = s.slice(slash + 1);
    return s.trim();
}

function fetchModelPortraits({ registryPath } = {}) {
    const p = registryPath || DEFAULT_REGISTRY;
    let mtimeMs = 0;
    try {
        mtimeMs = fs.statSync(p).mtimeMs;
    } catch {
        mtimeMs = 0;
    }
    const hit = portraitsCache.get(p);
    if (hit && hit.mtimeMs === mtimeMs) return hit.portraits;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const portraits = { registry_version: parsed.registry_version, offerings: parsed.offerings || [] };
    portraitsCache.set(p, { mtimeMs, portraits });
    return portraits;
}

function findOfferings(portraits, { modelId, providerId } = {}) {
    const canon = canonicalModelId(modelId);
    return (portraits.offerings || []).filter((o) => {
        const idOk = o.canonical_model_id === canon || o.model_id === canon || canonicalModelId(o.model_id) === canon;
        const provOk = !providerId || o.provider_id === providerId;
        return idOk && provOk;
    });
}

module.exports = { canonicalModelId, fetchModelPortraits, findOfferings, DEFAULT_REGISTRY };
