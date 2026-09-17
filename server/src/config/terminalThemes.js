const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, 'terminal-themes.json');

let catalogCache = null;

function loadCatalog() {
    if (!catalogCache) {
        catalogCache = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    }
    return catalogCache;
}

function reloadCatalog() {
    catalogCache = null;
    return loadCatalog();
}

function getThemeById(id) {
    if (!id) return null;
    return loadCatalog().themes.find((t) => t.id === id) || null;
}

function getCatalogDefaultId() {
    return loadCatalog().default_id || 'github-dark';
}

function getThemeSpawnEnv(themeId) {
    const theme = getThemeById(themeId);
    return theme?.spawn_env ? { ...theme.spawn_env } : {};
}

function isThemeSelectable(themeId, { disabledIds = [] } = {}) {
    const theme = getThemeById(themeId);
    if (!theme || !theme.enabled) return false;
    if (disabledIds.includes(themeId)) return false;
    return true;
}

/**
 * Resolve effective terminal theme id per priority (§4.2).
 * Invalid / disabled ids fall back to default; optional warn callback receives details.
 */
function resolveEffectiveTerminalThemeId({
    requestThemeId,
    userThemeId,
    platformDefaultId,
    disabledIds = [],
    warn,
} = {}) {
    const catalog = loadCatalog();
    const fallbackId = platformDefaultId || catalog.default_id || 'github-dark';

    const orderedIds = [
        requestThemeId,
        userThemeId,
        platformDefaultId,
        catalog.default_id,
        'github-dark',
    ].filter(Boolean);

    const preferredId = requestThemeId || userThemeId || null;

    for (const id of orderedIds) {
        if (isThemeSelectable(id, { disabledIds })) {
            if (preferredId && preferredId !== id && warn) {
                warn(`Terminal theme "${preferredId}" is invalid or disabled; using "${id}".`);
            }
            return id;
        }
    }

    if (isThemeSelectable(fallbackId, { disabledIds })) {
        if (preferredId && preferredId !== fallbackId && warn) {
            warn(`Terminal theme "${preferredId}" is invalid or disabled; using "${fallbackId}".`);
        }
        return fallbackId;
    }

    const firstEnabled = catalog.themes.find(
        (t) => t.enabled && !disabledIds.includes(t.id),
    );
    const resolved = firstEnabled?.id || 'github-dark';
    if (preferredId && preferredId !== resolved && warn) {
        warn(`Terminal theme "${preferredId}" is invalid or disabled; using "${resolved}".`);
    }
    return resolved;
}

function listPublicThemes({ platformDefaultId, disabledIds = [] } = {}) {
    const catalog = loadCatalog();
    const defaultId = resolveEffectiveTerminalThemeId({
        platformDefaultId: platformDefaultId || catalog.default_id,
        disabledIds,
    });
    const themes = catalog.themes
        .filter((t) => t.enabled && !disabledIds.includes(t.id))
        .map(({ id, label, appearance }) => ({ id, label, appearance }));
    return { default_id: defaultId, themes };
}

function pickSpawnEnvPreview(env) {
    const preview = {};
    if (env.COLORFGBG) preview.COLORFGBG = env.COLORFGBG;
    if (env.COLORTERM) preview.COLORTERM = env.COLORTERM;
    if (env.TERM) preview.TERM = env.TERM;
    return preview;
}

module.exports = {
    loadCatalog,
    reloadCatalog,
    getThemeById,
    getCatalogDefaultId,
    getThemeSpawnEnv,
    isThemeSelectable,
    resolveEffectiveTerminalThemeId,
    listPublicThemes,
    pickSpawnEnvPreview,
};
