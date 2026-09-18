const { db } = require('../db/index');
const schema = require('../db/schema');
const { eq } = require('drizzle-orm');
const { DEFAULT_QUOTA } = require('../auth/PolicyService');

const CACHE_TTL_MS = 5000;

let _cache = null;
let _cacheAt = 0;

const DEFAULTS = {
    llm_auth_mode: 'byok',
    registration_mode: 'open',
    default_user_quota: {
        max_projects: DEFAULT_QUOTA.maxProjects,
        max_sessions: DEFAULT_QUOTA.maxSessions,
        max_previews: DEFAULT_QUOTA.maxPreviews,
        max_runtimes: DEFAULT_QUOTA.maxRuntimes,
        max_custom_images: DEFAULT_QUOTA.maxCustomImages,
        resource_tier: DEFAULT_QUOTA.resourceTier,
    },
    session_ttl_hours: 24,
    default_terminal_theme_id: 'github-dark',
    disabled_terminal_theme_ids: [],
    // 自定义镜像（环境配方）的平台级参数。
    // 用户可见的镜像数量配额在 default_user_quota.max_custom_images（设置 →
    // 默认用户配置 / 观测 → 配额）；配方本身不再限制组件数/磁盘（运行时按
    // 组件的 diskSizeMb 自动扩 VM 磁盘）。
    custom_image_limits: {
        max_env_images_per_user: 50,
        gc_idle_days: Number(process.env.CUSTOM_IMAGE_GC_IDLE_DAYS) || 30,
        gc_grace_hours: Number(process.env.CUSTOM_IMAGE_GC_GRACE_HOURS) || 24,
    },
    // preview 部署时数据库模式：
    //   local （默认）— 在沙箱内起 DB 并本地化 host（隔离、可复现、不碰生产库）；
    //   remote        — 保留 app 配置的远端 host（显式 opt-in，需注意可达性/凭据/数据风险）。
    preview_db_mode: 'local',
};

async function get(key) {
    const rows = await db.select().from(schema.platformSettings).where(eq(schema.platformSettings.key, key));
    if (rows.length === 0) return DEFAULTS[key] ?? null;
    try {
        return JSON.parse(rows[0].value);
    } catch {
        return rows[0].value;
    }
}

async function set(key, value) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const existing = await db.select().from(schema.platformSettings).where(eq(schema.platformSettings.key, key));
    if (existing.length > 0) {
        await db.update(schema.platformSettings).set({ value: serialized }).where(eq(schema.platformSettings.key, key));
    } else {
        await db.insert(schema.platformSettings).values({ key, value: serialized });
    }
    _cache = null;
    return value;
}

async function getAll() {
    const now = Date.now();
    if (_cache && (now - _cacheAt) < CACHE_TTL_MS) return _cache;
    const rows = await db.select().from(schema.platformSettings);
    const out = { ...DEFAULTS };
    for (const row of rows) {
        try {
            const parsed = JSON.parse(row.value);
            // Object-valued settings are merged over DEFAULTS so fields added
            // after the value was persisted still have a concrete default.
            out[row.key] = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                && DEFAULTS[row.key] && typeof DEFAULTS[row.key] === 'object'
                && !Array.isArray(DEFAULTS[row.key]))
                ? { ...DEFAULTS[row.key], ...parsed }
                : parsed;
        } catch {
            out[row.key] = row.value;
        }
    }
    _cache = out;
    _cacheAt = now;
    return out;
}

async function updateAll(updates) {
    const allowed = [
        'llm_auth_mode',
        'registration_mode',
        'default_user_quota',
        'session_ttl_hours',
        'default_terminal_theme_id',
        'disabled_terminal_theme_ids',
        'preview_db_mode',
        'custom_image_limits',
    ];
    if (updates.llm_auth_mode !== undefined && !['gateway', 'byok'].includes(updates.llm_auth_mode)) {
        throw Object.assign(new Error('Invalid llm_auth_mode'), { statusCode: 400 });
    }
    if (updates.preview_db_mode !== undefined && !['local', 'remote'].includes(updates.preview_db_mode)) {
        throw Object.assign(new Error('Invalid preview_db_mode'), { statusCode: 400 });
    }
    if (updates.disabled_terminal_theme_ids !== undefined) {
        if (!Array.isArray(updates.disabled_terminal_theme_ids)) {
            throw Object.assign(new Error('disabled_terminal_theme_ids must be an array'), { statusCode: 400 });
        }
    }
    for (const key of allowed) {
        if (updates[key] !== undefined) {
            await set(key, updates[key]);
        }
    }
    return getAll();
}

async function getRegistrationMode() {
    return (await get('registration_mode')) || 'open';
}

async function getDefaultUserQuota() {
    // Merge over DEFAULTS so installs that persisted the object before a field
    // was introduced still surface a concrete value (e.g. max_custom_images).
    return { ...DEFAULTS.default_user_quota, ...((await get('default_user_quota')) || {}) };
}

async function getCustomImageLimits() {
    const stored = await get('custom_image_limits');
    return { ...DEFAULTS.custom_image_limits, ...(stored || {}) };
}

async function getLlmAuthMode() {
    const mode = await get('llm_auth_mode');
    return mode === 'gateway' ? 'gateway' : 'byok';
}

async function seedDefaults(dbConn = db) {
    const entries = [
        ['llm_auth_mode', DEFAULTS.llm_auth_mode],
        ['registration_mode', DEFAULTS.registration_mode],
        ['default_user_quota', DEFAULTS.default_user_quota],
        ['session_ttl_hours', DEFAULTS.session_ttl_hours],
        ['default_terminal_theme_id', DEFAULTS.default_terminal_theme_id],
        ['disabled_terminal_theme_ids', DEFAULTS.disabled_terminal_theme_ids],
        ['preview_db_mode', DEFAULTS.preview_db_mode],
        ['custom_image_limits', DEFAULTS.custom_image_limits],
    ];
    for (const [key, value] of entries) {
        await dbConn.insert(schema.platformSettings).values({
            key,
            value: JSON.stringify(value),
        }).onConflictDoNothing();
    }
    _cache = null;
}

module.exports = {
    DEFAULTS,
    get,
    set,
    getAll,
    updateAll,
    getLlmAuthMode,
    getRegistrationMode,
    getDefaultUserQuota,
    getCustomImageLimits,
    seedDefaults,
};
