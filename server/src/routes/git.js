/**
 * Generic Git provider routes — /api/v1/git/*
 *
 * These routes work with any registered provider (github, gitlab, gitea, …).
 * The legacy /api/v1/github/* routes continue to work unchanged; see
 * registerGitHubRoutes() in routes/github.js.
 */
const { eq, and } = require('drizzle-orm');
const crypto = require('crypto');

const { db } = require('../db/index');
const schema = require('../db/schema');
const { GitConnectionService, getProviderConfig } = require('../git/GitConnectionService');
const { MergeRequestService } = require('../git/MergeRequestService');
const { GitOperationService } = require('../git/GitOperationService');
const { listProviders, getProvider, hasProvider } = require('../git/providers/registry');
const { projectDir } = require('../workspace');
const policy = require('../auth/PolicyService');
const { scaffoldXEnsembleWithFs } = require('../repositories/RepositoryEnvironmentService');
const { getRuntime } = require('../runtime/registry');
const { t } = require('../i18n');

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function callbackHtml(success, message, provider) {
    const title = success ? 'Git Connected' : 'Git Connection Failed';
    const body = success
        ? 'Connected successfully. This window will close automatically.'
        : escapeHtml(message || 'Failed to connect. Please try again.');
    const payload = JSON.stringify({
        type: 'git-oauth-result',
        provider: provider || null,
        status: success ? 'success' : 'error',
        message: success ? null : String(message || 'Failed to connect'),
    }).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f6f8fa;color:#1f2328}.card{background:#fff;border:1px solid #d1d9e0;border-radius:8px;padding:32px;max-width:480px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,.05)}h1{font-size:20px;margin:0 0 12px}p{margin:0;line-height:1.5;color:#656d76}.error h1{color:#cf222e}</style>
</head><body class="${success ? '' : 'error'}"><div class="card"><h1>${title}</h1><p>${body}</p></div>
<script>
(function(){
  try{
    if(window.opener&&!window.opener.closed){
      var origins=${JSON.stringify(
        (process.env.ALLOWED_ORIGINS || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )};
      if(!origins.length){window.opener.postMessage(${payload},'*');}
      else{for(var i=0;i<origins.length;i++){try{window.opener.postMessage(${payload},origins[i]);}catch(e){}}}
    }
  }catch(e){}
  if(${success ? 'true' : 'false'}){setTimeout(function(){window.close();},1200);}
})();
</script>
</body></html>`;
}

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

const { getProjectForUser } = require('../projects/getProjectForUser');

/**
 * Resolve runtimeId from session_id (so git ops target the session's worktree).
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
 * Parse a repository URL into { provider, cloneUrl, fullName, repoName, owner }.
 * Works for any git host — provider is inferred from the URL host, not from
 * a registered account, so import-by-URL needs no prior connection.
 *
 * - https://github.com/owner/repo(.git)
 * - git@github.com:owner/repo.git
 * - https://gitlab.com/group/subgroup/repo
 * - ssh://git@gitea.com:22/owner/repo.git
 */
function resolveRepoUrl(inputUrl) {
    const raw = String(inputUrl || '').trim();
    if (!raw) return null;

    // Remember the scheme the user actually supplied (if any) so the clone URL
    // matches — intranet GitLab is HTTP-only, public github.com is HTTPS, and
    // guessing would either fail with "Connection refused" or silently rewrite
    // the user's input. We only fall back to https when the user didn't
    // specify one (bare host/path input).
    let inputScheme = null;
    const schemeMatch = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
    if (schemeMatch) {
        const s = schemeMatch[1].toLowerCase();
        if (s === 'git+ssh') inputScheme = 'ssh';
        else inputScheme = s;
    }

    let clean = raw;
    let host = null;
    let path = null;

    // ssh://[user@]host[:port]/path  (explicit scheme)
    if (/^ssh:\/\//i.test(clean)) {
        const m = clean.replace(/^ssh:\/\//i, '').match(/^(?:[^@]+@)?([^/]+?)(?::\d+)?\/(.+)$/);
        if (m) {
            host = m[1];
            path = m[2];
        } else {
            return null;
        }
    } else {
        clean = clean.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
        clean = clean.replace(/^git\+/, '');
        // scp-like form: git@host:owner/repo.git
        const scp = clean.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
        if (scp && !/^https?:\/\//i.test(clean)) {
            host = scp[1];
            path = scp[2];
            if (!inputScheme) inputScheme = 'ssh';
        } else {
            // host/path form (https, plain, www)
            const slashIdx = clean.indexOf('/');
            if (slashIdx > 0) {
                host = clean.slice(0, slashIdx);
                path = clean.slice(slashIdx + 1);
            } else {
                return null;
            }
        }
    }

    const hostname = (host || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
    const repoPath = path.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/(tree|blob|src|raw)\/.*$/, '');
    if (!repoPath) return null;

    const provider = hostname === 'github.com' ? 'github'
        : hostname === 'gitlab.com' ? 'gitlab'
        : hostname === 'gitea.com' || hostname === 'codeberg.org' ? 'gitea'
        : hostname || 'url';

    // Scheme precedence: user-provided (http/https/ssh) > https fallback.
    // We never silently downgrade https to http or vice-versa; that would
    // either fail with "Connection refused" or trigger TLS warnings.
    const cloneScheme = inputScheme || 'https';
    const cloneUrl = `${cloneScheme}://${hostname}/${repoPath}.git`;
    const segments = repoPath.split('/').filter(Boolean);
    const repoName = segments[segments.length - 1] || 'project';
    const owner = segments.slice(0, -1).join('/') || null;

    return { provider, cloneUrl, fullName: repoPath, repoName, owner, hostname };
}

/**
 * Probe the default branch of a repo by URL using `git ls-remote --symref`
 * (no auth needed for public repos). Returns branch name or 'main'.
 */
async function probeDefaultBranch(repoUrl) {
    const { hostGit } = require('../git/hostGit');
    try {
        const { stdout } = await hostGit(process.cwd(), ['ls-remote', '--symref', repoUrl, 'HEAD'], { timeoutMs: 30_000 });
        const match = stdout.match(/ref: refs\/heads\/([^\s]+)\s+HEAD/);
        return match?.[1] || 'main';
    } catch {
        return 'main';
    }
}

function registerGitRoutes(fastify) {
    const connectionService = new GitConnectionService();
    const mergeRequestService = new MergeRequestService();
    const gitOperationService = new GitOperationService();
    const runtime = getRuntime();

    // ── Provider discovery ──

    fastify.get('/api/v1/git/providers', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async () => {
        const names = listProviders();
        const providers = await Promise.all(names.map(async (name) => {
            const p = getProvider(name);
            const config = await getProviderConfig(name);
            return {
                name: p.name,
                display_name: p.displayName,
                pr_terminology: p.prTerminology,
                oauth_configured: Boolean(config?.clientId),
            };
        }));
        return { providers };
    });

    // ── Connections ──

    fastify.get('/api/v1/git/connections', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request) => {
        const connections = await connectionService.listConnections(request.user.id);
        return { connections };
    });

    fastify.get('/api/v1/git/connections/:provider', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const connection = await connectionService.getConnection(request.user.id, request.params.provider);
        if (!connection) return reply.code(404).send({ error: t('errors:provider_not_connected', { defaultValue: '{{provider}} not connected', provider: request.params.provider }, request.locale || 'en'), code: 'provider_not_connected' });
        return connection;
    });

    // ── OAuth ──

    fastify.post('/api/v1/git/connect', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const provider = request.body?.provider || 'github';
        try {
            const result = await connectionService.initiateOAuth(request.user.id, provider);
            return { auth_url: result.authUrl, provider: result.provider };
        } catch (err) {
            request.log.error(err);
            const code = err.message.includes('not configured') ? 503 : 500;
            return reply.code(code).send({ error: err.message });
        }
    });

    fastify.get('/api/v1/git/callback', async (request, reply) => {
        const { code, state } = request.query || {};
        try {
            const connection = await connectionService.completeOAuthFromCallback(code, state);
            return reply.type('text/html').send(callbackHtml(true, null, connection?.provider));
        } catch (err) {
            request.log.error(err);
            return reply.type('text/html').code(400).send(callbackHtml(false, err.message));
        }
    });

    fastify.post('/api/v1/git/callback', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const { code, state } = request.body || {};
        try {
            const connection = await connectionService.completeOAuthFromDesktop(
                request.user.id, code, state);
            return { connection };
        } catch (err) {
            request.log.error(err);
            return reply.code(400).send({ error: err.message });
        }
    });

    fastify.delete('/api/v1/git/connections/:provider', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        try {
            await connectionService.disconnect(request.user.id, request.params.provider);
            return { ok: true };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: t('errors:disconnect_failed', { defaultValue: 'Failed to disconnect' }, request.locale || 'en'), code: 'disconnect_failed' });
        }
    });

    fastify.post('/api/v1/git/connections/:provider/pat', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const { token } = request.body || {};
        if (!token || typeof token !== 'string' || !token.trim()) {
            return reply.code(400).send({ error: t('errors:pat_required', { defaultValue: 'A personal access token is required' }, request.locale || 'en'), code: 'pat_required' });
        }
        try {
            return await connectionService.connectWithPat(request.user.id, request.params.provider, token);
        } catch (err) {
            request.log.error(err);
            return reply.code(400).send({ error: err.message });
        }
    });

    // ── Repos ──

    fastify.get('/api/v1/git/repos', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const providerName = request.query?.provider || 'github';
        try {
            const token = await connectionService.getDecryptedToken(request.user.id, providerName);
            const provider = getProvider(providerName);
            const config = await getProviderConfig(providerName);
            const { page, per_page, affiliation } = request.query || {};
            const result = await provider.listUserRepos(token, {
                page: page ? Number(page) : 1,
                perPage: per_page ? Number(per_page) : 30,
                affiliation,
                apiBase: config?.apiBase,
            });
            return result;
        } catch (err) {
            request.log.error(err);
            if (err.message.includes('not_connected')) {
                return reply.code(400).send({ error: t('errors:provider_account_not_connected', { defaultValue: '{{provider}} account not connected', provider: providerName }, request.locale || 'en'), code: 'provider_account_not_connected' });
            }
            const isAuthError = err.code === 'token_expired' || err.status === 401;
            if (isAuthError) {
                return reply.code(400).send({ error: `${providerName} token 已过期或无效，请重新认证`, code: 'REAUTH_REQUIRED' });
            }
            return reply.code(err.status || 500).send({ error: err.message });
        }
    });

    fastify.get('/api/v1/git/repos/*', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const providerName = request.query?.provider || 'github';
        // Wildcard captures the full path: owner/repo (GitHub, Gitea) or group/subgroup/repo (GitLab)
        const repoPath = request.params['*'];
        if (!repoPath) return reply.code(400).send({ error: t('errors:repo_path_required', { defaultValue: 'repo path is required' }, request.locale || 'en'), code: 'repo_path_required' });
        try {
            const token = await connectionService.getDecryptedToken(request.user.id, providerName);
            const provider = getProvider(providerName);
            const config = await getProviderConfig(providerName);
            const repoInfo = await provider.getRepo(token, repoPath, { apiBase: config?.apiBase });
            return { repo: repoInfo };
        } catch (err) {
            request.log.error(err);
            if (err.message.includes('not_connected')) {
                return reply.code(400).send({ error: t('errors:provider_account_not_connected', { defaultValue: '{{provider}} account not connected', provider: providerName }, request.locale || 'en'), code: 'provider_account_not_connected' });
            }
            const isAuthError = err.code === 'token_expired' || err.status === 401;
            if (isAuthError) {
                return reply.code(400).send({ error: `${providerName} token 已过期或无效，请重新认证`, code: 'REAUTH_REQUIRED' });
            }
            return reply.code(err.status || 500).send({ error: err.message });
        }
    });

    // ── Import ──

    fastify.post('/api/v1/projects/import-git', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const quotaCheck = await policy.checkQuota(request.user.id, 'projects', request.user.role);
        if (!quotaCheck.ok) return policy.quotaErrorReply(reply, quotaCheck);

        const body = request.body || {};
        let providerName = body.provider || 'github';
        const {
            repo_full_name,
            repo_url,
            name,
            branch,
            auto_create_branch,
            work_branch_name,
        } = body;

        // ── URL-based import (no provider connection required) ──
        // Parse provider/cloneUrl from the URL itself. Works for any git host
        // (github/gitlab/gitea/other); a matching account connection is only
        // needed later for push/PR, not for import.
        const parsedUrl = repo_url ? resolveRepoUrl(repo_url) : null;
        if (repo_url && !parsedUrl) {
            return reply.code(400).send({ error: t('errors:invalid_repo_url', { defaultValue: 'Invalid repository URL' }, request.locale || 'en'), code: 'invalid_repo_url' });
        }

        const projectName = String(name || (parsedUrl ? parsedUrl.repoName : '') || (repo_full_name || '').split('/').pop() || 'project').trim();
        if (!projectName) return reply.code(400).send({ error: t('errors:name_required', { defaultValue: 'name is required' }, request.locale || 'en'), code: 'name_required' });

        if (!repo_url) {
            if (!repo_full_name) {
                return reply.code(400).send({ error: t('errors:repo_full_name_required', { defaultValue: 'repo_full_name is required' }, request.locale || 'en'), code: 'repo_full_name_required' });
            }
            if (!hasProvider(providerName)) {
                return reply.code(400).send({ error: t('errors:unknown_provider', { defaultValue: 'Unknown provider: {{provider}}', provider: providerName }, request.locale || 'en'), code: 'unknown_provider' });
            }
        }

        let token;
        let connection;
        let repoInfo;
        if (parsedUrl) {
            // URL import: no account connection needed. If a connection for the
            // inferred provider happens to exist, use its token for the clone
            // (helps with private repos); otherwise clone publicly.
            const resolvedProvider = hasProvider(parsedUrl.provider) ? parsedUrl.provider : 'url';
            try {
                connection = await connectionService.getConnection(request.user.id, resolvedProvider).catch(() => null);
                token = connection ? await connectionService.getDecryptedToken(request.user.id, resolvedProvider).catch(() => null) : null;
            } catch (_) {
                token = null;
            }
            const defaultBranch = branch || await probeDefaultBranch(parsedUrl.cloneUrl);
            repoInfo = {
                cloneUrl: parsedUrl.cloneUrl,
                defaultBranch,
                fullName: parsedUrl.fullName,
                id: null,
                name: parsedUrl.repoName,
            };
            providerName = resolvedProvider;
        } else {
            try {
                connection = await connectionService.getConnection(request.user.id, providerName);
                if (!connection) return reply.code(400).send({ error: t('errors:provider_account_not_connected', { defaultValue: '{{provider}} account not connected', provider: providerName }, request.locale || 'en'), code: 'provider_account_not_connected' });
                token = await connectionService.getDecryptedToken(request.user.id, providerName);
                const provider = getProvider(providerName);
                const { getProviderConfig } = require('../git/GitConnectionService');
                const config = await getProviderConfig(providerName);
                repoInfo = await provider.getRepo(token, repo_full_name, { apiBase: config?.apiBase });
            } catch (err) {
                request.log.error(err);
                if (err.message.includes('not_connected')) {
                    return reply.code(400).send({ error: t('errors:provider_account_not_connected', { defaultValue: '{{provider}} account not connected', provider: providerName }, request.locale || 'en'), code: 'provider_account_not_connected' });
                }
                const isAuthError = err.code === 'token_expired' || err.status === 401;
                if (isAuthError) {
                    return reply.code(400).send({ error: `${providerName} token 已过期或无效，请重新认证`, code: 'REAUTH_REQUIRED' });
                }
                return reply.code(err.status || 500).send({ error: err.message });
            }
        }

        const projectId = newId('proj');
        const userId = request.user.id;
        const serverPath = projectDir(userId, projectId);
        const createdAt = Date.now();
        const baseBranch = branch || repoInfo.defaultBranch || 'main';
        const autoCreateBranch = auto_create_branch !== false;
        const workBranchName = work_branch_name || `skyharness/workspace-${Date.now().toString(36).slice(-4)}`;
        const currentBranch = autoCreateBranch ? workBranchName : baseBranch;

        const projectRow = {
            id: projectId,
            userId,
            name: projectName,
            serverPath,
            repoProvider: providerName,
            repoUrl: repoInfo.cloneUrl,
            repoDefaultBranch: repoInfo.defaultBranch || 'main',
            repoTokenSecretRef: connection?.id || null,
            workspaceMode: 'git',
            remoteRepoId: repoInfo.id || null,
            remoteFullName: repoInfo.fullName || repo_full_name,
            // Legacy GitHub-specific fields for backward compat
            githubRepoId: providerName === 'github' ? Number(repoInfo.id) || null : null,
            githubFullName: providerName === 'github' ? (repoInfo.fullName || repo_full_name) : null,
            currentBranch,
            cloneStatus: 'cloning',
            createdAt,
        };

        try {
            await db.insert(schema.projects).values(projectRow);
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: t('errors:create_project_record_failed', { defaultValue: 'Failed to create project record' }, request.locale || 'en'), code: 'create_project_record_failed' });
        }

        const { ensureProjectRuntime } = require('../runtime/RuntimeService');
        const project = { ...projectRow };

        (async () => {
            try {
                const ready = await ensureProjectRuntime(project);
                // Update the in-memory project object so that subsequent
                // _execGit -> ensureProjectRuntime calls use the fast path
                // (cached runtime row) instead of re-entering ensureReady,
                // which can trigger a VM delete+recreate race.
                if (ready?.runtime?.id) {
                    project.defaultRuntimeId = ready.runtime.id;
                }

                const cloneResult = await gitOperationService.cloneRepo(project, {
                    repoUrl: repoInfo.cloneUrl,
                    branch: baseBranch,
                });

                let branchSha = cloneResult.sha;
                if (autoCreateBranch) {
                    const createResult = await gitOperationService.createBranch(
                        project, workBranchName, baseBranch);
                    branchSha = createResult.sha;
                }

                await scaffoldXEnsembleWithFs(ready.hostWorkspacePath || ready.workspacePath, {
                    baseBranch,
                    autoCommitOnExit: true,
                });

                await db.update(schema.projects)
                    .set({ cloneStatus: 'ready', cloneError: null })
                    .where(eq(schema.projects.id, projectId));
            } catch (err) {
                request.log.error(err, `Git import failed for project ${projectId}`);
                await db.update(schema.projects)
                    .set({ cloneStatus: 'failed', cloneError: err.message })
                    .where(eq(schema.projects.id, projectId));
            }
        })();

        return reply.code(202).send({
            id: projectId,
            name: projectName,
            provider: providerName,
            remote_full_name: repoInfo.fullName || repo_full_name,
            repo_url: repoInfo.cloneUrl,
            current_branch: currentBranch,
            status: 'cloning',
            created_at: createdAt,
        });
    });

    // ── Merge Requests (generic) ──

    fastify.get('/api/v1/projects/:id/merge-requests', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        try {
            await mergeRequestService.syncAll(project);
        } catch (_) {}
        const rows = await mergeRequestService.list(project.id);
        // 附上当前用户在该仓库的写权限（决定前端是否显示 merge/approve/close 等按钮）
        const permissions = await mergeRequestService.getCurrentUserPermissions(project, request.user.id);
        return { merge_requests: rows, permissions };
    });

    fastify.post('/api/v1/projects/:id/merge-requests', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        try {
            // Resolve runtimeId from session_id so fetchAndRebase/push operate
            // on the session's worktree, not the bare main repo.
            const runtimeId = await resolveRuntimeId(
                request.user.id,
                request.body?.session_id || request.query?.session_id,
            );
            const gitOperationService = new GitOperationService({ runtimeId });
            const mergeRequestService = new MergeRequestService({ gitOperationService });
            const record = await mergeRequestService.create(
                project, request.body || {}, request.user.id);
            return reply.code(201).send(record);
        } catch (err) {
            request.log.error(err);
            const isAuthError = err.code === 'token_expired'
                || err.code === 'github_not_connected'
                || err.code === 'insufficient_scope'
                || /Authentication failed|auth|credential|forbidden|unauthorized/i.test(err.message || '');
            if (isAuthError) {
                return reply.code(400).send({
                    error: 'Git token 已过期或无效，请重新认证',
                    code: 'REAUTH_REQUIRED',
                });
            }
            if (err.code === 'rebase_conflict') {
                return reply.code(409).send({ error: err.message, code: 'rebase_conflict' });
            }
            return reply.code(400).send({ error: err.message });
        }
    });

    fastify.get('/api/v1/projects/:id/merge-requests/:mrId', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        try { await mergeRequestService.sync(project, request.params.mrId); } catch (_) {}
        const record = await mergeRequestService.get(request.params.mrId);
        if (!record || record.projectId !== project.id) {
            return reply.code(404).send({ error: t('errors:merge_request_not_found', { defaultValue: 'Merge request not found' }, request.locale || 'en'), code: 'merge_request_not_found' });
        }
        const permissions = await mergeRequestService.getCurrentUserPermissions(project, request.user.id);
        return { ...record, permissions };
    });

    fastify.post('/api/v1/projects/:id/merge-requests/:mrId/sync', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        try {
            const record = await mergeRequestService.sync(project, request.params.mrId);
            if (!record || record.projectId !== project.id) {
                return reply.code(404).send({ error: t('errors:merge_request_not_found', { defaultValue: 'Merge request not found' }, request.locale || 'en'), code: 'merge_request_not_found' });
            }
            return record;
        } catch (err) {
            request.log.error(err);
            return reply.code(400).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/projects/:id/merge-requests/sync-all', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        try {
            const result = await mergeRequestService.syncAll(project);
            const rows = await mergeRequestService.list(project.id);
            return { ...result, merge_requests: rows };
        } catch (err) {
            request.log.error(err);
            return reply.code(400).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/projects/:id/merge-requests/:mrId/merge', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        try {
            const result = await mergeRequestService.mergePR(project, request.params.mrId);
            return result;
        } catch (err) {
            request.log.error(err);
            const isAuth = err.code === 'token_expired' || err.status === 401;
            return reply.code(isAuth ? 400 : 500).send({ error: err.message, code: isAuth ? 'REAUTH_REQUIRED' : undefined });
        }
    });

    fastify.post('/api/v1/projects/:id/merge-requests/:mrId/close', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        try {
            const result = await mergeRequestService.closePR(project, request.params.mrId);
            return result;
        } catch (err) {
            request.log.error(err);
            const isAuth = err.code === 'token_expired' || err.status === 401;
            return reply.code(isAuth ? 400 : 500).send({ error: err.message, code: isAuth ? 'REAUTH_REQUIRED' : undefined });
        }
    });

    fastify.post('/api/v1/projects/:id/merge-requests/:mrId/reopen', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        try {
            const result = await mergeRequestService.reopenPR(project, request.params.mrId);
            return result;
        } catch (err) {
            request.log.error(err);
            const isAuth = err.code === 'token_expired' || err.status === 401;
            return reply.code(isAuth ? 400 : 500).send({ error: err.message, code: isAuth ? 'REAUTH_REQUIRED' : undefined });
        }
    });

    fastify.post('/api/v1/projects/:id/merge-requests/:mrId/approve', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        try {
            const result = await mergeRequestService.approvePR(project, request.params.mrId);
            return result;
        } catch (err) {
            request.log.error(err);
            if (err.code === 'already_approved') {
                return reply.code(409).send({ error: t('git:toast.already_approved', { defaultValue: 'You have already approved this merge request.' }, request.locale || 'en'), code: 'already_approved' });
            }
            const isAuth = err.code === 'token_expired' || err.status === 401;
            return reply.code(isAuth ? 400 : 500).send({ error: err.message, code: isAuth ? 'REAUTH_REQUIRED' : undefined });
        }
    });

    fastify.post('/api/v1/projects/:id/merge-requests/:mrId/comments', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const body = request.body?.body;
        if (!body || !String(body).trim()) {
            return reply.code(400).send({ error: t('errors:comment_body_required', { defaultValue: 'Comment body is required' }, request.locale || 'en'), code: 'comment_body_required' });
        }
        try {
            const result = await mergeRequestService.addComment(project, request.params.mrId, String(body).trim());
            return reply.code(201).send(result);
        } catch (err) {
            request.log.error(err);
            const isAuth = err.code === 'token_expired' || err.status === 401;
            return reply.code(isAuth ? 400 : 500).send({ error: err.message, code: isAuth ? 'REAUTH_REQUIRED' : undefined });
        }
    });

    // Reply to an inline review comment
    fastify.post('/api/v1/projects/:id/merge-requests/:mrId/comments/:commentId/reply', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const body = request.body?.body;
        if (!body || !String(body).trim()) {
            return reply.code(400).send({ error: t('errors:comment_body_required', { defaultValue: 'Comment body is required' }, request.locale || 'en'), code: 'comment_body_required' });
        }
        try {
            const result = await mergeRequestService.replyToReviewComment(
                project, request.params.mrId, request.params.commentId, String(body).trim(),
                { discussionId: request.body?.discussionId },
            );
            return reply.code(201).send(result);
        } catch (err) {
            request.log.error(err);
            const isAuth = err.code === 'token_expired' || err.status === 401;
            return reply.code(isAuth ? 400 : 500).send({ error: err.message, code: isAuth ? 'REAUTH_REQUIRED' : undefined });
        }
    });

    // Edit a comment (review or issue)
    fastify.put('/api/v1/projects/:id/merge-requests/:mrId/comments/:commentId', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const body = request.body?.body;
        if (!body || !String(body).trim()) {
            return reply.code(400).send({ error: t('errors:comment_body_required', { defaultValue: 'Comment body is required' }, request.locale || 'en'), code: 'comment_body_required' });
        }
        const commentType = request.query?.type || 'issue';
        try {
            const result = await mergeRequestService.editComment(
                project, request.params.mrId, request.params.commentId,
                String(body).trim(), commentType,
            );
            return result;
        } catch (err) {
            request.log.error(err);
            const isAuth = err.code === 'token_expired' || err.status === 401;
            return reply.code(isAuth ? 400 : 500).send({ error: err.message, code: isAuth ? 'REAUTH_REQUIRED' : undefined });
        }
    });

    // Delete a comment (review or issue)
    fastify.delete('/api/v1/projects/:id/merge-requests/:mrId/comments/:commentId', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const commentType = request.query?.type || 'issue';
        try {
            const result = await mergeRequestService.deleteComment(
                project, request.params.mrId, request.params.commentId, commentType,
            );
            return result;
        } catch (err) {
            request.log.error(err);
            const isAuth = err.code === 'token_expired' || err.status === 401;
            return reply.code(isAuth ? 400 : 500).send({ error: err.message, code: isAuth ? 'REAUTH_REQUIRED' : undefined });
        }
    });

    // ── MR Reviews / Comments / Files (read-only, via MergeRequestService) ──

    fastify.get('/api/v1/projects/:id/merge-requests/:mrId/reviews', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        try {
            const reviews = await mergeRequestService.listReviews(project, request.params.mrId);
            return { reviews };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: t('errors:fetch_reviews_failed', { defaultValue: 'Failed to fetch reviews' }, request.locale || 'en'), code: 'fetch_reviews_failed' });
        }
    });

    fastify.get('/api/v1/projects/:id/merge-requests/:mrId/comments', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        try {
            const page = request.query?.page ? Number(request.query.page) : 1;
            const perPage = request.query?.per_page ? Number(request.query.per_page) : 30;
            const comments = await mergeRequestService.listReviewComments(project, request.params.mrId, { page, perPage });
            return { comments };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: t('errors:fetch_review_comments_failed', { defaultValue: 'Failed to fetch review comments' }, request.locale || 'en'), code: 'fetch_review_comments_failed' });
        }
    });

    fastify.get('/api/v1/projects/:id/merge-requests/:mrId/issue-comments', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        try {
            const page = request.query?.page ? Number(request.query.page) : 1;
            const perPage = request.query?.per_page ? Number(request.query.per_page) : 30;
            const comments = await mergeRequestService.listIssueComments(project, request.params.mrId, { page, perPage });
            return { comments };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: t('errors:fetch_issue_comments_failed', { defaultValue: 'Failed to fetch issue comments' }, request.locale || 'en'), code: 'fetch_issue_comments_failed' });
        }
    });

    fastify.get('/api/v1/projects/:id/merge-requests/:mrId/files', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        try {
            const files = await mergeRequestService.listMrFiles(project, request.params.mrId);
            return { files };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: t('errors:fetch_mr_files_failed', { defaultValue: 'Failed to fetch MR files' }, request.locale || 'en'), code: 'fetch_mr_files_failed' });
        }
    });
}

module.exports = { registerGitRoutes };
