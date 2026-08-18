const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

function secretPlaceholderPatterns(key) {
    const escaped = key.replace(ESCAPE_RE, '\\$&');
    return [
        new RegExp(`YOUR_${escaped}\\b`, 'g'),
        new RegExp(`__${escaped}__\\b`, 'g'),
        new RegExp(`^(${escaped}=)\\s*$`, 'gm'),
    ];
}

function injectSecretsIntoTemplate(template, keys, secretMap) {
    if (!template || !Array.isArray(keys) || keys.length === 0) {
        return { template: template || '', injected: [] };
    }
    const secretValues = secretMap || {};
    const injected = [];
    let result = template;
    for (const key of keys) {
        const value = secretValues[key];
        if (value == null || String(value).trim() === '') continue;
        for (const pattern of secretPlaceholderPatterns(key)) {
            if (pattern.test(result)) {
                result = result.replace(pattern, String(value));
                if (!injected.includes(key)) injected.push(key);
                break;
            }
        }
    }
    return { template: result, injected };
}

module.exports = { injectSecretsIntoTemplate };
