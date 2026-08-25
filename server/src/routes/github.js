const { eq, and } = require('drizzle-orm');
const crypto = require('crypto');

const { GitConnectionService } = require('../github/GitConnectionService');
const { GitHubService } = require('../github/GitHubService');
const { GitOperationService } = require('../github/GitOperationService');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { projectDir } = require('../workspace');
const policy = require('../auth/PolicyService');
const { scaffoldXEnsemble } = require('../repositories/RepositoryEnvironmentService');
const { t } = require('../i18n');

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function callbackHtml(success, message) {
    const title = success ? 'GitHub Connected' : 'GitHub Connection Failed';
    const body = success
        ? 'GitHub connected. This window will close automatically.'
        : escapeHtml(message || 'Failed to connect GitHub. Please try again.');
    const payload = JSON.stringify({
        type: 'git-oauth-result',
        provider: 'github',
        status: success ? 'success' : 'error',
        message: success ? null : String(message || 'Failed to connect GitHub'),
    }).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f6f8fa; color: #1f2328; }
    .card { background: #fff; border: 1px solid #d1d9e0; border-radius: 8px; padding: 32px; max-width: 480px; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    h1 { font-size: 20px; margin: 0 0 12px; }
    p { margin: 0; line-height: 1.5; color: #656d76; }
    .error h1 { color: #cf222e; }
  </style>
</head>
<body class="${success ? '' : 'error'}">
  <div class="card">
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
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
</body>
</html>`;
}

const { getProjectForUser } = require('../projects/getProjectForUser');

function parseRepoFullName(fullName) {
    if (!fullName || typeof fullName !== 'string') {
        throw new Error('github_repo_full_name is required');
    }
    const [owner, repo, ...rest] = fullName.split('/');
    if (!owner || !repo || rest.length > 0) {
        throw new Error(`Invalid github_repo_full_name format: ${fullName}`);
    }
    return { owner, repo };
}

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
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

function registerGitHubRoutes(fastify) {
    const connectionService = new GitConnectionService();
    const gitHubService = new GitHubService();
    const gitOperationService = new GitOperationService();

    fastify.get('/api/v1/github/connection', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const connection = await connectionService.getConnection(request.user.id);
        if (!connection) {
            return reply.code(404).send({ error: t('errors:github_not_connected', { defaultValue: 'GitHub not connected' }, request.locale || 'en'), code: 'github_not_connected' });
        }
        return connection;
    });

    fastify.post('/api/v1/github/connect', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        try {
            const result = await connectionService.initiateOAuth(request.user.id);
            return { auth_url: result.authUrl };
        } catch (err) {
            request.log.error(err);
            const code = err.message === 'GitHub OAuth is not configured' ? 503 : 500;
            return reply.code(code).send({ error: err.message });
        }
    });

    fastify.get('/api/v1/github/callback', async (request, reply) => {
        const { code, state } = request.query || {};
        try {
            await connectionService.completeOAuthFromCallback(code, state);
            return reply.type('text/html').send(callbackHtml(true));
        } catch (err) {
            request.log.error(err);
            return reply.type('text/html').code(400).send(callbackHtml(false, err.message));
        }
    });

    fastify.post('/api/v1/github/callback', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const { code, state } = request.body || {};
        try {
            const connection = await connectionService.completeOAuthFromDesktop(
                request.user.id,
                code,
                state,
            );
            return { connection };
        } catch (err) {
            request.log.error(err);
            return reply.code(400).send({ error: err.message });
        }
    });

    fastify.delete('/api/v1/github/connection', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        try {
            await connectionService.disconnect(request.user.id);
            return { ok: true };
        } catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: t('errors:disconnect_failed', { defaultValue: 'Failed to disconnect GitHub' }, request.locale || 'en'), code: 'disconnect_failed' });
        }
    });

    fastify.get('/api/v1/github/repos', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        try {
            const token = await connectionService.getDecryptedToken(request.user.id);
            const { page, per_page, affiliation } = request.query || {};
            const repos = await gitHubService.listUserRepos(token, {
                page: page ? Number(page) : 1,
                perPage: per_page ? Number(per_page) : 30,
                affiliation,
            });
            return { repos };
        } catch (err) {
            request.log.error(err);
            if (err.message === 'github_not_connected') {
                return reply.code(400).send({ error: t('errors:github_account_not_connected', { defaultValue: 'GitHub account not connected' }, request.locale || 'en'), code: 'github_account_not_connected' });
            }
            const isAuthError = err.code === 'token_expired' || err.status === 401;
            if (isAuthError) {
                return reply.code(400).send({ error: 'GitHub token 已过期或无效，请重新认证', code: 'REAUTH_REQUIRED' });
            }
            const code = err.status || 500;
            return reply.code(code).send({ error: err.message });
        }
    });

    fastify.get('/api/v1/github/repos/:owner/:repo', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        try {
            const token = await connectionService.getDecryptedToken(request.user.id);
            const { owner, repo } = request.params;
            const repository = await gitHubService.getRepo(token, owner, repo);
            return { repo: repository };
        } catch (err) {
            request.log.error(err);
            if (err.message === 'github_not_connected') {
                return reply.code(400).send({ error: t('errors:github_account_not_connected', { defaultValue: 'GitHub account not connected' }, request.locale || 'en'), code: 'github_account_not_connected' });
            }
            const isAuthError = err.code === 'token_expired' || err.status === 401;
            if (isAuthError) {
                return reply.code(400).send({ error: 'GitHub token 已过期或无效，请重新认证', code: 'REAUTH_REQUIRED' });
            }
            const code = err.status || 500;
            return reply.code(code).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/projects/import-github', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const quotaCheck = await policy.checkQuota(request.user.id, 'projects', request.user.role);
        if (!quotaCheck.ok) return policy.quotaErrorReply(reply, quotaCheck);

        const {
            github_repo_full_name,
            name,
            branch,
            auto_create_branch,
            work_branch_name,
        } = request.body || {};

        let owner;
        let repo;
        try {
            ({ owner, repo } = parseRepoFullName(github_repo_full_name));
        } catch (err) {
            return reply.code(400).send({ error: err.message });
        }

        const projectName = String(name || repo).trim();
        if (!projectName) {
            return reply.code(400).send({ error: t('errors:name_required', { defaultValue: 'name is required' }, request.locale || 'en'), code: 'name_required' });
        }

        let token;
        let connection;
        let ghRepo;
        try {
            connection = await connectionService.getConnection(request.user.id);
            if (!connection) {
                return reply.code(400).send({ error: t('errors:github_account_not_connected', { defaultValue: 'GitHub account not connected' }, request.locale || 'en'), code: 'github_account_not_connected' });
            }
            token = await connectionService.getDecryptedToken(request.user.id);
            ghRepo = await gitHubService.getRepo(token, owner, repo);
        } catch (err) {
            request.log.error(err);
            if (err.message === 'github_not_connected') {
                return reply.code(400).send({ error: t('errors:github_account_not_connected', { defaultValue: 'GitHub account not connected' }, request.locale || 'en'), code: 'github_account_not_connected' });
            }
            const isAuthError = err.code === 'token_expired' || err.status === 401;
            if (isAuthError) {
                return reply.code(400).send({ error: 'GitHub token 已过期或无效，请重新认证', code: 'REAUTH_REQUIRED' });
            }
            const code = err.status || 500;
            return reply.code(code).send({ error: err.message });
        }

        const projectId = newId('proj');
        const userId = request.user.id;
        const serverPath = projectDir(userId, projectId);
        const createdAt = Date.now();
        const baseBranch = branch || ghRepo.default_branch || 'main';
        const autoCreateBranch = auto_create_branch !== false;
        const workBranchName = work_branch_name || `skyharness/workspace-${Date.now().toString(36).slice(-4)}`;
        const currentBranch = autoCreateBranch ? workBranchName : baseBranch;

        const projectRow = {
            id: projectId,
            userId,
            name: projectName,
            serverPath,
            repoProvider: 'github',
            repoUrl: ghRepo.clone_url,
            repoDefaultBranch: ghRepo.default_branch || 'main',
            repoTokenSecretRef: connection.id,
            workspaceMode: 'git',
            githubRepoId: ghRepo.id || null,
            githubFullName: ghRepo.full_name || github_repo_full_name,
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
                const workspacePath = ready?.workspacePath;
                // Update the in-memory project object so that subsequent
                // _execGit -> ensureProjectRuntime calls use the fast path
                // (cached runtime row) instead of re-entering ensureReady,
                // which can trigger a VM delete+recreate race.
                if (ready?.runtime?.id) {
                    project.defaultRuntimeId = ready.runtime.id;
                }
                const cloneResult = await gitOperationService.cloneRepo(project, {
                    repoUrl: ghRepo.clone_url,
                    branch: baseBranch,
                });

                let branchSha = cloneResult.sha;
                if (autoCreateBranch) {
                    const createResult = await gitOperationService.createBranch(
                        project,
                        workBranchName,
                        baseBranch,
                    );
                    branchSha = createResult.sha;
                }

                await scaffoldXEnsemble(workspacePath, {
                    baseBranch,
                    autoCommitOnExit: true,
                });

                await db.update(schema.projects)
                    .set({ cloneStatus: 'ready', cloneError: null })
                    .where(eq(schema.projects.id, projectId));

                await upsertProjectBranch(projectId, currentBranch, {
                    baseBranch,
                    isActive: true,
                    lastCommitSha: branchSha,
                });
            } catch (err) {
                request.log.error(err, `GitHub import failed for project ${projectId}`);
                await db.update(schema.projects)
                    .set({ cloneStatus: 'failed', cloneError: err.message })
                    .where(eq(schema.projects.id, projectId));
            }
        })();

        return reply.code(202).send({
            id: projectId,
            name: projectName,
            github_full_name: ghRepo.full_name || github_repo_full_name,
            repo_url: ghRepo.clone_url || `https://github.com/${owner}/${repo}.git`,
            current_branch: currentBranch,
            status: 'cloning',
            created_at: createdAt,
        });
    });
}

module.exports = { registerGitHubRoutes };
