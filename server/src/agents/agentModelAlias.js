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

module.exports = { toOpencodeModelAlias };
