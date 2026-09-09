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
const { DEFAULT_AGENTS, getInstructionFile, getUserSkillDirs } = require('../agents/defaultAgents');
const { resolveRuntimeProvider } = require('../config/runtimeProvider');
const { recordEvent } = require('../events/recordEvent');

const SECTION_START = '<!-- xe-skills:start -->';
const SECTION_END = '<!-- xe-skills:end -->';
const SECTION_TITLE = '## XEnsemble Skills';
// 0030：全部已注册 Agent 的主用户级技能目录（去重；.git 载体模式重渲染的落盘目标）
const DEFAULT_AGENT_USER_SKILL_DIRS = [...new Set(
    DEFAULT_AGENTS.flatMap((a) => (a.userSkillDirs?.length ? [a.userSkillDirs[0]] : [])),
)];
// 0030（.git 搭车）：技能载体目录（相对 projectDir）——藏在 .git 内部，git 对其
// 完全无视（不出现在 git status / changes，无需 .gitignore 条目）。沙箱内经
// symlink 引导暴露为 /root/<agent 技能目录>（见 BoxLiteRuntimeProvider.buildSkillSymlinkScript）。
const SKILL_CARRIER_ROOT = '.git/xe-skills';
// 0029（技能载体）：平台写入技能目录的标记文件。cleanup 只清理带此标记且不在
// active 列表的目录——不覆盖用户/Agent 自建（无标记）的技能目录。该保护对
// 载体模式与工程回落模式统一生效（修复旧版对工程内 Agent 原生目录无差别 rm -rf 的 P0）。
const MANAGED_MARKER = '.xensemble-managed';
// 目录名允许字符（含中文），长度上限；禁止 `..`/空
const DIR_NAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,60}$/;

function isEnabled() {
    // 默认开启（与 SKILL_EXTRACT_ENABLED 同语义：显式 false 才关闭）
    return process.env.SKILL_INJECT_ENABLED !== 'false';
}

/**
 * 0030（.git 搭车）：是否启用技能载体模式（BoxLite）。
 * 载体 = projectDir/.git/xe-skills，随现有 workspace / .git 卷进沙箱，零新增挂载
 * 设备（libkrun 硬预算 2 卷，挂载型技能卷已被 2026-09-03 实验否定）。
 * Local provider 下 Agent 进程直接跑在宿主，HOME 即真实宿主 HOME，无 symlink
 * 引导——技能继续走工程内落盘（.xensemble/skills + 原生目录）。
 * SKILL_CARRIER_ENABLED=false 显式停用（回落工程内模式）。
 */
function isSkillCarrierEnabled() {
    if (process.env.SKILL_CARRIER_ENABLED === 'false') return false;
    return resolveRuntimeProvider() === 'boxlite';
}

function skillCarrierDir(userId, projectId) {
    if (!userId || !projectId) return null;
    const projectDir = workspace.projectDir(userId, projectId);
    const gitDir = path.join(projectDir, '.git');
    try {
        if (!fs.existsSync(gitDir)) return null;
    } catch { return null; }
    return path.join(gitDir, 'xe-skills');
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
 * 0020：技能名 → 安全目录名。
 *
 * 注意：OpenCode 等 Agent 对技能目录名/frontmatter name 有硬校验
 * `^[a-z0-9]+(-[a-z0-9]+)*$`（小写字母数字 + 单连字符分隔），中文等
 * 非 ASCII 字符会被 Agent 静默拒绝（技能不出现在可用清单里）。因此
 * 这里丢弃全部非 `[a-z0-9]` 字符——纯中文标题会退化为 `skill`，
 * 混合标题（如「跑通 PostgreSQL 迁移」）保留 ASCII 部分（`postgresql`）。
 */
function slugify(name) {
    const slug = String(name || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/^-+|-+$/g, '');
    return slug && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) ? slug : 'skill';
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
 * @param {Array} skills skills 行（需含 id/title/content/scripts/usageCount/updatedAt）
 * @param {string} [rootRef] 索引引用的技能根（默认工程内 SKILLS_ROOT；
 *   0030 技能载体模式传沙箱内挂载路径，如 /root/.claude/skills）
 * @returns {{ section: string, truncated: boolean, count: number, skillIds: string[], slugs: string[] }}
 */
function renderSkillsSection(skills, rootRef) {
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
        const desc = sanitizeContent(parseDescription(s.content) || `Skills 详见 ${rootRef}/${slug}/SKILL.md`);
        const block = `### ${s.title}\n${desc}\n\n详见 ${rootRef}/${slug}/SKILL.md\n`;
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
 * @param {string} [targetRoot] 相对 rootDir 的目标根目录（默认 .xensemble/skills）
 * @param {{ markManaged?: boolean }} [options] markManaged=true 时写入平台标记文件
 *   （MANAGED_MARKER），cleanup 只清理带标记目录，不覆盖用户/Agent 自建技能
 * @returns {Promise<string>} 目录相对路径（不含 targetRoot）
 */
async function writeSkillDirectory(adapter, rootDir, skill, targetRoot, options = {}) {
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
    // 0029：平台写入标记——cleanup 只清理带标记目录（保护用户/Agent 自建技能）
    if (options.markManaged && typeof adapter.writeFile === 'function') {
        await adapter.writeFile(rootDir, path.posix.join(targetRoot, dirRel, MANAGED_MARKER), 'managed\n');
    }
    return dirRel;
}

/**
 * 0021：把技能目录写入多个目标根（平台根 + Agent 原生目录）。
 * 任一目标失败不影响其余目标（try/catch 单目标跳过）。
 * @param {string[]} targetRoots 相对 rootDir 的目标根列表
 * @param {{ markManaged?: boolean }} [options]
 * @returns {Promise<string[]>} 成功写入的 slug 列表
 */
async function writeSkillDirectories(adapter, rootDir, skill, targetRoots, options = {}) {
    const written = [];
    for (const targetRoot of targetRoots) {
        try {
            await writeSkillDirectory(adapter, rootDir, skill, targetRoot, options);
            written.push(slugify(skill.title));
        } catch (_) { /* 单目标失败跳过 */ }
    }
    return written;
}

/**
 * 清理 targetRoot 下不在 activeSlugs 集合中的旧目录（归档/删除后残留清理）。
 * 0029：只清理带平台标记（MANAGED_MARKER）的目录——用户/Agent 自建的无标记
 * 技能目录一律保留（修复旧版对工程内 Agent 原生目录无差别 rm -rf 的 P0：
 * 用户自己放进 .claude/skills 的技能曾被误删）。历史遗留的无标记平台目录
 * 会滞留（迁移期一次性影响，无害：仅 Agent 可见的旧技能快照）。
 * @param {{ onlyManaged?: boolean }} [options] 默认 true；显式 false 恢复旧行为（不推荐）
 */
async function cleanupSkillDirectories(adapter, rootDir, activeSlugs, targetRoots, options = {}) {
    const onlyManaged = options.onlyManaged !== false;
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
            if (onlyManaged && typeof adapter.readFile === 'function') {
                // 只清理平台写入的技能目录（带 MANAGED_MARKER 标记）
                const marker = await adapter.readFile(rootDir, path.posix.join(targetRoot, entry.name, MANAGED_MARKER));
                if (marker == null) continue;
            }
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
 * @param {string} opts.agentId 决定指令文件名（getInstructionFile）与载体目标目录
 * @param {string} opts.workspacePath workspace 根目录
 * @param {object} [opts.fsAdapter] { readFile(rootDir,relPath), writeFile(rootDir,relPath,content) }；
 *   默认本地 fs。BoxLite workspace 不在控制面 FS 时由调用方注入（T4.3 边界）
 * @param {boolean} [opts.bumpUsage] 注入成功后对入选 skills 批量 usage_count+1（默认 true）
 * @param {boolean} [opts.useSkillCarrier] 覆盖技能载体模式判定（测试用；默认 isSkillCarrierEnabled()）
 * @param {object} [opts.runtimeExec] 沙箱内 exec 适配器（BoxLiteExecAdapter）。载体
 *   模式且提供时，spawn 前把宿主载体全量复制为 VM 内真目录（1 次 exec，每次会话
 *   启动即最新）——软链被 Claude Code 的目录遍历拒绝（对子项 lstat/Dirent 过滤，
 *   实测 /skills 为空而 opencode 正常），libkrun 内 mount --bind 也无权限
 * @param {string} [opts.runtimeRef] 沙箱会话名（runtimeExec 路由所需）
 * @param {string} [opts.carrierGuestRoot] 载体 guest 根（如 /workspace/.git/xe-skills，
 *   worktree 会话为 /workspace.git/xe-skills）；VM 内复制的源前缀
 * @param {string} [opts.vmSkillsDir] VM 内技能目录覆盖（guest 绝对路径）。配置根被
 *   重定向的 Agent（如 claude-code 的 CLAUDE_CONFIG_DIR=stateDir）技能发现路径是
 *   `<stateDir>/skills` 而非 ~/.claude/skills——调用方按 agent 的 stateEnv 计算传入；
 *   未传则默认 /root/<agent userSkillDirs[0]>
 * @returns {Promise<{ injected: boolean, reason?: string, instructionFile?: string, count?: number, truncated?: boolean, skillIds?: string[] }>}
 */
async function injectForSession({ userId, projectId, agentId, fsAdapter, bumpUsage = true, useSkillCarrier, runtimeExec = null, runtimeRef = null, carrierGuestRoot = null, vmSkillsDir = null }) {
    if (!isEnabled()) return { injected: false, reason: 'disabled' };

    const allSkills = await listActiveSkills(userId, projectId);
    const skills = allSkills.filter(isLandableSkill);
    if (skills.length === 0) return { injected: false, reason: 'no_landable_skills' };

    const instructionFile = getInstructionFile(agentId);
    const carrierEnabled = useSkillCarrier == null ? isSkillCarrierEnabled() : useSkillCarrier;
    const userSkillDirs = getUserSkillDirs(agentId);
    const carrierDir = (carrierEnabled && userSkillDirs.length > 0)
        ? skillCarrierDir(userId, projectId)
        : null;
    if (!carrierDir) return { injected: false, reason: 'no_carrier' };

    const rootRef = `/root/${userSkillDirs[0]}`;
    const { truncated, count, skillIds, slugs } = renderSkillsSection(skills, rootRef);
    const adapter = fsAdapter || localFs;

    const targetRoots = [userSkillDirs[0]];
    const writtenSlugs = [];
    for (const s of skills) {
        if (!slugs.includes(slugify(s.title))) continue;
        writtenSlugs.push(...await writeSkillDirectories(adapter, carrierDir, s, targetRoots, { markManaged: true }));
    }
    await cleanupSkillDirectories(adapter, carrierDir, writtenSlugs, targetRoots, { onlyManaged: true });

// 载体模式：把宿主载体全量复制为 VM 内真目录
    if (runtimeExec && runtimeRef && carrierGuestRoot) {
        const carrierDirGuest = `${carrierGuestRoot}/${userSkillDirs[0]}`;
        const vmSkillsDirs = vmSkillsDir ? [vmSkillsDir] : userSkillDirs.map((d) => `/root/${d}`);
        for (const vmDir of vmSkillsDirs) {
            try {
                const result = await runtimeExec.exec('sh', ['-c',
                    `rm -rf ${JSON.stringify(vmDir)} && mkdir -p ${JSON.stringify(vmDir)} `
                    + `&& cp -a ${JSON.stringify(carrierDirGuest)}/. ${JSON.stringify(vmDir)}/`],
                {}, { runtimeRef, cwd: '/' });
                if (result.exitCode !== 0) {
                    console.error('[skills] VM copy non-zero exit:', result.exitCode,
                        JSON.stringify({ vmDir, carrierDirGuest, runtimeRef }),
                        'stderr:', (result.stderr || '').slice(0, 500));
                }
            } catch (e) {
                console.error('[skills] VM copy exec failed:', e.message || e,
                    JSON.stringify({ vmDir, carrierDirGuest, runtimeRef }));
            }
        }
    }

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

    return { injected: true, instructionFile, count, truncated, skillIds,
        targetDirs: (runtimeExec && runtimeRef && carrierGuestRoot)
            ? (vmSkillsDir ? [vmSkillsDir] : userSkillDirs.map((d) => `/root/${d}`))
            : [] };
}

// ---------------------------------------------------------------------------
// T4.4：skill 状态/内容变更后重渲染（无 running session 的项目）
// ---------------------------------------------------------------------------

/**
 * 技能变更后对受影响项目重渲染指令文件。
 * - skill 带 projectId → 只重渲染该项目；skill 全局（projectId null）→ 重渲染该用户所有项目
 * - 有 running session 的项目跳过用户指令文件（下次 spawn 自然更新，避免与 Agent 读文件竞争）
 * - 有 active skills → 写/更新标记段；无 active skills → 移除标记段（归档后消失）
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string|null} opts.projectId skill 的项目作用域（null = 全局）
 * @param {object} [opts.fsAdapter]
 * @param {boolean} [opts.useSkillCarrier] 覆盖技能载体模式判定（测试用）
 * @returns {Promise<{ reRendered: number, reason?: string }>}
 */
async function reRenderForSkillChange({ userId, projectId = null, fsAdapter, useSkillCarrier }) {
    if (!isEnabled()) return { reRendered: 0, reason: 'disabled' };
    const adapter = fsAdapter || localFs;
    // 0030（.git 搭车）：载体按工程判定（git 工程 → .git/xe-skills；非 git → 工程内回落），
    // 因此技能查询仍按项目作用域，载体路径/rootRef 在循环内逐工程解析。
    const carrierEnabled = useSkillCarrier == null ? isSkillCarrierEnabled() : useSkillCarrier;
    const carrierAvailable = carrierEnabled && DEFAULT_AGENT_USER_SKILL_DIRS.length > 0;
    const carrierRootRef = `/root/${DEFAULT_AGENT_USER_SKILL_DIRS[0]}`;

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
        const skills = allSkills.filter(isLandableSkill);
        const carrierDir = carrierAvailable ? skillCarrierDir(userId, pid) : null;
        if (!carrierDir) continue;
        const targetRoots = DEFAULT_AGENT_USER_SKILL_DIRS;
        const { slugs } = skills.length > 0
            ? renderSkillsSection(skills, carrierRootRef)
            : { slugs: [] };
        if (skills.length > 0) {
            for (const s of skills) {
                if (!slugs.includes(slugify(s.title))) continue;
                await writeSkillDirectories(adapter, carrierDir, s, targetRoots, { markManaged: true });
            }
        }
        await cleanupSkillDirectories(adapter, carrierDir, slugs, targetRoots, { onlyManaged: true });
    }
    return { reRendered };
}

module.exports = {
    SECTION_START,
    SECTION_END,
    SECTION_TITLE,
    DEFAULT_AGENT_USER_SKILL_DIRS,
    SKILL_CARRIER_ROOT,
    MANAGED_MARKER,
    isEnabled,
    isSkillCarrierEnabled,
    skillCarrierDir,
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
    listActiveSkills,
    writeSkillDirectory,
    writeSkillDirectories,
    cleanupSkillDirectories,
    injectForSession,
    reRenderForSkillChange,
    localFs,
};
