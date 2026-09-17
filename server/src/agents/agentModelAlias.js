/**
 * opencode 1.18.x parses the `model` field as `provider/model_id` by splitting on
 * the FIRST `/` (see fix 2709ba8 in agentEnv tests). When the model_id itself
 * contains `/` or `:` (e.g. openrouter ids like `nvidia/nemotron-...:free`),
 * opencode's /model picker re-splits the candidate key on `/` and mis-resolves
 * the provider, so /model switches silently fall back to the default. The fix
 * is to give opencode a *local* model_id with no `/` or `:` so its parser
 * stays unambiguous; UniGateway's `model_mapping` translates the alias back
 * to the real upstream model name. `/` and `:` are both replaced with `-`,
 * which preserves the namespace as a readable prefix
 * (`nvidia/foo:bar` -> `nvidia-foo-bar`).
 *
 * This module is intentionally dependency-free (no DB / platformSettings
 * imports) so it can be required from `ensureGatewayConfig` and `proxy`
 * without pulling the control-plane load chain.
 */
function toOpencodeModelAlias(modelId) {
    return String(modelId || '').replace(/[\/:]/g, '-');
}

function lookupOpencodeReal(preRouteModel, reals) {
    const raw = String(preRouteModel || '').trim();
    if (!raw) return null;

    const aliasToReal = new Map();
    for (const item of reals || []) {
        const real = String(item || '').trim();
        if (!real) continue;
        aliasToReal.set(real, real);
        aliasToReal.set(toOpencodeModelAlias(real), real);
        if (real.includes('/')) {
            const rest = real.split('/').slice(1).join('/');
            if (rest) {
                aliasToReal.set(rest, real);
                aliasToReal.set(toOpencodeModelAlias(rest), real);
            }
        }
    }

    const keys = [raw];
    if (raw.startsWith('gateway/')) keys.push(raw.slice('gateway/'.length));
    if (raw.includes('/')) keys.push(raw.split('/').slice(1).join('/'));

    for (const key of keys) {
        if (!key) continue;
        const hit = aliasToReal.get(key) || aliasToReal.get(toOpencodeModelAlias(key));
        if (hit) return hit;
    }
    return null;
}

/**
 * Map an opencode request model (local alias, optional gateway/ prefix, or
 * routing-prefixed alias) back to UniGateway's real id, then re-apply the
 * bound provider chosen by intelligent routing.
 */
function resolveOpencodeRoutedModel(preRouteModel, { reals, chosenProvider } = {}) {
    const real = lookupOpencodeReal(preRouteModel, reals);
    if (!real) return null;
    const provider = String(chosenProvider || '').trim();
    return provider ? `${provider}/${real}` : real;
}

module.exports = { toOpencodeModelAlias, resolveOpencodeRoutedModel };
