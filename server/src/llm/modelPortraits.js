const fs = require('fs');
const path = require('path');

const DEFAULT_REGISTRY = path.join(__dirname, 'modelPortraits.registry.json');

function canonicalModelId(raw) {
    let s = String(raw || '').trim();
    if (s.startsWith('anthropic.')) s = s.slice('anthropic.'.length);
    const slash = s.indexOf('/');
    if (slash > 0) s = s.slice(slash + 1);
    return s.trim();
}

function fetchModelPortraits({ registryPath } = {}) {
    const p = registryPath || DEFAULT_REGISTRY;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { registry_version: parsed.registry_version, offerings: parsed.offerings || [] };
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
