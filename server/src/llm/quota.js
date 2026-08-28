const PlatformSettings = require('../admin/PlatformSettings');

// 固定每用户每分钟 LLM 请求上限（不再按 resource_tier 区分）。
// tier 前端已下线，全员恒为 basic 时旧阈值 12/min 会误伤真实 Agent 会话；
// 但仍保留一个宽松上限，防止单用户打爆共享上游网关的 QPS（上游 429 是当前排查的问题）。
const LLM_REQ_LIMIT_PER_MIN = 120;

const WINDOW_MS = 60_000;
const buckets = new Map();
let _lastCleanup = 0;

function bucketKey(userId) {
    const slot = Math.floor(Date.now() / WINDOW_MS);
    return `${userId}:${slot}`;
}

function settingsKey(bucket) {
    return `llm_quota_bucket:${bucket}`;
}

function cleanupExpiredBuckets() {
    const now = Date.now();
    if (now - _lastCleanup < WINDOW_MS) return;
    _lastCleanup = now;
    const currentSlot = Math.floor(now / WINDOW_MS);
    for (const key of buckets.keys()) {
        const parts = key.split(':');
        const slot = Number(parts[parts.length - 1]);
        if (Number.isFinite(slot) && slot < currentSlot) {
            buckets.delete(key);
        }
    }
}

async function loadBucketCount(key) {
    if (buckets.has(key)) return buckets.get(key);
    try {
        const stored = await PlatformSettings.get(settingsKey(key));
        const count = Number(stored);
        const value = Number.isFinite(count) && count > 0 ? count : 0;
        buckets.set(key, value);
        return value;
    } catch {
        buckets.set(key, 0);
        return 0;
    }
}

function persistBucketCount(key, count) {
    PlatformSettings.set(settingsKey(key), count).catch(() => { /* best-effort */ });
}

async function checkLlmRequestQuota(userId, role) {
    if (role === 'admin') return { ok: true };

    const limit = LLM_REQ_LIMIT_PER_MIN;
    const key = bucketKey(userId);
    const current = await loadBucketCount(key);
    if (current >= limit) {
        return {
            ok: false,
            status: 429,
            error: 'LLM request quota exceeded',
            limit,
            window_seconds: WINDOW_MS / 1000,
        };
    }
    const next = current + 1;
    buckets.set(key, next);
    persistBucketCount(key, next);
    cleanupExpiredBuckets();
    return { ok: true, limit };
}

function resetLlmQuotaForTests() {
    buckets.clear();
}

module.exports = {
    LLM_REQ_LIMIT_PER_MIN,
    checkLlmRequestQuota,
    resetLlmQuotaForTests,
};
