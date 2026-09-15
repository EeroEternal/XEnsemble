const { eq, and } = require('drizzle-orm');
const crypto = require('crypto');
const { GitOperationService } = require('../github/GitOperationService');
const { LocalGitService } = require('../git/LocalGitService');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { getProjectForUser } = require('../projects/getProjectForUser');
const { withProjectGitLock } = require('../git/gitMutationLock');
const userPreferences = require('../admin/UserPreferences');
const { t } = require('../i18n');

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Resolve runtimeId from session_id query/body param.
 * Returns null if no session_id provided (backward-compatible).
 */
async function resolveRuntimeId(userId, sessionId) {
    if (!sessionId) return null;
    const rows = await db.select().from(schema.sessions)
        .where(and(
            eq(schema.sessions.id, sessionId),
            eq(schema.sessions.userId, userId),
        ));
    return rows[0]?.runtimeId || null;
}

/**
 * 多仓库路由：仅布局标记为 git_multi 的项目按 project_repos 路由
 * （默认 primary；repo_id query/body 可显式指定）。
 * 其余（单仓库 / 无记录 / 行删除后剩 1 行）一律 null → 根目录原逻辑。
 * 布局标记在 import-git 多仓库导入时写入 projects.workspace_mode，
 * 避免"按当前行数推断"在 repo 增删后产生歧义。
 */
async function resolveRepoSubPath(projectId, request) {
    if (!projectId) return null;
    try {
        const pRows = await db.select({ workspaceMode: schema.projects.workspaceMode })
            .from(schema.projects)
            .where(eq(schema.projects.id, projectId))
            .limit(1);
        if (pRows[0]?.workspaceMode !== 'git_multi') return null;
        const rows = await db.select().from(schema.projectRepos)
            .where(eq(schema.projectRepos.projectId, projectId));
        if (!rows || rows.length === 0) return null;
        const repoId = request.query?.repo_id || request.body?.repo_id || null;
        const target = (repoId && rows.find((r) => r.id === repoId))
            || rows.find((r) => r.isPrimary)
            || rows[0];
        return target.subPath;
    } catch {
        return null;
    }
}

/**
 * Create a GitOperationService scoped to the session's runtime (if session_id provided)
 * and to the target repo (multi-repo projects default to the primary repo).
 */
async function getGitService(request) {
    const runtimeId = await resolveRuntimeId(request.user.id, request.query?.session_id || request.body?.session_id);
    const repoSubPath = await resolveRepoSubPath(request.params?.id, request);
    return new GitOperationService({ runtimeId, repoSubPath });
}

// ─── 多仓库（git_multi）Changes 聚合 ───
// 布局：projectDir/<subPath> 各自是独立 git 仓，/workspace 根不是仓库。
// 单仓库路由只能看到 primary 的变动；这里为每个 repo 构建服务实例，
// status 聚合展示（路径加 <subPath>/ 前缀），stage/unstage/discard/commit
// 按路径前缀路由到所属 repo。

/**
 * git_multi 项目的全部 project_repos 行（非 git_multi / 异常 → []）。
 */
async function listGitMultiRepos(projectId) {
    try {
        const pRows = await db.select({ workspaceMode: schema.projects.workspaceMode })
            .from(schema.projects)
            .where(eq(schema.projects.id, projectId))
            .limit(1);
        if (pRows[0]?.workspaceMode !== 'git_multi') return [];
        return await db.select().from(schema.projectRepos)
            .where(eq(schema.projectRepos.projectId, projectId));
    } catch {
        return [];
    }
}

/**
 * 为 git_multi 项目每个 repo 构建一个 GitOperationService。
 * 返回 null 表示非 git_multi（调用方走原单仓库逻辑）。
 */
async function buildMultiRepoServices(request) {
    const rows = await listGitMultiRepos(request.params?.id);
    if (!rows || rows.length === 0) return null;
    const runtimeId = await resolveRuntimeId(
        request.user.id,
        request.query?.session_id || request.body?.session_id,
    );
    const primary = rows.find((r) => r.isPrimary) || rows[0];
    const services = rows.map((row) => ({
        row,
        svc: new GitOperationService({ runtimeId, repoSubPath: row.subPath }),
    }));
    return { rows, primary, services };
}

/** 最长前缀匹配：把 `<subPath>/...` 路由到所属 repo（返回其服务实例与仓库内相对路径）。 */
function matchRepoForPath(multi, filePath) {
    const sorted = [...multi.rows].sort((a, b) => b.subPath.length - a.subPath.length);
    const hit = sorted.find((r) => filePath.startsWith(`${r.subPath}/`));
    if (!hit) return null;
    return {
        row: hit,
        svc: multi.services.find((s) => s.row.id === hit.id)?.svc,
        relPath: filePath.slice(hit.subPath.length + 1),
    };
}

/** 把文件路径按所属 repo 分组（丢弃无法归属的路径）。 */
function groupPathsByRepo(multi, filePaths) {
    const groups = new Map();
    for (const p of filePaths) {
        const hit = matchRepoForPath(multi, p);
        if (!hit || !hit.svc) continue;
        if (!groups.has(hit.row.id)) groups.set(hit.row.id, { svc: hit.svc, paths: [] });
        groups.get(hit.row.id).paths.push(hit.relPath);
    }
    return [...groups.values()];
}

const prefixEntries = (list, prefix) => (list || []).map((e) => ({ ...e, path: `${prefix}/${e.path}` }));

/**
 * 聚合所有仓库的 status：文件路径加 `<subPath>/` 前缀；
 * branch/sha/ahead/behind 取 primary（UI 呈现单一分支），dirty 等布尔取并集。
 * 同时输出 `repos[]` 每仓库明细（id/subPath/branch/ahead/files 等），
 * 供前端按仓库分组展示（VSCode multi-root worktree 风格）。
 */
async function aggregateGitStatus(project, multi, mode) {
    const statuses = [];
    for (const { row, svc } of multi.services) {
        const s = await (mode === 'light'
            ? svc.getStatusLight(project)
            : svc.getStatus(project)).catch(() => null);
        if (s) statuses.push({ row, s });
    }
    if (statuses.length === 0) {
        throw new Error('git status failed for all repositories');
    }
    const head = statuses.find((x) => x.row.id === multi.primary.id) || statuses[0];
    const merged = { ...head.s, multiRepo: true };
    merged.files = [];
    merged.stagedFiles = [];
    merged.unstagedFiles = [];
    merged.conflicts = [];
    merged.dirty = false;
    merged.staged = false;
    merged.unstaged = false;
    merged.untracked = false;
    merged.merging = false;
    merged.truncated = false;
    const repos = [];
    for (const { row, s } of statuses) {
        merged.files.push(...prefixEntries(s.files, row.subPath));
        merged.stagedFiles.push(...prefixEntries(s.stagedFiles, row.subPath));
        merged.unstagedFiles.push(...prefixEntries(s.unstagedFiles, row.subPath));
        merged.conflicts.push(...prefixEntries(s.conflicts, row.subPath));
        merged.dirty = Boolean(merged.dirty || s.dirty);
        merged.staged = Boolean(merged.staged || s.staged);
        merged.unstaged = Boolean(merged.unstaged || s.unstaged);
        merged.untracked = Boolean(merged.untracked || s.untracked);
        merged.merging = Boolean(merged.merging || s.merging);
        merged.truncated = Boolean(merged.truncated || s.truncated);
        repos.push({
            id: row.id,
            subPath: row.subPath,
            role: row.role || 'custom',
            isPrimary: Boolean(row.isPrimary),
            branch: s.branch || null,
            sha: s.sha || null,
            ahead: s.ahead ?? null,
            behind: s.behind ?? null,
            dirty: Boolean(s.dirty),
            staged: Boolean(s.staged),
            unstaged: Boolean(s.unstaged),
            untracked: Boolean(s.untracked),
            merging: Boolean(s.merging),
            truncated: Boolean(s.truncated),
            files: prefixEntries(s.files, row.subPath),
            stagedFiles: prefixEntries(s.stagedFiles, row.subPath),
            unstagedFiles: prefixEntries(s.unstagedFiles, row.subPath),
            conflicts: prefixEntries(s.conflicts, row.subPath),
        });
    }
    merged.repos = repos;
    return merged;
}

// Generate a commit message from the working-tree diff using the configured
// DeepSeek-compatible LLM (same env as session titleService).
async function generateCommitMessage(project, gitOperationService, { locale } = {}) {
    const result = await generateAIDescription(project, gitOperationService, 'commit', { locale });
    return result;
}

async function generatePRDescription(project, gitOperationService, { sourceBranch, targetBranch, locale } = {}) {
    const base = targetBranch || 'main';
    // Fetch the target branch so origin/<base> is up-to-date for the
    // three-dot diff. Non-fatal if fetch fails (fall back to stale refs).
    try {
        await gitOperationService._execGit(project, ['fetch', 'origin', base], { timeoutMs: 30_000 });
    } catch { /* non-fatal */ }
    // Use three-dot diff (origin/<base>...HEAD) so we only capture commits
    // unique to the source branch, not the full divergence from base.
    const result = await generateAIDescription(project, gitOperationService, 'pr', { base, locale });
    return result;
}

async function generateAIDescription(project, gitOperationService, type, opts = {}) {
    // For PRs, use three-dot diff (origin/<base>...HEAD) to capture only the
    // source branch's unique commits — not the full divergence from base.
    // Two-dot diff (base HEAD) would include base-side changes the branch
    // never made, producing inaccurate AI descriptions.
    const diffOpts = type === 'pr'
        ? { threeDot: true, base: `origin/${opts.base || 'main'}`, head: 'HEAD' }
        : { base: 'HEAD' };
    const result = await gitOperationService.getDiff(project, diffOpts);
    let diff = (result?.diff || '').trim();
    if (!diff) {
        try {
            const status = await gitOperationService.getStatus(project);
            const changed = (status?.files || [])
                .map((f) => `${f.type === 'untracked' ? 'A' : f.type === 'conflict' ? 'C' : 'M'} ${f.path}`)
                .join('\n');
            if (changed) diff = changed;
        } catch { /* ignore */ }
    }
    if (!diff) return type === 'pr' ? { title: '', body: '' } : { message: '' };

    const apiKey = process.env.LLM_ANALYZE_API_KEY;
    const apiUrl = process.env.LLM_ANALYZE_API_URL || 'https://api.deepseek.com/chat/completions';
    const model = process.env.LLM_VERIFY_MODEL || process.env.LLM_ANALYZE_MODEL || 'deepseek-chat';
    if (!apiKey) return type === 'pr' ? { title: '', body: '', error: 'AI not configured' } : { message: '', error: 'AI not configured' };

    const truncated = diff.slice(0, 8000);
    const locale = opts.locale || 'en';
    // Conventional Commit format: <type>(<scope>): <subject>\n\n<body>
    // We ask the model for the full message (subject + blank line + body) so
    // future readers can see *why* a change was made, not just *what* lines
    // moved. Scope and body are encouraged, not required for trivial changes.
    const prompts = locale === 'zh' ? {
        commit: [
          '你是一个 commit message 生成器。',
          '根据给定的 git diff 输出一个 conventional commit 消息，全部内容必须用中文编写（包括 type 之后的主题句、scope、body 列表项）。',
          '格式严格如下：',
          '  - 第一行: <type>(<scope>): <subject>，type 必须是 feat/fix/refactor/style/docs/chore/test 之一，scope 是受影响的模块名（可选），subject 不超过 50 个汉字，祈使句',
          '  - 空行',
          '  - 接下来若干行 body：详细说明改动的动机、关键变更点、影响范围，每行不超过 72 个汉字，用 - 开头作为列表项',
          '  - 重要的：必须解释 *为什么* 改（不只说改了什么），例如：用户报告的 bug、性能瓶颈、架构缺陷、需求来源',
          '  - 对于明显的重构或新功能，列出 2-4 个变更要点',
          '示例：',
          '  feat(gateway): 删除网关提供商时添加确认提示',
          '',
          '  - 防止误删导致现有 session 鉴权失败',
          '  - 复用项目里已有的 ConfirmDialog 组件，variant=danger',
          '  - 通过 i18n key 提供中英文',
          '',
          '只输出 commit message 本身，不要引号、不要 markdown 代码块、不要解释。',
        ].join('\n'),
        pr: '你是一个 pull request 生成器。根据 git diff，用中文输出一个包含 "title" 和 "body" 字段的 JSON 对象。title 和 body 都用中文编写；title 是简洁的 conventional commit 风格摘要（如 "feat: 添加登录表单"，用中文描述改动内容）。body 是关于改了什么以及为什么的简短中文描述，用 markdown 列表格式。只输出有效 JSON，不要 markdown 代码块或解释。',
    } : {
        commit: [
          'You are a commit message generator.',
          'Respond entirely in English. The subject, scope, and every body line must be in English, even if the surrounding UI is in another language.',
          'Given a git diff, output a conventional commit message in this exact format:',
          '  - First line: <type>(<scope>): <subject> — type must be one of feat/fix/refactor/style/docs/chore/test; scope is the affected module (optional); subject is imperative mood, no period, ≤ 50 chars',
          '  - Blank line',
          '  - Body: 2-5 bullet points (each ≤ 72 chars, starting with "-") explaining',
          '    * what changed (the visible diff)',
          '    * *why* it changed — root cause, user-reported bug, performance, design tradeoff, requirement',
          '    * any side effects, follow-ups, or risk',
          '  - For trivial one-line fixes a body is optional; for everything else include at least a one-line "why"',
          'Example:',
          '  feat(gateway): require confirmation when deleting a provider',
          '',
          '  - Prevents accidental deletes that would break auth for live sessions',
          '  - Reuses the existing ConfirmDialog component with variant=danger',
          '  - Title and message are routed through the existing i18n keys',
          '',
          'Respond with the commit message only. No quotes, no markdown code fences, no preamble.',
        ].join('\n'),
        pr: 'You are a pull request generator. Given a git diff, output a JSON object with "title" and "body" fields. The title should be a concise conventional commit style summary. The body should be a brief description of what changed and why, in markdown bullet points. Respond with valid JSON only, no markdown code blocks, no explanation.',
    };
    // commit/PR 描述是「总结 diff」型任务，不需要深度推理。reasoning_effort=low
    // 可大幅压缩思考量（实测 33s → ~5s），且为 OpenAI 兼容标准字段（GLM 全系 /
    // DeepSeek 等通用，多余字段一般被忽略）。用环境变量可调/可关：
    //   - 未配置 → 默认 'low'（推理模型提速）
    //   - 配置为 high/max → 自定义思考强度
    //   - 配置为空字符串 '' → 完全不传该字段（兼容严格校验未知字段的端点）
    // 不用 thinking.type=disabled：官方文档明确 GLM-5.3 系列始终思考、不支持
    // disabled，模型切换/升级后请求会失败（历史教训：thinking_budget / json_object
    // 等 GLM 字段曾因兼容性引入问题）。
    const reasoningEffort = process.env.LLM_ANALYZE_REASONING_EFFORT === undefined
        ? 'low'
        : String(process.env.LLM_ANALYZE_REASONING_EFFORT).trim();
    const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: prompts[type] || prompts.commit },
                { role: 'user', content: truncated },
            ],
            // 推理模型（如 glm-5.3-flash 等）会把大量输出 token 花在
            // reasoning_content 思考上，800/2000 常被思考耗尽导致
            // message.content 为空（finish_reason=length），前端误报
            // 「无更改可描述」。提到 8192 给「思考 + 正文」留足空间，
            // 兼顾最坏情况（长 diff 下 prompt/reasoning 均更大）。
            max_tokens: 8192,
            temperature: 0.4,
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        }),
    });
    if (!res.ok) throw new Error(`AI error ${res.status}`);
    const data = await res.json();
    const content = (data.choices?.[0]?.message?.content || '').trim();

    // content 为空：AI 未返回有效结果（多半是推理 token 耗尽 / 模型异常）。
    // 返回明确 error，避免前端把「AI 生成失败」误判成「没有改动可描述」。
    const emptyError = t('errors:ai_empty_output', {
        defaultValue: 'AI returned an empty result. Try again, or check the AI model/output token configuration.',
    }, locale);

    if (type === 'pr') {
        if (!content) return { title: '', body: '', error: emptyError };
        let parsed;
        try {
            const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
            parsed = JSON.parse(cleaned);
        } catch {
            parsed = { title: '', body: '' };
            const titleMatch = content.match(/"title"\s*:\s*"([^"]*)"/);
            const bodyMatch = content.match(/"body"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (titleMatch) parsed.title = titleMatch[1];
            if (bodyMatch) parsed.body = bodyMatch[1].replace(/\\n/g, '\n');
            if (!parsed.title) {
                const firstLine = content.split('\n')[0]
                    .replace(/^```(?:json)?\s*/i, '')
                    .replace(/^["'`]|["'`]$/g, '')
                    .trim();
                parsed = { title: firstLine, body: content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim() };
            }
        }
        return {
            title: String(parsed.title || '').replace(/^["'`]|["'`]$/g, '').trim(),
            body: String(parsed.body || '').trim(),
        };
    }

    // Commit message: preserve newlines from the model so the body renders
    // properly. Strip outer quotes if the model wrapped the whole message.
    if (!content) return { message: '', error: emptyError };
    return {
        message: content
            .replace(/^["'`]|["'`]$/g, '')
            .split('\n')
            .map((l) => l.replace(/[ \t]+$/g, ''))
            .join('\n')
            .trim(),
    };
}

async function upsertProjectBranch(projectId, branchName, values = {}) {
    const now = Date.now();
    const existing = await db.select().from(schema.projectBranches)
        .where(and(
            eq(schema.projectBranches.projectId, projectId),
            eq(schema.projectBranches.branchName, branchName),
        ));

    if (existing.length > 0) {
        await db.update(schema.projectBranches)
            .set({
                ...values,
                updatedAt: now,
            })
            .where(eq(schema.projectBranches.id, existing[0].id));
        return existing[0].id;
    }

    const id = newId('br');
    await db.insert(schema.projectBranches).values({
        id,
        projectId,
        branchName,
        baseBranch: values.baseBranch || null,
        isActive: values.isActive ?? false,
        lastCommitSha: values.lastCommitSha || null,
        aheadCount: values.aheadCount ?? 0,
        behindCount: values.behindCount ?? 0,
        createdAt: now,
        updatedAt: now,
    });
    return id;
}

async function ensureLocalGitReady(project, log, runtimeId) {
    // Built-in workspace git should always be available for Changes. Backfill
    // projects where create-time initRepo failed (common on BoxLite).
    if (project.repoProvider && project.repoProvider !== 'none' && project.repoProvider !== 'local_git') {
        return project;
    }
    try {
        const localGit = new LocalGitService({ runtimeId });
        await localGit.ensureGitInit(project);
        return (await getProjectForUser(project.userId, project.id)) || project;
    } catch (err) {
        log?.warn?.({ err, projectId: project.id }, 'ensureGitInit before git status failed');
        return project;
    }
}

function registerProjectGitRoutes(fastify) {

    fastify.get('/api/v1/projects/:id/git/status', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        let project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        try {
            const runtimeId = await resolveRuntimeId(request.user.id, request.query?.session_id);
            project = await ensureLocalGitReady(project, request.log, runtimeId);
            const mode = request.query.mode === 'light' ? 'light' : 'full';
            // 多仓库：聚合所有 repo 的 status（文件路径带 <subPath>/ 前缀）
            const multi = await buildMultiRepoServices(request);
            if (multi) {
                return await aggregateGitStatus(project, multi, mode);
            }
            const gitOperationService = new GitOperationService({
                runtimeId,
                repoSubPath: await resolveRepoSubPath(project.id, request),
            });
            const status = mode === 'light'
                ? await gitOperationService.getStatusLight(project)
                : await gitOperationService.getStatus(project);
            return status;
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/projects/:id/git/commit', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        const message = String(request.body?.message || '').trim();
        if (!message) return reply.code(400).send({ error: 'message is required' });
        const prefs = await userPreferences.getPreferences(request.user.id).catch(() => ({}));
        const authorName = request.body?.author?.name || prefs.git_author_name || request.user.username || '';
        const authorEmail = request.body?.author?.email || prefs.git_author_email || '';
        if (!authorName || !authorEmail) {
            return reply.code(400).send({
                error: 'Git author info required',
                code: 'AUTHOR_REQUIRED',
                hint: '请提供 git 提交所需的用户名和邮箱',
            });
        }
        try {
            const author = { name: authorName, email: authorEmail };
            // 多仓库：对每个有暂存内容的 repo 分别提交（stage 已按前缀路由到各 repo）；
            // repo_id 显式指定时只提交该 repo（前端 per-repo commit 按钮）。
            const multi = await buildMultiRepoServices(request);
            if (multi) {
                const targetRepoId = request.body?.repo_id || request.query?.repo_id || null;
                const targets = targetRepoId
                    ? multi.services.filter((s) => s.row.id === targetRepoId)
                    : multi.services;
                let sha = null;
                const committedRepos = [];
                for (const { svc, row } of targets) {
                    const s = await svc.getStatus(project).catch(() => null);
                    if (!s || !(s.stagedFiles || []).length) continue;
                    const r = await svc.commitStaged(project, message, author);
                    committedRepos.push({ repoId: row.id, subPath: row.subPath, branch: s.branch || null, sha: r.sha });
                    if (!sha) sha = r.sha;
                }
                const status = await aggregateGitStatus(project, multi, 'full').catch(() => null);
                return { sha, committed: Boolean(sha), committedRepos, status };
            }
            const result = await gitOperationService.commitStaged(project, message, author);
            const status = await gitOperationService.getStatus(project).catch(() => null);
            return { ...result, status };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/projects/:id/git/commit-message', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        try {
            const result = await generateCommitMessage(project, gitOperationService, { locale: request.locale });
            return result;
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/projects/:id/git/pr-description', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        try {
            const result = await generatePRDescription(project, gitOperationService, {
                sourceBranch: request.body?.source_branch,
                targetBranch: request.body?.target_branch,
                locale: request.locale,
            });
            return result;
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/projects/:id/git/stage', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        const files = request.body?.files;
        if (!Array.isArray(files) || files.length === 0) {
            return reply.code(400).send({ error: t('errors:files_array_required', { defaultValue: 'files array is required' }, request.locale || 'en'), code: 'files_array_required' });
        }
        try {
            // 多仓库：按路径前缀路由到所属 repo 分别 stage
            const multi = await buildMultiRepoServices(request);
            if (multi) {
                for (const { svc, paths } of groupPathsByRepo(multi, files)) {
                    await svc.stageFiles(project, paths);
                }
                return { ok: true };
            }
            await gitOperationService.stageFiles(project, files);
            return { ok: true };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/projects/:id/git/unstage', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        const files = request.body?.files;
        if (!Array.isArray(files) || files.length === 0) {
            return reply.code(400).send({ error: t('errors:files_array_required', { defaultValue: 'files array is required' }, request.locale || 'en'), code: 'files_array_required' });
        }
        try {
            // 多仓库：按路径前缀路由到所属 repo 分别 unstage
            const multi = await buildMultiRepoServices(request);
            if (multi) {
                for (const { svc, paths } of groupPathsByRepo(multi, files)) {
                    await svc.unstageFiles(project, paths);
                }
                return { ok: true };
            }
            await gitOperationService.unstageFiles(project, files);
            return { ok: true };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/projects/:id/git/discard', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        const files = request.body?.files;
        if (!Array.isArray(files) || files.length === 0) {
            return reply.code(400).send({ error: t('errors:files_array_required', { defaultValue: 'files array is required' }, request.locale || 'en'), code: 'files_array_required' });
        }
        try {
            // 多仓库：按路径前缀路由到所属 repo 分别 discard
            const multi = await buildMultiRepoServices(request);
            if (multi) {
                for (const { svc, paths } of groupPathsByRepo(multi, files)) {
                    await svc.discardChanges(project, paths);
                }
                return { ok: true };
            }
            await gitOperationService.discardChanges(project, files);
            return { ok: true };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/projects/:id/git/push', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        const branchName = request.body?.branch || project.currentBranch;
        if (!branchName) return reply.code(400).send({ error: 'No current branch to push' });
        try {
            // 多仓库：每个 repo 推各自当前分支（worktree 分支），
            // 避免只有 primary 上推到远程、其余 repo 的提交永远留在本地。
            // repo_id 显式指定时只推该 repo（前端 per-repo push 按钮）。
            const multi = await buildMultiRepoServices(request);
            if (multi) {
                const targetRepoId = request.body?.repo_id || request.query?.repo_id || null;
                const targets = targetRepoId
                    ? multi.services.filter((s) => s.row.id === targetRepoId)
                    : multi.services;
                const pushed = [];
                let sha = null;
                for (const { svc, row } of targets) {
                    let branch = null;
                    try {
                        const out = await svc._execGit(project, ['rev-parse', '--abbrev-ref', 'HEAD']);
                        branch = out.stdout.trim();
                        if (!branch || branch === 'HEAD') continue;
                    } catch {
                        continue;
                    }
                    try {
                        const r = await svc.pushBranch(project, branch);
                        pushed.push({ repoId: row.id, subPath: row.subPath, branch, sha: r.sha });
                        if (row.id === multi.primary.id) sha = r.sha;
                    } catch (err) {
                        pushed.push({ repoId: row.id, subPath: row.subPath, branch, error: err.message });
                    }
                }
                const status = await aggregateGitStatus(project, multi, 'full').catch(() => null);
                return { pushed, sha, status };
            }
            const result = await gitOperationService.pushBranch(project, branchName);
            const status = await gitOperationService.getStatus(project).catch(() => null);
            return { ...result, status };
        } catch (err) {
            request.log.error(err);
            const msg = err.message || '';
            // push 认证失败（HTTP Basic Access denied / 401/403 等）通常是该 Git 服务器的
            // 账号未连接、token 过期/无效或权限不足——返回明确指引，而不是裸的 git 报错。
            const isAuth = /HTTP Basic: Access denied/i.test(msg)
                || /Authentication failed/i.test(msg)
                || /could not read (Username|Password) for/i.test(msg)
                || /invalid username or password/i.test(msg)
                || /authorization failed/i.test(msg)
                || /authentication required/i.test(msg)
                || /requested URL returned error: 40[13]/i.test(msg);
            if (isAuth) {
                let host = project.repoUrl || '';
                try { host = new URL(project.repoUrl).host; } catch { /* keep raw url */ }
                return reply.code(401).send({
                    error: t('errors:git_auth_failed', {
                        host,
                        defaultValue: 'Push authentication failed for {{host}}: the account for this Git server is not connected, or the token is expired/invalid/insufficient. Connect the matching account in Settings → Git and try again.',
                    }, request.locale || 'en'),
                    code: 'git_auth_failed',
                });
            }
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.get('/api/v1/projects/:id/git/diff', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        try {
            const result = await gitOperationService.getDiff(project, {
                base: request.query?.base,
                head: request.query?.head,
            });
            return {
                diff: result.diff,
                truncated: Boolean(result.truncated),
                binary: Boolean(result.binary),
                omitted_bytes: result.omittedBytes || 0,
            };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.get('/api/v1/projects/:id/git/file-diff', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        const filePath = request.query?.path;
        if (!filePath) return reply.code(400).send({ error: t('errors:path_required', { defaultValue: 'path is required' }, request.locale || 'en'), code: 'path_required' });
        try {
            // 多仓库：按路径前缀路由到所属 repo
            let svc = gitOperationService;
            let targetPath = filePath;
            const multi = await buildMultiRepoServices(request);
            if (multi) {
                const hit = matchRepoForPath(multi, filePath);
                if (hit?.svc) {
                    svc = hit.svc;
                    targetPath = hit.relPath;
                }
            }
            const result = await svc.getFileDiff(project, targetPath);
            return {
                diff: result.diff,
                truncated: Boolean(result.truncated),
                binary: Boolean(result.binary),
                omitted_bytes: result.omittedBytes || 0,
            };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.get('/api/v1/projects/:id/git/file-content', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        const filePath = request.query?.path;
        const ref = request.query?.ref || 'HEAD';
        if (!filePath) return reply.code(400).send({ error: t('errors:path_required', { defaultValue: 'path is required' }, request.locale || 'en'), code: 'path_required' });
        try {
            // 多仓库：按路径前缀路由到所属 repo
            let svc = gitOperationService;
            let targetPath = filePath;
            const multi = await buildMultiRepoServices(request);
            if (multi) {
                const hit = matchRepoForPath(multi, filePath);
                if (hit?.svc) {
                    svc = hit.svc;
                    targetPath = hit.relPath;
                }
            }
            const content = await svc.getFileContentAtRef(project, targetPath, ref);
            return { content, ref };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.get('/api/v1/projects/:id/git/file-diff-view', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        const filePath = request.query?.path;
        if (!filePath) return reply.code(400).send({ error: t('errors:path_required', { defaultValue: 'path is required' }, request.locale || 'en'), code: 'path_required' });
        try {
            // 多仓库：按路径前缀路由到所属 repo
            let svc = gitOperationService;
            let targetPath = filePath;
            const multi = await buildMultiRepoServices(request);
            if (multi) {
                const hit = matchRepoForPath(multi, filePath);
                if (hit?.svc) {
                    svc = hit.svc;
                    targetPath = hit.relPath;
                }
            }
            const view = await svc.getFileDiffView(project, targetPath);
            return {
                original: view.original,
                modified: view.modified,
                truncated: Boolean(view.truncated),
                binary: Boolean(view.binary),
            };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/projects/:id/git/pull', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        const force = request.body?.force === true;
        try {
            const result = await withProjectGitLock(project.id, async () => {
                const { stdout: branch } = await gitOperationService._execGit(project, ['rev-parse', '--abbrev-ref', 'HEAD']);
                const current = branch.trim();
                let target = current;
                let remoteRef = `origin/${current}`;
                let existsOnRemote = true;
                try {
                    await gitOperationService._execGit(project, ['rev-parse', '--verify', '--quiet', remoteRef]);
                } catch {
                    existsOnRemote = false;
                }
                if (!existsOnRemote) {
                    try {
                        const { stdout: defaultRef } = await gitOperationService._execGit(project, [
                            'symbolic-ref', '--short', 'refs/remotes/origin/HEAD',
                        ]);
                        target = defaultRef.trim().split('/').pop();
                    } catch {
                        target = 'main';
                    }
                }

                // Force pull: stash → pull --rebase → stash pop。分支保持线性。
                if (force) {
                    // Detect local changes (tracked + untracked).
                    const { stdout: statusOut } = await gitOperationService._execGit(project, ['status', '--porcelain']);
                    const hasLocalChanges = statusOut.trim().length > 0;
                    let stashed = false;
                    if (hasLocalChanges) {
                        await gitOperationService._execGit(project, ['stash', 'push', '-u', '-m', 'xe-force-pull']);
                        stashed = true;
                    }
                    try {
                        await gitOperationService._execGit(project, ['pull', '--rebase', 'origin', target]);
                    } catch (pullErr) {
                        // Pull --rebase 本身撞上分支冲突。终止进行中的 rebase、
                        // 恢复 stash 的本地改动，并把错误抛给前端。
                        await gitOperationService._execGit(project, ['rebase', '--abort']).catch(() => {});
                        if (stashed) {
                            await gitOperationService._execGit(project, ['stash', 'pop']).catch(() => {});
                        }
                        throw pullErr;
                    }
                    let conflicts = [];
                    if (stashed) {
                        try {
                            await gitOperationService._execGit(project, ['stash', 'pop']);
                            // stash pop may produce conflict markers in the working tree.
                            const { stdout: conflictOut } = await gitOperationService._execGit(project, ['diff', '--name-only', '--diff-filter=U']);
                            conflicts = conflictOut.trim().split('\n').filter(Boolean);
                        } catch {
                            // If stash pop itself conflicts, git exits non-zero but still leaves
                            // conflict markers in the tree — they will surface in status.
                            const { stdout: conflictOut } = await gitOperationService._execGit(project, ['diff', '--name-only', '--diff-filter=U']).catch(() => ({ stdout: '' }));
                            conflicts = conflictOut.trim().split('\n').filter(Boolean);
                        }
                    }
                    gitOperationService._invalidateAheadBehind(project.id);
                    return { ok: true, conflicts };
                }

                try {
                    await gitOperationService._execGit(project, ['pull', '--rebase', 'origin', target]);
                    gitOperationService._invalidateAheadBehind(project.id);
                    return { ok: true };
                } catch (pullErr) {
                    // Detect conflict-type failures so the frontend can prompt for force pull.
                    // rebase 式 pull 对脏工作区直接拒绝（"cannot pull with rebase:
                    // You have unstaged changes"），这类也归入 pull_conflict，
                    // 由前端引导走强制拉取（stash → rebase → 恢复）。
                    const msg = (pullErr.message || '').toLowerCase();
                    const isConflict = msg.includes('conflict')
                        || msg.includes('would be overwritten')
                        || msg.includes('unstaged changes')
                        || msg.includes('uncommitted changes')
                        || msg.includes('cannot pull with rebase')
                        || msg.includes('local changes');
                    if (isConflict) {
                        // pull --rebase 撞上冲突：终止进行中的 rebase，保持工作区
                        // 可 stash（前端会引导走强制拉取流程）。
                        await gitOperationService._execGit(project, ['rebase', '--abort']).catch(() => {});
                        const err = new Error(t('git:pull_conflict_message', {}, request.locale || 'en'));
                        err.code = 'pull_conflict';
                        throw err;
                    }
                    throw pullErr;
                }
            });
            return result;
        } catch (err) {
            if (err.code === 'pull_conflict') {
                return reply.code(409).send({ error: err.message, code: 'pull_conflict' });
            }
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/projects/:id/git/fetch', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        try {
            await withProjectGitLock(project.id, async () => {
                await gitOperationService._execGit(project, ['fetch', 'origin']);
                gitOperationService._invalidateAheadBehind(project.id);
            });
            const status = await gitOperationService.getStatus(project).catch(() => null);
            return { ok: true, status };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.get('/api/v1/projects/:id/git/clone-status', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        return {
            clone_status: project.cloneStatus || 'pending',
            clone_error: project.cloneError || null,
        };
    });

    fastify.post('/api/v1/projects/:id/git/clone', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        return reply.code(501).send({ error: 'Re-clone route is not implemented yet' });
    });

    fastify.get('/api/v1/projects/:id/git/log', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        try {
            const log = await gitOperationService.getLog(project, {
                branch: request.query?.branch,
                limit: request.query?.limit ? Number(request.query.limit) : 20,
            });
            return { log };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    // ─── Branch routes ───

    fastify.get('/api/v1/projects/:id/branches', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        try {
            const branches = await gitOperationService.listBranches(project);
            return { branches };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/projects/:id/branches', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        const name = String(request.body?.name || '').trim();
        if (!name) return reply.code(400).send({ error: 'name is required' });
        const baseBranch = request.body?.base_branch || project.repoDefaultBranch || 'main';
        try {
            const result = await gitOperationService.createBranch(project, name, baseBranch);
            await upsertProjectBranch(project.id, name, {
                baseBranch,
                isActive: false,
                lastCommitSha: result.sha,
            });
            return result;
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/projects/:id/branches/switch', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        const name = String(request.body?.name || '').trim();
        if (!name) return reply.code(400).send({ error: 'name is required' });
        try {
            const result = await gitOperationService.switchBranch(project, name);
            await db.update(schema.projects)
                .set({ currentBranch: name })
                .where(eq(schema.projects.id, project.id));

            await db.update(schema.projectBranches)
                .set({ isActive: false })
                .where(eq(schema.projectBranches.projectId, project.id));
            await upsertProjectBranch(project.id, name, {
                isActive: true,
                lastCommitSha: result.sha,
            });
            return result;
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.delete('/api/v1/projects/:id/branches/:name', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        const name = request.params.name;
        if (project.currentBranch === name) {
            return reply.code(400).send({ error: 'Cannot delete the currently checked out branch' });
        }
        try {
            await gitOperationService.deleteBranch(project, name);
            await db.delete(schema.projectBranches)
                .where(and(
                    eq(schema.projectBranches.projectId, project.id),
                    eq(schema.projectBranches.branchName, name),
                ));
            return { ok: true };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/projects/:id/branches/merge', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const gitOperationService = await getGitService(request);
        const fromBranch = String(request.body?.from_branch || '').trim();
        const toBranch = String(request.body?.to_branch || project.currentBranch || '').trim();
        if (!fromBranch) return reply.code(400).send({ error: 'from_branch is required' });
        if (!toBranch) return reply.code(400).send({ error: 'to_branch is required' });
        try {
            const result = await gitOperationService.mergeBranch(project, fromBranch, toBranch);
            return result;
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err.message });
        }
    });}

module.exports = { registerProjectGitRoutes };
