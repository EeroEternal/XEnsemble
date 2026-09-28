const fs = require('fs');
const { CONFIG_PATH } = require('./unigatewayManager');

function parseProvidersFromToml(text) {
    const providers = [];
    const blocks = String(text || '').split(/\[\[providers\]\]/).slice(1);
    for (const block of blocks) {
        const entry = {};
        const sectionEnd = block.search(/\n\[\[/);
        const section = sectionEnd >= 0 ? block.slice(0, sectionEnd) : block;
        for (const line of section.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const quoted = trimmed.match(/^(\w+)\s*=\s*"((?:\\.|[^"\\])*)"/);
            if (quoted) {
                entry[quoted[1]] = quoted[2].replace(/\\"/g, '"');
                continue;
            }
            // TOML literal string (single-quoted): no escape processing. The
            // gateway serializes model_mapping this way, so omitting this case
            // silently drops every provider's model list.
            const literal = trimmed.match(/^(\w+)\s*=\s*'([^']*)'/);
            if (literal) {
                entry[literal[1]] = literal[2];
                continue;
            }
            const boolMatch = trimmed.match(/^(\w+)\s*=\s*(true|false)\s*$/);
            if (boolMatch) {
                entry[boolMatch[1]] = boolMatch[2] === 'true';
            }
        }
        if (entry.name) providers.push(entry);
    }
    return providers;
}

function modelsFromProviderEntry(provider) {
    if (!provider?.model_mapping) return [];
    try {
        const mapping = JSON.parse(provider.model_mapping);
        if (mapping && typeof mapping === 'object') return Object.keys(mapping);
    } catch {
        /* ignore malformed mapping */
    }
    return [];
}

function readProviderCredentials(name) {
    const providerName = String(name || '').trim();
    if (!providerName) return null;
    let text;
    try {
        text = fs.readFileSync(CONFIG_PATH, 'utf8');
    } catch {
        return null;
    }
    const provider = parseProvidersFromToml(text).find((p) => p.name === providerName);
    if (!provider) return null;
    return {
        name: provider.name,
        base_url: String(provider.base_url || '').trim(),
        api_key: String(provider.api_key || '').trim(),
        default_model: String(provider.default_model || '').trim(),
        models: modelsFromProviderEntry(provider),
        is_enabled: provider.is_enabled !== false,
    };
}

module.exports = { readProviderCredentials, parseProvidersFromToml, modelsFromProviderEntry };
