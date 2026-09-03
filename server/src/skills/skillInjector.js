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
const { DEFAULT_AGENTS, getSkillTargets } = require('../agents/defaultAgents');
const { recordEvent } = require('../events/recordEvent');

const SECTION_START = '<!-- xe-skills:start -->';
const SECTION_END = '<!-- xe-skills:end -->';
const SECTION_TITLE = '## XEnsemble Skills';
// 0020：脚本级 Skill 落盘根目录（相对 workspace），目录名 = 技能名 slug
const SKILLS_ROOT = '.xensemble/skills';
// 0025（方案 B）：平台自己的技能索引文件（相对 workspace）。
// 索引段不写入用户 AGENTS.md/CLAUDE.md（避免污染用户 git），统一收敛到 .xensemble/ 下。
const PLATFORM_INDEX_FILE = '.xensemble/AGENTS.md';
// 0025：用户指令文件中的一行引导指针（幂等、可移除）。仅当用户文件已存在时写入；
// 用户文件不存在时不创建（避免新增 untracked 污染 changes）。
const POINTER_START = '<!-- xe-skills-pointer:start -->';
const POINTER_END = '<!-- xe-skills-pointer:end -->';
// 0021：全部已注册 Agent 的原生技能目录（去重；用于重渲染时覆盖所有 Agent）
const DEFAULT_AGENT_NATIVE_DIRS = [...new Set(
    DEFAULT_AGENTS.flatMap((a) => a.nativeSkillDirs || []),
)];
// 目录名允许字符（含中文），长度上限；禁止 `..`/空
const DIR_NAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,60}$/;

function isEnabled() {
    // 默认开启（与 SKILL_EXTRACT_ENABLED 同语义：显式 false 才关闭）
    return process.env.SKILL_INJECT_ENABLED !== 'false';
}

function maxCount() {
    return Number(process.env.SKILL_INJECT_MAX_COUNT) || 10;
}

function maxBytes() {
    return Number(process.env.SKILL_INJECT_MAX_BYTES) || 8192;
}

/**
 * 0021：落盘门槛——只有满足条件的 active skill 才写 Agent 目录 / 索引。
 * - 格式校验：content 必须是合法 SKILL.md（frontmatter 含 name + description），
 *   否则写了也会被 Agent 原生解析器拒绝（Claude 对 SKILL.md 硬校验）。
 * - 置信度阈值：source='auto'（自动提炼）需 confidence ≥ SKILL_LAND_MIN_CONFIDENCE（默认 0.5）；
 *   手动/安装的技能用户已确认，不受阈值限制。
 */
function minLandConfidence() {
    const v = Number(process.env.SKILL_LAND_MIN_CONFIDENCE);
    return Number.isFinite(v) ? v : 0.5;
}

function isLandableSkill(skill) {
    if (!skill || skill.status !== 'active') return false;
    // 格式校验：frontmatter 必须含 name 与 description
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(String(skill.content || ''));
    if (!m) return false;
    if (!/^name:\s*\S+/m.test(m[1]) || !/^description:\s*\S+/m.test(m[1])) return false;
    // 自动提炼技能需要置信度阈值
    if (skill.source === 'auto' && (Number(skill.confidence) || 0) < minLandConfidence()) return false;
    return true;
}

/**
 * 0020：技能名 → 安全目录名（保留中英文/数字，其余转 `-`）。
 */
function slugify(name) {
    const slug = String(name || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_-]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return slug && DIR_NAME_RE.test(slug) ? slug : 'skill';
}

/**
 * 0020：校验相对路径可安全写入（防 `..` 穿越），返回安全相对路径。
 * fsAdapter 的 relPath 统一用 posix 分隔符（与 SKILLS_ROOT 拼接保持一致），
 * 显式拒绝任何 `..` 段——避免 Windows path.join 吞掉 `..` 后逃逸检测。
 * @param {string} relPath 如 'scripts/main.sh'
 * @param {string} baseDir 如 'foo'
 */
function safeRel(relPath, baseDir) {
    const str = String(relPath || '');
    if (!str || path.posix.isAbsolute(str)) throw new Error(`unsafe skill path: ${relPath}`);
    const segments = str.split('/');
    if (segments.includes('..') || segments.includes('.')) {
        throw new Error(`unsafe skill path: ${relPath}`);
    }
    const normalized = path.posix.normalize(path.posix.join(baseDir, str));
    if (normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`unsafe skill path: ${relPath}`);
    }
    return normalized;
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
 * 从 SKILL.md frontmatter 提取 description（DB 无独立列，description 存于 YAML 中）。
 */
function parseDescription(content) {
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(String(content || ''));
    if (!m) return '';
    const dm = /^description:\s*(.+)$/m.exec(m[1]);
    return dm ? dm[1].trim() : '';
}

/**
 * 渲染技能注入段（02 §7.3 + 0020 索引形态）。
 *
 * 主指令文件只放索引（name + description + 指向 .xensemble/skills/<slug>/ 的路径），
 * SKILL.md 与 scripts 落盘独立目录——Agent 按 description 命中后再按需读取，
 * 避免多技能全文挤入单文件导致上下文膨胀（渐进式披露）。
 *
 * @param {Array} skills skills 行（需含 id/title/content/description/scripts/usageCount/updatedAt）
 * @returns {{ section: string, truncated: boolean, count: number, skillIds: string[], slugs: string[] }}
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
    const slugs = [];

    for (const s of sorted) {
        if (count >= countLimit) { truncated = true; break; }
        const slug = slugify(s.title);
        const desc = sanitizeContent(parseDescription(s.content) || `Skills 详见 ${SKILLS_ROOT}/${slug}/SKILL.md`);
        const block = `### ${s.title}\n${desc}\n\n详见 ${SKILLS_ROOT}/${slug}/SKILL.md\n`;
        const blockBytes = Buffer.byteLength(block, 'utf8');
        if (bytes + blockBytes > byteLimit) { truncated = true; break; }
        parts.push(block);
        bytes += blockBytes;
        count += 1;
        if (s.id) skillIds.push(s.id);
        slugs.push(slug);
    }

    parts.push(SECTION_END);
    return { section: parts.join('\n'), truncated, count, skillIds, slugs };
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
// 0025（方案 B）：用户指令文件引导指针
// 用户 AGENTS.md/CLAUDE.md 不再承载索引段（避免污染用户 git changes），
// 只放一行指针指向平台索引 .xensemble/AGENTS.md。文件不存在时不创建。
// ---------------------------------------------------------------------------

/**
 * 渲染一行引导指针（幂等标记包裹，可被 removePointer 移除）。
 * @returns {string}
 */
function renderPointer() {
    return `${POINTER_START}\nXEnsemble Skills 索引详见 \`${PLATFORM_INDEX_FILE}\`（技能列表按需加载）\n${POINTER_END}`;
}

/**
 * 把引导指针合并进用户指令文件内容：
 * - 已有指针块 → 整块替换（段外用户内容不动）
 * - 无指针块 → 追加到末尾
 * - existing == null（文件不存在）→ 返回 null，调用方跳过（不创建用户文件）
 * @param {string|null} existing
 * @returns {string|null}
 */
function applyPointer(existing) {
    if (existing == null) return null;
    const text = String(existing);
    const pointer = renderPointer();
    const startIdx = text.indexOf(POINTER_START);
    const endIdx = text.indexOf(POINTER_END);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        const before = text.slice(0, startIdx);
        const after = text.slice(endIdx + POINTER_END.length);
        return `${before}${pointer}${after}`;
    }
    const trimmed = text.replace(/\s*$/, '');
    if (!trimmed) return `${pointer}\n`;
    return `${trimmed}\n\n${pointer}\n`;
}

/**
 * 移除引导指针（无指针时原样返回；existing == null → null）。
 * @param {string|null} existing
 * @returns {string|null}
 */
function removePointer(existing) {
    if (existing == null) return null;
    const text = String(existing);
    const startIdx = text.indexOf(POINTER_START);
    const endIdx = text.indexOf(POINTER_END);
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return text;
    const before = text.slice(0, startIdx);
    const after = text.slice(endIdx + POINTER_END.length);
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
    async chmod(rootDir, relPath, mode) {
        try {
            await fs.promises.chmod(path.join(rootDir, relPath), mode);
        } catch { /* 平台不支持可执行位时忽略 */ }
    },
    async rmrf(rootDir, relPath) {
        try {
            await fs.promises.rm(path.join(rootDir, relPath), { recursive: true, force: true });
        } catch { /* 清理失败不阻断 */ }
    },
    async readDir(rootDir, relPath) {
        try {
            const entries = await fs.promises.readdir(path.join(rootDir, relPath), { withFileTypes: true });
            return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
        } catch {
            return null;
        }
    },
};

// ---------------------------------------------------------------------------
// 0020：脚本级 Skill 目录落盘
// ---------------------------------------------------------------------------

/**
 * 0023：把 SKILL.md frontmatter 的 name 归一化为小写连字符 slug（与目录名一致）。
 * 各 Agent 原生技能目录普遍要求 name 匹配所在目录名（如 OpenCode 强制
 * `^[a-z0-9]+(-[a-z0-9]+)*$`），否则技能会被忽略。slugify(title) 已产出合规
 * 的目录名，这里同步改写 frontmatter name。
 * @param {string} content SKILL.md 全文
 * @param {string} slug 归一化后的目录名
 * @returns {string}
 */
function normalizeFrontmatterName(content, slug) {
    const text = String(content || '');
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
    if (!m) return text;
    const yaml = m[1];
    if (!/^name\s*:/m.test(yaml)) return text;
    const nextYaml = yaml.replace(/^(name\s*:).*$/m, `$1 ${slug}`);
    return text.slice(0, m.index) + `---\n${nextYaml}\n---` + text.slice(m.index + m[0].length);
}

/**
 * 写入单个技能目录：<targetRoot>/<slug>/SKILL.md + <targetRoot>/<slug>/<script.path>。
 * @param {string} [targetRoot] 相对 workspace 的目标根目录（默认 .xensemble/skills）
 * @returns {Promise<string>} 目录相对路径（不含 targetRoot）
 */
async function writeSkillDirectory(adapter, rootDir, skill, targetRoot = SKILLS_ROOT) {
    const slug = slugify(skill.title);
    const dirRel = safeRel(slug, '');
    const content = normalizeFrontmatterName(skill.content, slug);
    await adapter.writeFile(rootDir, path.posix.join(targetRoot, dirRel, 'SKILL.md'), content);
    for (const script of skill.scripts || []) {
        const fileRel = safeRel(script.path, dirRel);
        await adapter.writeFile(rootDir, path.posix.join(targetRoot, fileRel), String(script.content || ''));
        if (typeof adapter.chmod === 'function') {
            await adapter.chmod(rootDir, path.posix.join(targetRoot, fileRel), 0o755);
        }
    }
    return dirRel;
}

/**
 * 0021：把技能目录写入多个目标根（平台根 + Agent 原生目录）。
 * 任一目标失败不影响其余目标（try/catch 单目标跳过）。
 * @param {string[]} targetRoots 相对 workspace 的目标根列表
 * @returns {Promise<string[]>} 成功写入的 slug 列表
 */
async function writeSkillDirectories(adapter, rootDir, skill, targetRoots) {
    const written = [];
    for (const targetRoot of targetRoots) {
        try {
            await writeSkillDirectory(adapter, rootDir, skill, targetRoot);
            written.push(slugify(skill.title));
        } catch (_) { /* 单目标失败跳过 */ }
    }
    return written;
}

/**
 * 清理 targetRoot 下不在 activeSlugs 集合中的旧目录（归档/删除后残留清理）。
 */
async function cleanupSkillDirectories(adapter, rootDir, activeSlugs, targetRoots = [SKILLS_ROOT]) {
    if (typeof adapter.rmrf !== 'function') return;
    for (const targetRoot of targetRoots) {
        let entries;
        if (typeof adapter.readDir === 'function') {
            entries = await adapter.readDir(rootDir, targetRoot);
        } else {
            try {
                entries = (await fs.promises.readdir(path.join(rootDir, targetRoot), { withFileTypes: true }))
                    .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
            } catch {
                continue; // 目录不存在即无需清理
            }
        }
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            if (!entry.isDirectory) continue;
            if (activeSlugs.includes(entry.name)) continue;
            await adapter.rmrf(rootDir, path.posix.join(targetRoot, entry.name));
        }
    }
}

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

    const allSkills = await listActiveSkills(userId, projectId);
    // 0021：落盘门槛——只有格式合法 + 置信度达标的 active skill 才注入
    const skills = allSkills.filter(isLandableSkill);
    if (skills.length === 0) return { injected: false, reason: 'no_landable_skills' };

    const { instructionFile, nativeSkillDirs } = getSkillTargets(agentId);
    const targetRoots = [SKILLS_ROOT, ...nativeSkillDirs];
    const { section, truncated, count, skillIds, slugs } = renderSkillsSection(skills);
    const adapter = fsAdapter || localFs;

    // 0025（方案 B）：索引段写入平台文件 .xensemble/AGENTS.md（gitignore 内，不污染用户 git）
    await adapter.writeFile(workspacePath, PLATFORM_INDEX_FILE, section);
    // 用户指令文件只写一行引导指针；文件不存在则跳过（不创建 untracked）
    const existing = await adapter.readFile(workspacePath, instructionFile);
    const next = skills.length > 0 ? applyPointer(existing) : removePointer(existing);
    if (next != null && next !== existing) {
        await adapter.writeFile(workspacePath, instructionFile, next);
    }

    // 0020/0021：技能目录落盘到平台根 + Agent 原生目录（失败不阻断主文件注入）
    const writtenSlugs = [];
    for (const s of skills) {
        if (!slugs.includes(slugify(s.title))) continue; // 只写入选索引的技能
        writtenSlugs.push(...await writeSkillDirectories(adapter, workspacePath, s, targetRoots));
    }
    await cleanupSkillDirectories(adapter, workspacePath, writtenSlugs, targetRoots);

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
        const allSkills = await listActiveSkills(userId, pid);
        // 0021：落盘门槛过滤 + 目标根 = 平台根 + 全部已注册 Agent 原生目录
        const skills = allSkills.filter(isLandableSkill);
        const targetRoots = [...new Set([SKILLS_ROOT, ...DEFAULT_AGENT_NATIVE_DIRS])];
        const wsPath = workspace.projectDir(userId, pid);
        // 0020/0021：目录落盘/清理 —— 即使有 running session 也执行，
        // 写入 Agent 原生技能目录（.claude/skills 等）即热加载，无需重启会话
        const { section, slugs } = skills.length > 0
            ? renderSkillsSection(skills)
            : { section: '', slugs: [] };
        if (skills.length > 0) {
            for (const s of skills) {
                if (!slugs.includes(slugify(s.title))) continue;
                await writeSkillDirectories(adapter, wsPath, s, targetRoots);
            }
        }
        await cleanupSkillDirectories(adapter, wsPath, slugs, targetRoots);

        // 0025（方案 B）：平台索引文件 .xensemble/AGENTS.md 始终更新（gitignore 内，
        // 不污染用户 git；Agent 不直接读它，无需避开 running session）
        try {
            await adapter.writeFile(wsPath, PLATFORM_INDEX_FILE, section);
        } catch (_) { /* 索引文件写入失败不阻断 */ }

        // 用户指令文件（AGENTS.md/CLAUDE.md）：只写/移除一行引导指针。
        // 有 running/pending session 则跳过，避免与 Agent 读取竞争（下次 spawn 自然更新）
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

        for (const file of ['AGENTS.md', 'CLAUDE.md']) {
            const existing = await adapter.readFile(wsPath, file);
            if (existing == null) continue; // 用户文件不存在则不创建（避免 untracked 污染）
            const next = skills.length > 0
                ? applyPointer(existing)
                : removePointer(existing);
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
    SKILLS_ROOT,
    PLATFORM_INDEX_FILE,
    POINTER_START,
    POINTER_END,
    DEFAULT_AGENT_NATIVE_DIRS,
    isEnabled,
    maxCount,
    maxBytes,
    minLandConfidence,
    isLandableSkill,
    slugify,
    safeRel,
    sanitizeContent,
    parseDescription,
    normalizeFrontmatterName,
    renderSkillsSection,
    applyToContent,
    removeSection,
    renderPointer,
    applyPointer,
    removePointer,
    listActiveSkills,
    writeSkillDirectory,
    writeSkillDirectories,
    cleanupSkillDirectories,
    injectForSession,
    reRenderForSkillChange,
    localFs,
};
