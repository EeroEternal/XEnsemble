/**
 * Skill injector (P4) —— 把 active skills 渲染进 workspace 指令文件。
 *
 * 设计对齐 02-技术设计规格 §7：
 * - 注入段格式（幂等）：
 *     <!-- xe-skills:start -->
 *     ## XEnsemble Skills
 *
 *     ### <skill title>
 *     <skill content>
 *
 *     <!-- xe-skills:end -->
 * - 渲染 = 读文件 → 已有标记段整段替换，否则追加末尾；文件不存在 → 仅标记段
 * - 安全：content 过滤 HTML 注释（`<!--`/`-->` 转义）防伪造提前闭合
 * - 排序：usage_count DESC, updated_at DESC；截断 SKILL_INJECT_MAX_COUNT 条 / SKILL_INJECT_MAX_BYTES 字节
 * - 截断时写 events 审计（type: skill_inject_truncated）
 *
 * 写入边界：Local/BoxLite 的 workspace 目录在控制面可见（workspace.js projectDir），
 * 默认用本地 fs 直写；BoxLite workspace 不在控制面本地 FS 时由调用方注入 fsAdapter。
 */

const { and, eq, or, isNull, inArray, sql } = require('drizzle-orm');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const schema = require('../db/schema');
const workspace = require('../workspace');
const { getInstructionFile } = require('../agents/defaultAgents');
const { recordEvent } = require('../events/recordEvent');

const SECTION_START = '<!-- xe-skills:start -->';
const SECTION_END = '<!-- xe-skills:end -->';
const SECTION_TITLE = '## XEnsemble Skills';

function isEnabled() {
    return process.env.SKILL_INJECT_ENABLED === 'true';
}

function maxCount() {
    return Number(process.env.SKILL_INJECT_MAX_COUNT) || 10;
}

function maxBytes() {
    return Number(process.env.SKILL_INJECT_MAX_BYTES) || 8192;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/**
 * 过滤 HTML 注释：`<!--` → `\<!--`、`-->` → `--\>`，防用户编辑注入伪造
 * `xe-skills:end` 提前闭合标记段（02 §7.4）。
 */
function sanitizeContent(content) {
    return String(content || '')
        .replace(/<!--/g, '\\<!--')
        .replace(/-->/g, '--\\>');
}

/**
 * 渲染技能注入段（02 §7.3）。
 * @param {Array} skills skills 行（需含 id/title/content/usageCount/updatedAt）
 * @returns {{ section: string, truncated: boolean, count: number, skillIds: string[] }}
 */
function renderSkillsSection(skills) {
    const countLimit = maxCount();
    const byteLimit = maxBytes();
    const sorted = [...skills].sort((a, b) => {
        const diff = (Number(b.usageCount) || 0) - (Number(a.usageCount) || 0);
        if (diff !== 0) return diff;
        return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
    });

    const parts = [SECTION_START, '', SECTION_TITLE, ''];
    let truncated = false;
    let count = 0;
    let bytes = 0;
    const skillIds = [];

    for (const s of sorted) {
        if (count >= countLimit) { truncated = true; break; }
        const block = `### ${s.title}\n${sanitizeContent(s.content)}\n`;
        const blockBytes = Buffer.byteLength(block, 'utf8');
        if (bytes + blockBytes > byteLimit) { truncated = true; break; }
        parts.push(block);
        bytes += blockBytes;
        count += 1;
        if (s.id) skillIds.push(s.id);
    }

    parts.push(SECTION_END);
    return { section: parts.join('\n'), truncated, count, skillIds };
}

/**
 * 应用注入段到现有文件内容（幂等）。
 * - 已有标记段 → 整段替换（段外内容不动）
 * - 无标记段 → 追加到末尾
 * - 空文件 → 仅注入段
 * @param {string|null} existing 现有内容；null/undefined 视为文件不存在
 * @param {string} section 渲染后的注入段
 * @returns {string}
 */
function applyToContent(existing, section) {
    const text = existing == null ? '' : String(existing);
    const startIdx = text.indexOf(SECTION_START);
    const endIdx = text.indexOf(SECTION_END);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        const before = text.slice(0, startIdx);
        const after = text.slice(endIdx + SECTION_END.length);
        return `${before}${section}${after}`;
    }
    const trimmed = text.replace(/\s*$/, '');
    if (!trimmed) return `${section}\n`;
    return `${trimmed}\n\n${section}\n`;
}

/**
 * 移除已有注入段（active skills 清零时调用，02 §7 幂等语义）。
 * 段外用户内容保持不变，仅去掉标记段并压缩多余空行。
 * @param {string|null} existing
 * @returns {string}
 */
function removeSection(existing) {
    const text = existing == null ? '' : String(existing);
    const startIdx = text.indexOf(SECTION_START);
    const endIdx = text.indexOf(SECTION_END);
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return text;
    const before = text.slice(0, startIdx);
    const after = text.slice(endIdx + SECTION_END.length);
    return (before + after)
        .replace(/[ \t]*\n{3,}/g, '\n\n')
        .replace(/\n{2,}$/, '\n');
}

// ---------------------------------------------------------------------------
// 默认本地 fs 适配器（Local provider / 控制面可见 workspace）
// ---------------------------------------------------------------------------

const localFs = {
    async readFile(rootDir, relPath) {
        const p = path.join(rootDir, relPath);
        try {
            return await fs.promises.readFile(p, 'utf8');
        } catch {
            return null;
        }
    },
    async writeFile(rootDir, relPath, content) {
        const p = path.join(rootDir, relPath);
        await fs.promises.mkdir(path.dirname(p), { recursive: true });
        await fs.promises.writeFile(p, content, 'utf8');
    },
};

/**
 * 查询某用户在某项目作用域下可注入的 active skills（项目级 + 用户全局）。
 */
async function listActiveSkills(userId, projectId) {
    const conditions = [
        eq(schema.skills.userId, userId),
        eq(schema.skills.status, 'active'),
    ];
    if (projectId) {
        conditions.push(or(eq(schema.skills.projectId, projectId), isNull(schema.skills.projectId)));
    } else {
        conditions.push(isNull(schema.skills.projectId));
    }
    return db
        .select()
        .from(schema.skills)
        .where(and(...conditions));
}

/**
 * 为一次会话注入 skills 到 workspace 指令文件。
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string|null} opts.projectId
 * @param {string} opts.agentId 决定指令文件名（getInstructionFile）
 * @param {string} opts.workspacePath workspace 根目录
 * @param {object} [opts.fsAdapter] { readFile(rootDir,relPath), writeFile(rootDir,relPath,content) }；
 *   默认本地 fs。BoxLite workspace 不在控制面 FS 时由调用方注入（T4.3 边界）
 * @param {boolean} [opts.bumpUsage] 注入成功后对入选 skills 批量 usage_count+1（默认 true）
 * @returns {Promise<{ injected: boolean, reason?: string, instructionFile?: string, count?: number, truncated?: boolean, skillIds?: string[] }>}
 */
async function injectForSession({ userId, projectId, agentId, workspacePath, fsAdapter, bumpUsage = true }) {
    if (!isEnabled()) return { injected: false, reason: 'disabled' };

    const skills = await listActiveSkills(userId, projectId);
    if (skills.length === 0) return { injected: false, reason: 'no_active_skills' };

    const instructionFile = getInstructionFile(agentId);
    const { section, truncated, count, skillIds } = renderSkillsSection(skills);
    const adapter = fsAdapter || localFs;

    const existing = await adapter.readFile(workspacePath, instructionFile);
    const next = applyToContent(existing, section);
    await adapter.writeFile(workspacePath, instructionFile, next);

    // T4.3：注入成功后对入选 skills 批量 usage_count+1（审计/计数失败不阻断）
    if (bumpUsage && skillIds.length > 0) {
        try {
            await db.update(schema.skills)
                .set({ usageCount: sql`${schema.skills.usageCount} + 1`, updatedAt: Date.now() })
                .where(inArray(schema.skills.id, skillIds));
        } catch (_) { /* 计数失败不阻断注入 */ }
    }

    if (truncated) {
        try {
            await recordEvent({
                userId,
                projectId: projectId || null,
                subjectType: 'skill',
                subjectId: agentId,
                type: 'skill_inject_truncated',
                data: { count, maxCount: maxCount(), maxBytes: maxBytes() },
            });
        } catch (_) { /* 审计失败不影响注入 */ }
    }

    return { injected: true, instructionFile, count, truncated, skillIds };
}

// ---------------------------------------------------------------------------
// T4.4：skill 状态/内容变更后重渲染（无 running session 的项目）
// ---------------------------------------------------------------------------

/**
 * 技能变更后对受影响项目重渲染指令文件。
 * - skill 带 projectId → 只重渲染该项目；skill 全局（projectId null）→ 重渲染该用户所有项目
 * - 有 running session 的项目跳过（下次 spawn 自然更新，避免与 Agent 读文件竞争）
 * - 有 active skills → 写/更新标记段；无 active skills → 移除标记段（归档后消失）
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string|null} opts.projectId skill 的项目作用域（null = 全局）
 * @param {object} [opts.fsAdapter]
 * @returns {Promise<{ reRendered: number, reason?: string }>}
 */
async function reRenderForSkillChange({ userId, projectId = null, fsAdapter }) {
    if (!isEnabled()) return { reRendered: 0, reason: 'disabled' };
    const adapter = fsAdapter || localFs;

    // 确定候选项目
    let projectIds = [];
    if (projectId) {
        projectIds = [projectId];
    } else {
        const rows = await db
            .select({ id: schema.projects.id })
            .from(schema.projects)
            .where(eq(schema.projects.userId, userId));
        projectIds = rows.map((r) => r.id);
    }

    let reRendered = 0;
    for (const pid of projectIds) {
        // 有 running/pending session 则跳过（下次 spawn 自然更新）
        const running = await db
            .select({ id: schema.sessions.id })
            .from(schema.sessions)
            .where(and(
                eq(schema.sessions.userId, userId),
                eq(schema.sessions.projectId, pid),
                inArray(schema.sessions.status, ['running', 'pending']),
            ))
            .limit(1);
        if (running.length > 0) continue;

        const skills = await listActiveSkills(userId, pid);
        const wsPath = workspace.projectDir(userId, pid);
        for (const file of ['AGENTS.md', 'CLAUDE.md']) {
            const existing = await adapter.readFile(wsPath, file);
            if (existing == null && skills.length === 0) continue; // 空文件且无技能，无需写
            const next = skills.length > 0
                ? applyToContent(existing, renderSkillsSection(skills).section)
                : removeSection(existing);
            if (next !== existing) {
                await adapter.writeFile(wsPath, file, next);
                reRendered += 1;
            }
        }
    }
    return { reRendered };
}

module.exports = {
    SECTION_START,
    SECTION_END,
    SECTION_TITLE,
    isEnabled,
    maxCount,
    maxBytes,
    sanitizeContent,
    renderSkillsSection,
    applyToContent,
    removeSection,
    listActiveSkills,
    injectForSession,
    reRenderForSkillChange,
    localFs,
};
