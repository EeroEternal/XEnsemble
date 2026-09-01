/**
 * Skills 服务（P3 市场 MVP）：CRUD + 状态机 + 发布/下架 + 安装复制 + 市场查询。
 *
 * 市场语义：
 * - visibility='public' 且 published_at 非空 => 在市场中可见
 * - 安装 = 复制一份为当前用户的私有 draft（source='installed', forked_from 记录来源），
 *   原 skill.install_count +1
 * - 状态机：draft → active → archived（archived 可 restore 回 active）
 */

const { randomBytes } = require('crypto');
const { and, eq, desc, sql, or, ilike } = require('drizzle-orm');
const { db } = require('../db');
const schema = require('../db/schema');

const CATEGORIES = ['workflow', 'convention', 'debug', 'database', 'devops', 'codegen'];

const STATUS_TRANSITIONS = {
    draft: { activate: 'active' },
    active: { archive: 'archived' },
    archived: { restore: 'active' },
};

function newSkillId() {
    return `skl_${randomBytes(8).toString('hex')}`;
}

function parseTags(tags) {
    if (!Array.isArray(tags)) return [];
    const seen = new Set();
    const out = [];
    for (const s of tags) {
        const trimmed = String(s).trim();
        if (!trimmed) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
        if (out.length >= 10) break;
    }
    return out;
}

function parseSignals(signals) {
    if (!signals || typeof signals !== 'object' || Array.isArray(signals)) return null;
    return signals;
}

function mapRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.userId,
        projectId: row.projectId ?? null,
        sessionId: row.sessionId ?? null,
        title: row.title,
        content: row.content,
        tags: Array.isArray(row.tags) ? row.tags : [],
        status: row.status,
        source: row.source,
        confidence: row.confidence ?? null,
        duplicateOf: row.duplicateOf ?? null,
        clusterSize: row.clusterSize ?? 1,
        signals: row.signals ?? null,
        usageCount: row.usageCount ?? 0,
        visibility: row.visibility ?? 'private',
        publishedAt: row.publishedAt ?? null,
        installCount: row.installCount ?? 0,
        category: row.category ?? null,
        forkedFrom: row.forkedFrom ?? null,
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
    };
}

function requireOwner(skill, userId) {
    if (skill.userId !== userId) {
        const err = new Error('skill not found');
        err.code = 'skill_not_found';
        err.statusCode = 404;
        throw err;
    }
}

/**
 * T4.4：skill 状态/内容/删除变更后，对无 running session 的项目重渲染指令文件。
 * 懒加载 skillInjector（避免循环依赖）；SKILL_INJECT_ENABLED=false 时 injector 内部 no-op。
 */
async function reRenderAfterSkillChange(userId, projectId) {
    try {
        const { reRenderForSkillChange } = require('./skillInjector');
        await reRenderForSkillChange({ userId, projectId: projectId || null });
    } catch (_) { /* 重渲染失败不影响主操作 */ }
}

function validateCreate({ title, content }) {
    const trimmedTitle = String(title ?? '').trim();
    const trimmedContent = String(content ?? '').trim();
    if (!trimmedTitle) {
        const err = new Error('title is required');
        err.code = 'skill_validation_failed';
        err.statusCode = 400;
        throw err;
    }
    if (trimmedTitle.length > 100) {
        const err = new Error('title too long');
        err.code = 'skill_validation_failed';
        err.statusCode = 400;
        throw err;
    }
    if (!trimmedContent) {
        const err = new Error('content is required');
        err.code = 'skill_validation_failed';
        err.statusCode = 400;
        throw err;
    }
    if (trimmedContent.length > 16384) {
        const err = new Error('content too long');
        err.code = 'skill_validation_failed';
        err.statusCode = 400;
        throw err;
    }
    return { title: trimmedTitle, content: trimmedContent };
}

/**
 * 创建 skill（手动创建 / 从会话提炼入口）。
 */
async function createSkill({ userId, title, content, tags = [], category = null, projectId = null, sessionId = null, source = 'manual', signals = null, confidence = null }) {
    const { title: t, content: c } = validateCreate({ title, content });
    const id = newSkillId();
    const now = Date.now();
    await db.insert(schema.skills).values({
        id,
        userId,
        projectId: projectId || null,
        sessionId: sessionId || null,
        title: t,
        content: c,
        tags: parseTags(tags),
        status: 'draft',
        source: source === 'auto' ? 'auto' : 'manual',
        confidence: Number.isFinite(confidence) ? confidence : null,
        signals: parseSignals(signals),
        category: CATEGORIES.includes(category) ? category : null,
        visibility: 'private',
        installCount: 0,
        usageCount: 0,
        clusterSize: 1,
        createdAt: now,
        updatedAt: now,
    });
    return getSkill(userId, id);
}

/**
 * 当前用户的 skill 列表（私有管理页）。
 */
async function listMySkills(userId, { status = null, q = '' } = {}) {
    const conditions = [eq(schema.skills.userId, userId)];
    if (status) conditions.push(eq(schema.skills.status, status));
    if (q) {
        const escaped = `%${String(q).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        conditions.push(or(
            ilike(schema.skills.title, escaped),
            ilike(schema.skills.content, escaped),
        ));
    }
    const rows = await db
        .select()
        .from(schema.skills)
        .where(and(...conditions))
        .orderBy(desc(schema.skills.updatedAt));
    return rows.map(mapRow);
}

/**
 * 获取单个 skill。本人可看私有；市场公开的可看。
 */
async function getSkill(userId, skillId, { allowPublic = false } = {}) {
    const rows = await db
        .select()
        .from(schema.skills)
        .where(eq(schema.skills.id, skillId))
        .limit(1);
    const skill = mapRow(rows[0] || null);
    if (!skill) {
        const err = new Error('skill not found');
        err.code = 'skill_not_found';
        err.statusCode = 404;
        throw err;
    }
    if (skill.userId === userId) return skill;
    if (allowPublic && skill.visibility === 'public' && skill.publishedAt != null) return skill;
    const err = new Error('skill not found');
    err.code = 'skill_not_found';
    err.statusCode = 404;
    throw err;
}

/**
 * 编辑 skill（仅本人）。不改变 status/visibility。
 */
async function updateSkill(userId, skillId, patch = {}) {
    const skill = await getSkill(userId, skillId);
    requireOwner(skill, userId);

    const next = {};
    if (patch.title !== undefined) {
        const { title: t } = validateCreate({ title: patch.title, content: skill.content });
        next.title = t;
    }
    if (patch.content !== undefined) {
        const { content: c } = validateCreate({ title: skill.title, content: patch.content });
        next.content = c;
    }
    if (patch.tags !== undefined) next.tags = parseTags(patch.tags);
    if (patch.category !== undefined) next.category = CATEGORIES.includes(patch.category) ? patch.category : null;
    if (patch.projectId !== undefined) next.projectId = patch.projectId || null;
    next.updatedAt = Date.now();

    const oldProjectId = skill.projectId || null;
    await db.update(schema.skills)
        .set(next)
        .where(and(eq(schema.skills.id, skillId), eq(schema.skills.userId, userId)));

    // T4.4：内容/作用域变更后重渲染指令文件（无 running session 的项目）
    const newSkill = await getSkill(userId, skillId);
    await reRenderAfterSkillChange(userId, oldProjectId);
    await reRenderAfterSkillChange(userId, newSkill.projectId || null);
    return newSkill;
}

/**
 * 状态机转移：activate / archive / restore。
 */
async function changeStatus(userId, skillId, action) {
    const skill = await getSkill(userId, skillId);
    requireOwner(skill, userId);

    const allowed = STATUS_TRANSITIONS[skill.status] || {};
    if (!allowed[action]) {
        const err = new Error(`invalid transition ${skill.status} -> ${action}`);
        err.code = 'skill_invalid_transition';
        err.statusCode = 400;
        throw err;
    }
    const nextStatus = allowed[action];
    await db.update(schema.skills)
        .set({ status: nextStatus, updatedAt: Date.now() })
        .where(and(eq(schema.skills.id, skillId), eq(schema.skills.userId, userId)));

    // T4.4：activate/archive/restore 后重渲染（归档 → 无 active 时标记段被移除）
    await reRenderAfterSkillChange(userId, skill.projectId || null);
    return getSkill(userId, skillId);
}

/**
 * 删除 skill（仅本人；任意状态可删）。
 */
async function deleteSkill(userId, skillId) {
    const skill = await getSkill(userId, skillId);
    requireOwner(skill, userId);
    await db.delete(schema.skills)
        .where(and(eq(schema.skills.id, skillId), eq(schema.skills.userId, userId)));

    // T4.4：删除后若该作用域无 active skill，重渲染会移除注入段
    await reRenderAfterSkillChange(userId, skill.projectId || null);
    return { ok: true };
}

/**
 * 发布到市场（本人）。任何状态均可发布，发布后 visibility=public。
 */
async function publishSkill(userId, skillId) {
    const skill = await getSkill(userId, skillId);
    requireOwner(skill, userId);
    const now = Date.now();
    await db.update(schema.skills)
        .set({ visibility: 'public', publishedAt: now, updatedAt: now })
        .where(and(eq(schema.skills.id, skillId), eq(schema.skills.userId, userId)));
    return getSkill(userId, skillId);
}

/**
 * 下架（本人）。
 */
async function unpublishSkill(userId, skillId) {
    const skill = await getSkill(userId, skillId);
    requireOwner(skill, userId);
    const now = Date.now();
    await db.update(schema.skills)
        .set({ visibility: 'private', publishedAt: null, updatedAt: now })
        .where(and(eq(schema.skills.id, skillId), eq(schema.skills.userId, userId)));
    return getSkill(userId, skillId);
}

const MARKET_SORTS = {
    'hot': desc(schema.skills.installCount),
    'newest': desc(schema.skills.publishedAt),
    'installs': desc(schema.skills.installCount),
    'default': desc(schema.skills.publishedAt),
};

/**
 * 市场查询：公开且已发布的 skill，分页 + 筛选 + 搜索。
 */
async function listMarket({ q = '', category = null, sort = 'hot', page = 1, pageSize = 20, excludeUserId = null } = {}) {
    const conditions = [
        eq(schema.skills.visibility, 'public'),
        sql`${schema.skills.publishedAt} IS NOT NULL`,
    ];
    if (category && CATEGORIES.includes(category)) {
        conditions.push(eq(schema.skills.category, category));
    }
    if (q) {
        const escaped = `%${String(q).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        conditions.push(or(
            ilike(schema.skills.title, escaped),
            ilike(schema.skills.content, escaped),
            ilike(schema.skills.category, escaped),
        ));
    }

    const orderBy = MARKET_SORTS[sort] || MARKET_SORTS.hot;
    const offset = (Math.max(1, Number(page) || 1) - 1) * pageSize;

    const listResult = await db
        .select()
        .from(schema.skills)
        .where(and(...conditions))
        .orderBy(orderBy)
        .limit(pageSize)
        .offset(offset);

    const countResult = await db
        .select({ total: sql`count(*)::int` })
        .from(schema.skills)
        .where(and(...conditions));

    const total = Number(countResult[0]?.total ?? 0);
    const items = listResult.map(mapRow).map((s) => {
        if (excludeUserId && s.userId === excludeUserId) {
            return { ...s, isMine: true };
        }
        return s;
    });

    return { items, total, page: Math.max(1, Number(page) || 1), pageSize };
}

/**
 * 安装：复制公开 skill 为当前用户私有 draft。
 */
async function installSkill(userId, skillId) {
    const source = await getSkill(userId, skillId, { allowPublic: true });
    if (source.visibility !== 'public' || source.publishedAt == null) {
        const err = new Error('skill not found');
        err.code = 'skill_not_found';
        err.statusCode = 404;
        throw err;
    }

    const id = newSkillId();
    const now = Date.now();
    await db.transaction(async (tx) => {
        await tx.insert(schema.skills).values({
            id,
            userId,
            projectId: null,
            sessionId: null,
            title: source.title,
            content: source.content,
            tags: source.tags,
            status: 'draft',
            source: 'installed',
            confidence: source.confidence,
            signals: source.signals,
            category: source.category,
            forkedFrom: source.id,
            visibility: 'private',
            installCount: 0,
            usageCount: 0,
            clusterSize: 1,
            createdAt: now,
            updatedAt: now,
        });
        await tx.update(schema.skills)
            .set({ installCount: sql`${schema.skills.installCount} + 1`, updatedAt: now })
            .where(eq(schema.skills.id, source.id));
    });

    return getSkill(userId, id);
}

/**
 * 导出（供 Admin 漏斗统计等扩展）。
 */
async function countByStatus(userId) {
    const rows = await db
        .select({ status: schema.skills.status, count: sql`count(*)::int` })
        .from(schema.skills)
        .where(eq(schema.skills.userId, userId))
        .groupBy(schema.skills.status);
    return rows.reduce((acc, r) => { acc[r.status] = Number(r.count); return acc; }, {});
}

/**
 * 统计 auto draft 未读数（FR-4.5）：
 * status='draft' AND source='auto' AND created_at > lastSeenAt。
 * @param {string} userId
 * @param {number|null} lastSeenAt 用户偏好里的最近查看时间；null → 全部 auto draft 计数
 * @returns {Promise<number>}
 */
async function countUnseenAutoDrafts(userId, lastSeenAt) {
    const conditions = [
        eq(schema.skills.userId, userId),
        eq(schema.skills.status, 'draft'),
        eq(schema.skills.source, 'auto'),
    ];
    if (lastSeenAt != null) {
        conditions.push(sql`${schema.skills.createdAt} > ${lastSeenAt}`);
    }
    const rows = await db
        .select({ count: sql`count(*)::int` })
        .from(schema.skills)
        .where(and(...conditions));
    return Number(rows[0]?.count ?? 0);
}

/**
 * 读取用户偏好里的 drafts 最近查看时间（key=skills_drafts_last_seen_at）。
 * @param {string} userId
 * @returns {Promise<number|null>}
 */
async function getDraftsLastSeenAt(userId) {
    const prefs = require('../admin/UserPreferences');
    const all = await prefs.getPreferences(userId).catch(() => ({}));
    const raw = all.skills_drafts_last_seen_at;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 写入 drafts 最近查看时间（key=skills_drafts_last_seen_at）。
 * @param {string} userId
 */
async function markDraftsSeen(userId) {
    const prefs = require('../admin/UserPreferences');
    await prefs.setPreference(userId, 'skills_drafts_last_seen_at', Date.now());
}

module.exports = {
    CATEGORIES,
    createSkill,
    listMySkills,
    getSkill,
    updateSkill,
    changeStatus,
    deleteSkill,
    publishSkill,
    unpublishSkill,
    listMarket,
    installSkill,
    countByStatus,
    countUnseenAutoDrafts,
    getDraftsLastSeenAt,
    markDraftsSeen,
};
