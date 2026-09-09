/**
 * Skills 服务（P3 市场 MVP）：CRUD + 状态机 + 发布/下架 + 安装复制 + 市场查询。
 *
 * 市场语义：
 * - visibility='public' 且 published_at 非空 => 在市场中可见
 * - 安装 = 复制一份为当前用户的私有 draft（source='installed', forked_from 记录来源），
 *   原 skill.install_count +1
 * - 状态机：draft → active → archived（archived 可 restore 回 active）
 */

const { randomBytes, createHash } = require('crypto');
const path = require('path');
const { and, eq, desc, sql, or, ilike, inArray } = require('drizzle-orm');
const { db } = require('../db');
const schema = require('../db/schema');
const { assertSkillSafe } = require('./skillScriptScanner');

const CATEGORIES = ['workflow', 'convention', 'debug', 'database', 'devops', 'codegen'];

const STATUS_TRANSITIONS = {
    draft: { activate: 'active' },
    active: { archive: 'archived' },
    archived: { restore: 'active' },
};

// 0020 脚本级 Skill：路径白名单（scripts/*，禁 `..` 穿越）、扩展名白名单、大小/数量上限
const SCRIPT_PATH_RE = /^scripts\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCRIPT_EXT_RE = /\.(sh|bash|py|js|mjs|ts|ps1|sql)$/;
const MAX_SCRIPTS = 3;
const MAX_SCRIPT_BYTES = 32768;

function newSkillId() {
    return `skl_${randomBytes(8).toString('hex')}`;
}

/**
 * 计算技能内容哈希（content + scripts），用于 forkedFrom 更新检测。
 */
function computeSourceHash(content, scripts = []) {
    const payload = `${String(content || '')}\u0000${JSON.stringify(Array.isArray(scripts) ? scripts : [])}`;
    return createHash('sha256').update(payload).digest('hex');
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

/**
 * 0020 校验并归一化脚本列表（服务端边界，与 extractor 校验一致）。
 * 丢弃非法项（路径穿越 / 扩展名不白名单 / 超限 / 空内容），保留前 MAX_SCRIPTS 项。
 */
function parseScripts(scripts) {
    if (!Array.isArray(scripts)) return [];
    const out = [];
    for (const s of scripts) {
        if (!s || typeof s !== 'object') continue;
        const pathVal = String(s.path || '').trim();
        const contentVal = String(s.content || '');
        if (!SCRIPT_PATH_RE.test(pathVal)) continue;
        if (!SCRIPT_EXT_RE.test(pathVal)) continue;
        if (!contentVal || Buffer.byteLength(contentVal, 'utf8') > MAX_SCRIPT_BYTES) continue;
        out.push({ path: pathVal, content: contentVal });
        if (out.length >= MAX_SCRIPTS) break;
    }
    return out;
}

function parseDescription(content) {
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(String(content || ''));
    if (!m) return '';
    const dm = /^description:\s*(.+)$/m.exec(m[1]);
    return dm ? dm[1].trim().replace(/^["']|["']$/g, '') : '';
}

/**
 * 市场列表裁剪：不返回 content/scripts 全文（详情走 getSkill）。
 */
function mapMarketRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.userId,
        title: row.title,
        description: parseDescription(row.content),
        tags: Array.isArray(row.tags) ? row.tags : [],
        category: row.category ?? null,
        installCount: row.installCount ?? 0,
        publishedAt: row.publishedAt ?? null,
        sourceHash: row.sourceHash ?? null,
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
    };
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
        scripts: Array.isArray(row.scripts) ? row.scripts : [],
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
        sourceHash: row.sourceHash ?? null,
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
async function createSkill({ userId, title, content, tags = [], category = null, projectId = null, sessionId = null, source = 'manual', signals = null, confidence = null, scripts = null }) {
    const { title: t, content: c } = validateCreate({ title, content });
    // P0 安全治理：创建入口静态扫描（error 级阻断，warning 级随返回值提示）
    const scriptWarnings = assertSkillSafe({ content: c, scripts: parseScripts(scripts) });
    const id = newSkillId();
    const now = Date.now();
    await db.insert(schema.skills).values({
        id,
        userId,
        projectId: projectId || null,
        sessionId: sessionId || null,
        title: t,
        content: c,
        scripts: parseScripts(scripts),
        tags: parseTags(tags),
        status: 'draft',
        // 0022：支持外部导入 source='external'；其余归 auto/manual
        source: ['auto', 'external'].includes(source) ? source : 'manual',
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
    const skill = await getSkill(userId, id);
    if (scriptWarnings.length > 0) skill.scriptWarnings = scriptWarnings;
    return skill;
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
    const items = rows.map(mapRow);
    // 安装技能标注源更新状态（P2 forkedFrom 更新检测）
    for (const item of items) {
        if (item.source !== 'installed' || !item.forkedFrom) continue;
        // 旧数据回填：安装时 sourceHash 缺失则从源计算并补写
        if (!item.sourceHash) {
            try {
                const src = await getSkill(userId, item.forkedFrom, { allowPublic: true });
                const hash = computeSourceHash(src.content, src.scripts);
                await db.update(schema.skills)
                    .set({ sourceHash: hash, updatedAt: Date.now() })
                    .where(eq(schema.skills.id, item.id));
                item.sourceHash = hash;
            } catch (_) { /* 源不可达则跳过 */ }
        }
        const info = await checkInstallUpdate(userId, item);
        if (info) item.updateInfo = info;
    }
    return items;
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
    if (allowPublic && skill.visibility === 'public' && skill.publishedAt != null) {
        return attachAuthorName(skill);
    }
    const err = new Error('skill not found');
    err.code = 'skill_not_found';
    err.statusCode = 404;
    throw err;
}

/**
 * 给 skill 附上作者展示名（displayName || username）。
 */
async function attachAuthorName(skill) {
    if (!skill || !skill.userId) return skill;
    const rows = await db
        .select({ displayName: schema.users.displayName, username: schema.users.username })
        .from(schema.users)
        .where(eq(schema.users.id, skill.userId))
        .limit(1);
    const u = rows[0];
    if (u) skill.authorName = u.displayName || u.username || null;
    return skill;
}

/**
 * 编辑 skill（仅本人）。不改变 status/visibility。
 */
async function updateSkill(userId, skillId, patch = {}) {
    const skill = await getSkill(userId, skillId);
    requireOwner(skill, userId);

    if (skill.status === 'active') {
        const err = new Error('active skills cannot be edited (archive the skill first)');
        err.statusCode = 409;
        throw err;
    }
    if (skill.source === 'installed') {
        const err = new Error('installed skills cannot be edited (sync from source instead)');
        err.statusCode = 409;
        throw err;
    }

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
    if (patch.scripts !== undefined) next.scripts = parseScripts(patch.scripts);
    if (patch.category !== undefined) next.category = CATEGORIES.includes(patch.category) ? patch.category : null;
    if (patch.projectId !== undefined) next.projectId = patch.projectId || null;
    next.updatedAt = Date.now();

    // P0 安全治理：编辑入口按合并后的最终内容扫描
    const scriptWarnings = assertSkillSafe({
        content: next.content ?? skill.content,
        scripts: next.scripts ?? skill.scripts,
    });

    const oldProjectId = skill.projectId || null;
    await db.update(schema.skills)
        .set(next)
        .where(and(eq(schema.skills.id, skillId), eq(schema.skills.userId, userId)));

    // T4.4：内容/作用域变更后重渲染指令文件（无 running session 的项目）
    const newSkill = await getSkill(userId, skillId);
    if (scriptWarnings.length > 0) newSkill.scriptWarnings = scriptWarnings;
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

    // 0021：激活（draft→active）时做落盘门槛校验——格式合法 + 置信度阈值。
    // 只有能落盘的技能才允许激活，避免低质量/非法格式污染 Agent 目录。
    if (action === 'activate') {
        const { isLandableSkill } = require('./skillInjector');
        if (!isLandableSkill({ ...skill, status: nextStatus })) {
            const err = new Error('skill does not meet landing requirements (valid SKILL.md frontmatter with name/description; auto skills need confidence >= threshold)');
            err.code = 'skill_not_landable';
            err.statusCode = 400;
            throw err;
        }
    }

    const setData = { status: nextStatus, updatedAt: Date.now() };
    // 归档自动下架：避免 archived 仍留在市场卖旧内容
    if (nextStatus === 'archived') {
        setData.visibility = 'private';
        setData.publishedAt = null;
    }
    await db.update(schema.skills)
        .set(setData)
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
 * 发布到市场（本人）。仅 active 技能可发布，发布后 visibility=public。
 */
async function publishSkill(userId, skillId) {
    const skill = await getSkill(userId, skillId);
    requireOwner(skill, userId);
    // P0-2：draft/archived 不得直接上架——半成品（LLM 提炼失败的 draft）或
    // 已归档技能必须先走 activate 流程，保证市场内容都经过落盘门槛。
    if (skill.status !== 'active') {
        const err = new Error('only active skills can be published to the market (activate the skill first)');
        err.code = 'skill_publish_requires_active';
        err.statusCode = 400;
        throw err;
    }
    if (skill.source === 'installed') {
        const err = new Error('installed skills cannot be published to the market');
        err.code = 'skill_publish_installed';
        err.statusCode = 400;
        throw err;
    }
    // 0021/P2：发布门槛——只有能落盘的技能才允许上架（格式合法 + 置信度达标），
    // 避免低质量 auto draft 或非法格式直接进公共市场。
    const { isLandableSkill } = require('./skillInjector');
    if (!isLandableSkill(skill)) {
        const err = new Error('skill does not meet landing requirements (valid SKILL.md frontmatter with name/description; auto skills need confidence >= threshold)');
        err.code = 'skill_not_landable';
        err.statusCode = 400;
        throw err;
    }
    // P0-1：发布时对最终内容+脚本再做一次静态扫描（防御纵深：创建/导入后的
    // 编辑可能引入新载荷）。
    assertSkillSafe({ content: skill.content, scripts: skill.scripts });
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
    'hot': [desc(schema.skills.installCount), desc(schema.skills.publishedAt)],
    'newest': [desc(schema.skills.publishedAt), desc(schema.skills.installCount)],
    'installs': [desc(schema.skills.installCount), desc(schema.skills.publishedAt)],
    'default': [desc(schema.skills.publishedAt), desc(schema.skills.installCount)],
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
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset(offset);

    const countResult = await db
        .select({ total: sql`count(*)::int` })
        .from(schema.skills)
        .where(and(...conditions));

    const total = Number(countResult[0]?.total ?? 0);
    const items = listResult.map(mapMarketRow).map((s) => {
        if (excludeUserId && s.userId === excludeUserId) {
            return { ...s, isMine: true };
        }
        return s;
    });

    // P2：当前用户已安装/有更新标记——市场卡片展示「已安装」「有更新」角标。
    // hasUpdate = 已安装副本的 sourceHash ≠ 源当前 sourceHash（源发布后被编辑过）。
    if (excludeUserId && items.length > 0) {
        const sourceIds = items.map((s) => s.id);
        const forkRows = await db
            .select({ id: schema.skills.id, forkedFrom: schema.skills.forkedFrom, sourceHash: schema.skills.sourceHash })
            .from(schema.skills)
            .where(and(
                eq(schema.skills.userId, excludeUserId),
                inArray(schema.skills.forkedFrom, sourceIds),
            ));
        const forkMap = new Map(forkRows.map((f) => [f.forkedFrom, { id: f.id, sourceHash: f.sourceHash }]));
        // 用原始行（含 content/scripts）做 hash 比较，避免 mapMarketRow 丢失字段
        const sourceMap = new Map(listResult.map((r) => [r.id, r]));
        for (const s of items) {
            if (!forkMap.has(s.id)) continue;
            const src = sourceMap.get(s.id);
            if (!src) continue;
            s.isInstalled = true;
            const fork = forkMap.get(s.id);
            let forkHash = fork.sourceHash;
            if (!forkHash) {
                forkHash = computeSourceHash(src.content, src.scripts);
                await db.update(schema.skills)
                    .set({ sourceHash: forkHash, updatedAt: Date.now() })
                    .where(eq(schema.skills.id, fork.id));
                s.hasUpdate = false;
            } else {
                s.hasUpdate = forkHash !== computeSourceHash(src.content, src.scripts);
            }
        }
    }

    // 作者展示名（displayName || username），避免向市场暴露内部 userId
    const authorIds = [...new Set(items.map((s) => s.userId).filter(Boolean))];
    const authorMap = new Map();
    if (authorIds.length > 0) {
        const authorRows = await db
            .select({ id: schema.users.id, displayName: schema.users.displayName, username: schema.users.username })
            .from(schema.users)
            .where(inArray(schema.users.id, authorIds));
        for (const u of authorRows) authorMap.set(u.id, u.displayName || u.username || u.id);
    }
    for (const s of items) {
        s.authorName = authorMap.get(s.userId) || null;
    }

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
    // 自装拦截：不能安装自己发布的技能
    if (source.userId === userId) {
        const err = new Error('cannot install your own skill');
        err.code = 'skill_cannot_install_own';
        err.statusCode = 400;
        throw err;
    }
    // 每用户去重：已安装过同一来源则直接返回副本，不重复落库/计数
    const existing = await db
        .select()
        .from(schema.skills)
        .where(and(
            eq(schema.skills.userId, userId),
            eq(schema.skills.forkedFrom, source.id),
        ))
        .limit(1);
    if (existing[0]) {
        const existingSkill = mapRow(existing[0]);
        if (!existingSkill.sourceHash) {
            const hash = computeSourceHash(source.content, source.scripts);
            await db.update(schema.skills)
                .set({ sourceHash: hash, updatedAt: Date.now() })
                .where(eq(schema.skills.id, existingSkill.id));
            existingSkill.sourceHash = hash;
        }
        return existingSkill;
    }

    const id = newSkillId();
    const now = Date.now();
    const sourceHash = computeSourceHash(source.content, source.scripts);
    await db.transaction(async (tx) => {
        await tx.insert(schema.skills).values({
            id,
            userId,
            projectId: null,
            sessionId: null,
            title: source.title,
            content: source.content,
            scripts: Array.isArray(source.scripts) ? source.scripts : [],
            tags: source.tags,
            status: 'draft',
            source: 'installed',
            confidence: source.confidence,
            signals: source.signals,
            category: source.category,
            forkedFrom: source.id,
            sourceHash,
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
 * 同步已安装技能到源的最新版本（内容/脚本/tags/category）。
 * 仅允许 source='installed' 且有 forked_from 的技能。
 */
async function syncSkillFromSource(userId, skillId) {
    const skill = await getSkill(userId, skillId);
    requireOwner(skill, userId);
    if (skill.source !== 'installed' || !skill.forkedFrom) {
        const err = new Error('only installed skills can be synced');
        err.code = 'skill_not_syncable';
        err.statusCode = 400;
        throw err;
    }
    const source = await getSkill(userId, skill.forkedFrom, { allowPublic: true });
    if (source.visibility !== 'public' || source.publishedAt == null) {
        const err = new Error('source skill is no longer public');
        err.code = 'skill_source_unavailable';
        err.statusCode = 404;
        throw err;
    }
    const sourceHash = computeSourceHash(source.content, source.scripts);
    await db.update(schema.skills)
        .set({
            title: source.title,
            content: source.content,
            scripts: Array.isArray(source.scripts) ? source.scripts : [],
            tags: source.tags,
            category: source.category,
            sourceHash,
            updatedAt: Date.now(),
        })
        .where(and(eq(schema.skills.id, skillId), eq(schema.skills.userId, userId)));

    const updated = await getSkill(userId, skillId);
    await reRenderAfterSkillChange(userId, updated.projectId || null);
    return updated;
}

/**
 * 检测安装技能的源是否有更新（对比 source_hash）。
 * 返回 { hasUpdate, sourceTitle, sourceUpdatedAt } 或 null（无源/非安装技能）。
 */
async function checkInstallUpdate(userId, skill) {
    if (skill.source !== 'installed' || !skill.forkedFrom) return null;
    let source = null;
    try {
        source = await getSkill(userId, skill.forkedFrom, { allowPublic: true });
    } catch (_) {
        return { hasUpdate: false, sourceAvailable: false };
    }
    if (source.visibility !== 'public' || source.publishedAt == null) {
        return { hasUpdate: false, sourceAvailable: false };
    }
    const sourceHash = computeSourceHash(source.content, source.scripts);
    return {
        hasUpdate: sourceHash !== (skill.sourceHash || null),
        sourceAvailable: true,
        sourceTitle: source.title,
        sourceUpdatedAt: Number(source.updatedAt),
    };
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

// ---------------------------------------------------------------------------
// 本地技能目录导入（A：支持外部开源技能安装，本地路径扫描）
// ---------------------------------------------------------------------------

const { readFile, readdir } = require('fs/promises');

const IMPORT_MAX_DIR_DEPTH = 6;
const IMPORT_MAX_DIRS = 200;
const IMPORT_MAX_SCRIPTS = 10;
const IMPORT_MAX_SCRIPT_BYTES = 65536;
const IMPORT_MAX_FILES = 500;       // 0024：上传文件总数上限
const IMPORT_MAX_FILE_BYTES = 262144; // 0024：单文件上限 256KB
// 导入允许的脚本扩展名（与 scripts 白名单一致 + 常见开源技能格式）
const IMPORT_SCRIPT_EXT_RE = /\.(sh|bash|py|js|mjs|ts|ps1|sql|zsh)$/;
// 合法 frontmatter：name + description 都必填
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;

function parseFrontmatter(content) {
    const m = FRONTMATTER_RE.exec(String(content || ''));
    if (!m) return null;
    const yaml = m[1];
    const name = /^name:\s*(.+)$/m.exec(yaml)?.[1]?.trim().replace(/^["']|["']$/g, '');
    const description = /^description:\s*(.+)$/m.exec(yaml)?.[1]?.trim().replace(/^["']|["']$/g, '');
    if (!name || !description) return null;
    return { name, description };
}

/**
 * 0022：从本地目录导入符合 Agent Skills 目录标准的技能。
 * - 输入 dirPath：技能目录的父目录（含一个或多个 <name>/SKILL.md 子目录），或直接指向技能目录本身
 * - 校验：SKILL.md 存在 + frontmatter 含 name/description + 目录名与 name 匹配
 * - scripts：复制 <name>/scripts/* 白名单扩展名脚本（≤10 个 / 单个 ≤64KB）
 * - 落库：source='external'，status='draft'（激活后由注入器落盘到 Agent 目录）
 *
 * @param {string} userId
 * @param {string} dirPath 本地目录绝对路径（服务端可见）
 * @returns {Promise<Array<object>>} 导入成功的技能列表
 */
async function importSkillFromPath(userId, dirPath) {
    if (!dirPath || typeof dirPath !== 'string') {
        const err = new Error('dirPath is required');
        err.code = 'skill_import_invalid';
        err.statusCode = 400;
        throw err;
    }
    const root = path.resolve(dirPath);
    const skillDirs = [];
    // 优先支持「传入目录本身即技能目录」（根含 SKILL.md）；
    // 否则按「父目录下每个子目录一个 SKILL.md」的批量结构扫描。
    const rootHasSkillMd = await readFile(path.join(root, 'SKILL.md'), 'utf8').catch(() => null);
    if (rootHasSkillMd) {
        skillDirs.push(root);
    } else {
        await walkSkillDirs(root, 0, skillDirs);
    }
    if (skillDirs.length === 0) {
        const err = new Error(`no skill directories found under ${root}`);
        err.code = 'skill_import_not_found';
        err.statusCode = 404;
        throw err;
    }

    const imported = [];
    const blocked = [];
    for (const skillDir of skillDirs) {
        const skillMdPath = path.join(skillDir, 'SKILL.md');
        const content = await readFile(skillMdPath, 'utf8').catch(() => null);
        if (!content) continue;
        const fm = parseFrontmatter(content);
        if (!fm) continue;
        const dirName = path.basename(skillDir);
        // 目录名需与 name 匹配（宽松：去掉空格/连字符差异后，目录名包含 name 即视为匹配——
        // 兼容 `dev-expert-1.0.52`（含版本号）等带后缀的打包目录）
        const nd = normalizeName(dirName);
        const nn = normalizeName(fm.name);
        if (!nd || !nn || !nd.includes(nn)) continue;

        const scripts = [];
        const scriptsDir = path.join(skillDir, 'scripts');
        const scriptEntries = await readdir(scriptsDir, { withFileTypes: true }).catch(() => []);
        for (const entry of scriptEntries) {
            if (!entry.isFile()) continue;
            if (!IMPORT_SCRIPT_EXT_RE.test(entry.name)) continue;
            const scriptPath = path.join(scriptsDir, entry.name);
            const scriptContent = await readFile(scriptPath, 'utf8').catch(() => '');
            if (!scriptContent) continue;
            if (Buffer.byteLength(scriptContent, 'utf8') > IMPORT_MAX_SCRIPT_BYTES) continue;
            scripts.push({ path: `scripts/${entry.name}`, content: scriptContent });
            if (scripts.length >= IMPORT_MAX_SCRIPTS) break;
        }

        try {
            const skill = await createSkill({
                userId,
                title: fm.name,
                content,
                scripts,
                category: null,
                source: 'external',
                confidence: null,
            });
            imported.push(skill);
        } catch (err) {
            // P0 安全治理：安全扫描命中的技能跳过（不中断整批导入），明细随返回值告知用户
            if (err.code === 'skill_script_blocked') {
                blocked.push({ name: fm.name, findings: err.details || [] });
                continue;
            }
            throw err;
        }
    }
    if (imported.length === 0) {
        if (blocked.length > 0) {
            const err = new Error(`all imported skills blocked by security scan (${blocked.map((b) => b.name).join(', ')})`);
            err.code = 'skill_import_blocked';
            err.statusCode = 400;
            err.details = blocked;
            throw err;
        }
        const err = new Error('no valid skills found (need SKILL.md with name+description, dir name matching)');
        err.code = 'skill_import_invalid';
        err.statusCode = 400;
        throw err;
    }
    return { imported, blocked };
}

async function walkSkillDirs(dir, depth, acc) {
    if (depth > IMPORT_MAX_DIR_DEPTH || acc.length > IMPORT_MAX_DIRS) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = path.join(dir, entry.name);
        const hasSkillMd = await readFile(path.join(child, 'SKILL.md'), 'utf8').catch(() => null);
        if (hasSkillMd) {
            acc.push(child);
        } else {
            await walkSkillDirs(child, depth + 1, acc);
        }
        if (acc.length > IMPORT_MAX_DIRS) return;
    }
}

function normalizeName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '').trim();
}

/**
 * 0024：从浏览器上传的文件列表导入技能（无需服务端可见路径）。
 *
 * 浏览器通过 <input webkitdirectory> 选中本地文件夹后，把「相对路径+内容」
 * 作为 JSON 上传，本函数在服务端临时目录重建目录结构，再复用
 * importSkillFromPath 完成扫描/校验/落库。安全：相对路径禁止绝对路径与
 * `..` 穿越；单文件大小受限；总数受限。
 *
 * @param {string} userId
 * @param {Array<{path: string, content: string}>} files
 * @returns {Promise<Array<object>>} 导入成功的技能列表
 */
async function importSkillFromUpload(userId, files) {
    const os = require('os');
    const fsp = require('fs/promises');
    const list = Array.isArray(files) ? files : [];
    if (list.length === 0) {
        const err = new Error('files are required');
        err.code = 'skill_import_invalid';
        err.statusCode = 400;
        throw err;
    }
    if (list.length > IMPORT_MAX_FILES) {
        const err = new Error(`too many files (max ${IMPORT_MAX_FILES})`);
        err.code = 'skill_import_invalid';
        err.statusCode = 400;
        throw err;
    }
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'xensemble-skill-import-'));
    try {
        for (const f of list) {
            const rel = String(f?.path ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
            if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue; // 防穿越
            const content = String(f?.content ?? '');
            if (Buffer.byteLength(content, 'utf8') > IMPORT_MAX_FILE_BYTES) continue;
            const dest = path.join(tmp, rel);
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            await fsp.writeFile(dest, content, 'utf8');
        }
        return await importSkillFromPath(userId, tmp);
    } finally {
        await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
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
    syncSkillFromSource,
    checkInstallUpdate,
    computeSourceHash,
    countByStatus,
    countUnseenAutoDrafts,
    getDraftsLastSeenAt,
    markDraftsSeen,
    importSkillFromPath,
    importSkillFromUpload,
    parseFrontmatter,
    normalizeName,
};
