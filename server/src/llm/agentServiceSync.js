const fs = require('fs');
const path = require('path');
const agentGatewayConfig = require('../admin/AgentGatewayConfig');
const unigateway = require('../gateway/unigatewayManager');
const { parseProvidersFromToml, modelsFromProviderEntry } = require('../gateway/readProviderSecrets');
const { upsertAgentServiceBinding } = require('./agentServiceToml');

// Must match unigatewayManager's DATA_DIR: the gateway process loads
// UNIGATEWAY_CONFIG_PATH (default /var/lib/xensemble/unigateway/unigateway.toml)
// and reload_from_disk reads THAT file — a second copy under server/data would
// silently diverge and make every binding sync a no-op against the live gateway.
const DATA_DIR = process.env.UNIGATEWAY_DATA_DIR
    || path.join(__dirname, '../../data');
const CONFIG_PATH = path.join(DATA_DIR, 'unigateway.toml');

/**
 * Check if a provider exists in the UniGateway.
 * Providers may be configured via the admin API (stored in gateway memory)
 * or via the TOML file. Check both sources.
 */
async function providerExistsInGateway(providerName, log) {
    // First check the TOML file
    if (fs.existsSync(CONFIG_PATH)) {
        const toml = fs.readFileSync(CONFIG_PATH, 'utf8');
        const tomlProviders = parseProvidersFromToml(toml);
        if (tomlProviders.some((p) => p.name === providerName)) return true;
    }

    // Then check the UniGateway admin API (providers added via admin API
    // are stored in gateway memory, not persisted to the TOML file)
    const status = unigateway.getStatus();
    if (!status.running) return false;

    try {
        const { requestGateway } = require('../gateway/adminProxy');
        const result = await requestGateway('GET', '/api/admin/providers', { log });
        if (result.statusCode === 200 && result.body) {
            const body = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
            const providerList = body?.data || body || [];
            return Array.isArray(providerList) && providerList.some((p) => p.name === providerName);
        }
    } catch (err) {
        log?.warn?.(`[llm] failed to query providers from gateway admin API: ${err.message}`);
    }
    return false;
}

/**
 * Push the updated TOML into the running UniGateway WITHOUT restarting.
 * The gateway merges externally-added services/bindings from the on-disk TOML
 * into memory and rebuilds its routing pools atomically, so in-flight LLM
 * requests are not interrupted.
 */
async function reloadGateway(log = console) {
    const status = unigateway.getStatus();
    if (!status.running) return { ok: false, reason: 'not_running' };
    try {
        const { requestGateway } = require('../gateway/adminProxy');
        const result = await requestGateway('POST', '/api/admin/reload', { log });
        if (result.statusCode >= 200 && result.statusCode < 300) {
            log.info?.('[llm] UniGateway config reloaded (no restart)');
            return { ok: true };
        }
        log.warn?.(`[llm] UniGateway reload failed (status ${result.statusCode})`);
        return { ok: false, reason: `http_${result.statusCode}` };
    } catch (err) {
        log.warn?.(`[llm] UniGateway reload failed: ${err.message}`);
        return { ok: false, reason: err.message };
    }
}

async function syncAgentServiceBinding(agentId, log = console) {
    const cfg = await agentGatewayConfig.getForAgent(agentId);
    if (!cfg || cfg.llm_auth_mode !== 'gateway') return { synced: false, reason: 'not_gateway_mode' };
    const { resolveExternalGatewayUrl } = require('./gatewayUpstream');
    if (await resolveExternalGatewayUrl()) {
        return {
            synced: true,
            changed: false,
            agentId,
            reason: 'external_default_service',
        };
    }

    const providerName = cfg.provider?.trim();
    if (!providerName) return { synced: false, reason: 'no_provider' };

    const exists = await providerExistsInGateway(providerName, log);
    if (!exists) {
        return { synced: false, reason: 'provider_not_found', providerName };
    }

    if (!fs.existsSync(CONFIG_PATH)) {
        return { synced: false, reason: 'missing_config' };
    }

    const before = fs.readFileSync(CONFIG_PATH, 'utf8');
    const after = upsertAgentServiceBinding(before, agentId, providerName);
    if (after === before) return { synced: true, changed: false, agentId, providerName };

    fs.writeFileSync(CONFIG_PATH, after, { mode: 0o600 });
    log.info?.(`[llm] synced UniGateway service binding agent=${agentId} provider=${providerName}`);

    // Hot-reload the running gateway so the new binding takes effect without
    // interrupting in-flight requests.
    await reloadGateway(log);
    return { synced: true, changed: true, agentId, providerName };
}

async function syncAllAgentServiceBindings(log = console) {
    const all = await agentGatewayConfig.getAll();
    const { resolveExternalGatewayUrl } = require('./gatewayUpstream');
    const isExternal = await resolveExternalGatewayUrl();

    // Phase 1: validate all agents and collect bindings to add
    const toSync = [];
    const results = [];
    for (const agentId of Object.keys(all)) {
        const cfg = all[agentId];
        if (!cfg || cfg.llm_auth_mode !== 'gateway') {
            results.push({ agentId, synced: false, reason: 'not_gateway_mode' });
            continue;
        }
        if (isExternal) {
            results.push({ agentId, synced: true, changed: false, reason: 'external_default_service' });
            continue;
        }
        const providerName = cfg.provider?.trim();
        if (!providerName) {
            results.push({ agentId, synced: false, reason: 'no_provider' });
            continue;
        }
        const exists = await providerExistsInGateway(providerName, log);
        if (!exists) {
            results.push({ agentId, synced: false, reason: 'provider_not_found', providerName });
            continue;
        }
        toSync.push({ agentId, providerName });
    }

    if (toSync.length === 0 || !fs.existsSync(CONFIG_PATH)) {
        if (toSync.length > 0) {
            for (const { agentId } of toSync) {
                results.push({ agentId, synced: false, reason: 'missing_config' });
            }
        }
        return results;
    }

    // Phase 2: apply ALL bindings in a single TOML write, then hot-reload once
    let before = fs.readFileSync(CONFIG_PATH, 'utf8');
    let changed = false;
    for (const { agentId, providerName } of toSync) {
        const after = upsertAgentServiceBinding(before, agentId, providerName);
        if (after !== before) {
            before = after;
            changed = true;
            log.info?.(`[llm] queued binding agent=${agentId} provider=${providerName}`);
        }
        results.push({ agentId, synced: true, changed: after !== before, providerName });
    }

    if (changed) {
        fs.writeFileSync(CONFIG_PATH, before, { mode: 0o600 });
        log.info?.(`[llm] wrote ${toSync.length} bindings to UniGateway TOML`);

        // Hot-reload the running gateway (no restart) so the new bindings take
        // effect without interrupting in-flight requests.
        await reloadGateway(log);
    }

    return results;
}

/**
 * Collect the live model catalog per provider. The running gateway's admin API
 * is authoritative (it reflects providers added via the API as well as ones
 * loaded from the TOML); when the gateway is not running, fall back to reading
 * the TOML file directly so a manual `unigateway.toml` edit is still picked up.
 */
async function collectProviderModels(log) {
    const catalog = new Map();
    const status = unigateway.getStatus();
    if (status.running) {
        try {
            const { requestGateway } = require('../gateway/adminProxy');
            const result = await requestGateway('GET', '/api/admin/providers', { log });
            if (result.statusCode === 200 && result.body) {
                const body = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
                const providers = body?.data || body || [];
                if (Array.isArray(providers)) {
                    for (const p of providers) {
                        if (p?.name && Array.isArray(p?.models)) catalog.set(p.name, p.models);
                    }
                }
            }
        } catch (err) {
            log?.warn?.(`[llm] failed to read providers from gateway admin API: ${err.message}`);
        }
    }

    if (fs.existsSync(CONFIG_PATH)) {
        const toml = fs.readFileSync(CONFIG_PATH, 'utf8');
        for (const p of parseProvidersFromToml(toml)) {
            if (catalog.has(p.name)) continue;
            catalog.set(p.name, modelsFromProviderEntry(p));
        }
    }
    return catalog;
}

/**
 * Drop agent-configured models that no longer exist in their provider's live
 * catalog. This heals drift introduced outside the Admin API (e.g. a provider's
 * model_mapping edited directly in unigateway.toml), which the prune hook on
 * provider write routes never sees. Best-effort; never throws.
 */
async function reconcileAgentModelsFromGateway(log = console) {
    const pruned = [];
    try {
        const catalog = await collectProviderModels(log);
        if (catalog.size === 0) return pruned;
        for (const [providerName, models] of catalog) {
            try {
                if (await agentGatewayConfig.pruneAgentModelsForProvider(providerName, models, log)) {
                    pruned.push(providerName);
                }
            } catch (err) {
                log?.warn?.(`[llm] pruning agent models for provider ${providerName} failed: ${err.message}`);
            }
        }
    } catch (err) {
        log?.warn?.(`[llm] agent model reconciliation failed: ${err.message}`);
    }
    return pruned;
}

module.exports = {
    syncAgentServiceBinding,
    syncAllAgentServiceBindings,
    reconcileAgentModelsFromGateway,
};
