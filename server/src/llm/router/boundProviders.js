const fs = require('fs');

function resolvePortraitProviderIds(gatewayName, providers = []) {
    const name = String(gatewayName || '').trim();
    if (!name) return [];
    const ids = new Set([name]);
    const entry = (providers || []).find((p) => p && p.name === name);
    const endpointId = String(entry?.endpoint_id || '').trim();
    if (endpointId) {
        ids.add(endpointId);
        const base = endpointId.split(':')[0];
        if (base) ids.add(base);
    }
    return [...ids];
}

function resolveBoundProviderIdsFromGateway(gatewayName) {
    let providers = [];
    try {
        const { parseProvidersFromToml } = require('../../gateway/readProviderSecrets');
        const { CONFIG_PATH } = require('../../gateway/unigatewayManager');
        providers = parseProvidersFromToml(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
        providers = [];
    }
    return resolvePortraitProviderIds(gatewayName, providers);
}

module.exports = { resolvePortraitProviderIds, resolveBoundProviderIdsFromGateway };
