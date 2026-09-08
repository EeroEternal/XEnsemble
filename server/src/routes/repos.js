/**
 * project_repos REST API — /api/v1/projects/:id/repos
 *
 * 仅 CRUD（不涉及 clone、import、merge 等流程），
 * clone/import 由 /api/v1/projects/import-git 在 batch 入口处统一处理。
 *
 * 文件不修改任何现有 server.js / route 注册逻辑 — 调用方需在 server.js
 * 中显式调用 registerRepoRoutes(fastify) 来启用。
 */

const { eq, and } = require('drizzle-orm');
const { ProjectRepoService } = require('../repos/ProjectRepoService');
const { t } = require('../i18n');

function registerRepoRoutes(fastify, deps = {}) {
  if (!deps.db) {
    throw new Error('registerRepoRoutes: db is required (use { db, schema: { projectRepos } })');
  }
  if (!deps.schema || !deps.schema.projectRepos) {
    throw new Error('registerRepoRoutes: schema.projectRepos is required');
  }
  if (!deps.getProjectForUser) {
    throw new Error('registerRepoRoutes: getProjectForUser is required');
  }
  const svc = new ProjectRepoService({
    db: deps.db,
    projectReposTable: deps.schema.projectRepos,
  });
  const getProjectForUser = deps.getProjectForUser;
  const auth = deps.auth || (fastify.authenticate && fastify.requireActive
    ? { authenticate: fastify.authenticate, requireActive: fastify.requireActive }
    : null);
  if (!auth) {
    throw new Error('registerRepoRoutes: fastify.authenticate + requireActive decorators required');
  }

  fastify.get('/api/v1/projects/:id/repos', {
    preValidation: [auth.authenticate, auth.requireActive],
  }, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.id);
    if (!project) {
      return reply.code(404).send({
        error: t('errors:project_not_found', {}, request.locale || 'en'),
        code: 'project_not_found',
      });
    }
    const repos = await svc.listByProject(project.id);
    return { repos };
  });

  fastify.post('/api/v1/projects/:id/repos', {
    preValidation: [auth.authenticate, auth.requireActive],
  }, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.id);
    if (!project) {
      return reply.code(404).send({
        error: t('errors:project_not_found', {}, request.locale || 'en'),
        code: 'project_not_found',
      });
    }
    const body = request.body || {};
    if (!body.sub_path || !body.repo_url) {
      return reply.code(400).send({
        error: 'sub_path, repo_url are required',
        code: 'invalid_input',
      });
    }
    try {
      // 重试语义：同 sub_path 已存在且 clone 失败/中断 → 复用行重新 clone；
      // 其余情况仍走唯一索引 409
      const existing = await svc.getBySubPath(project.id, body.sub_path);
      let repo;
      if (existing && ['failed', 'interrupted'].includes(existing.cloneStatus)) {
        await svc.updateCloneStatus(existing.id, 'cloning', null);
        repo = { ...existing, cloneStatus: 'cloning', cloneError: null };
      } else {
        repo = await svc.addRepo({
          projectId: project.id,
          role: body.role || 'custom',
          subPath: body.sub_path,
          repoProvider: body.repo_provider || 'url',
          repoUrl: body.repo_url,
          repoDefaultBranch: body.repo_default_branch || 'main',
          isPrimary: !!body.is_primary,
          remoteRepoId: body.remote_repo_id || null,
          remoteFullName: body.remote_full_name || null,
        });
      }
      // 异步触发 clone（best-effort，状态回写 project_repos.clone_status）
      if (body.repo_url) {
        const { multiRepoClone } = require('../repos/multiRepoClone');
        multiRepoClone(project, [{
          ...repo,
          cloneUrl: body.repo_url,
        }], { autoCreateBranch: false }).catch((e) => request.log?.error?.(e));
      }
      return reply.code(201).send({ repo });
    } catch (err) {
      if (/Invalid subPath/.test(err.message)) {
        return reply.code(400).send({ error: err.message, code: 'invalid_subpath' });
      }
      const detail = (err.cause?.message || err.detail || err.message || '').toLowerCase();
      if (detail.includes('unique') || detail.includes('duplicate')) {
        return reply.code(409).send({ error: 'sub_path already exists for this project', code: 'subpath_conflict' });
      }
      request.log?.error?.(err);
      throw err;
    }
  });

  fastify.post('/api/v1/projects/:id/repos/:repoId/primary', {
    preValidation: [auth.authenticate, auth.requireActive],
  }, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.id);
    if (!project) {
      return reply.code(404).send({
        error: t('errors:project_not_found', {}, request.locale || 'en'),
        code: 'project_not_found',
      });
    }
    const repo = await svc.getById(request.params.repoId);
    if (!repo || repo.projectId !== project.id) {
      return reply.code(404).send({
        error: t('errors:repo_not_found', {}, request.locale || 'en'),
        code: 'repo_not_found',
      });
    }
    await svc.setPrimary(project.id, repo.id);
    return { ok: true };
  });

  fastify.delete('/api/v1/projects/:id/repos/:repoId', {
    preValidation: [auth.authenticate, auth.requireActive],
  }, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.id);
    if (!project) {
      return reply.code(404).send({
        error: t('errors:project_not_found', {}, request.locale || 'en'),
        code: 'project_not_found',
      });
    }
    const repo = await svc.getById(request.params.repoId);
    if (!repo || repo.projectId !== project.id) {
      return reply.code(404).send({
        error: t('errors:repo_not_found', {}, request.locale || 'en'),
        code: 'repo_not_found',
      });
    }
    await svc.removeRepo(repo.id);
    return { ok: true };
  });
}

module.exports = { registerRepoRoutes };
