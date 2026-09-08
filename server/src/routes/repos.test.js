const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sql } = require('drizzle-orm');
const { pgTable, text, boolean, bigint, index, uniqueIndex } = require('drizzle-orm/pg-core');
const { bootstrapTestDb } = require('../test/db');

let ctx;
let db;
let schema;
let projectReposTable;
let fastify;
let token;
let registerRepoRoutes;

before(async () => {
  ctx = await bootstrapTestDb([
    '../db/index',
    '../routes/repos',
  ], __dirname);
  ({ db, schema } = ctx);
  ({ registerRepoRoutes } = ctx.reloaded['../routes/repos']);

  // 在测试中定义 projectReposTable（不修改 server/src/db/schema.js）
  projectReposTable = pgTable('project_repos', {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => schema.projects.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    subPath: text('sub_path').notNull(),
    repoProvider: text('repo_provider').notNull(),
    repoUrl: text('repo_url').notNull(),
    repoDefaultBranch: text('repo_default_branch').notNull().default('main'),
    repoInstallationRef: text('repo_installation_ref'),
    repoTokenSecretRef: text('repo_token_secret_ref'),
    isPrimary: boolean('is_primary').notNull().default(false),
    currentBranch: text('current_branch'),
    cloneStatus: text('clone_status').notNull().default('pending'),
    cloneError: text('clone_error'),
    remoteRepoId: text('remote_repo_id'),
    remoteFullName: text('remote_full_name'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  }, (t) => ({
    byProject: index('project_repos_project_id_idx').on(t.projectId),
    uniqSubPath: uniqueIndex('project_repos_project_subpath_uniq').on(t.projectId, t.subPath),
  }));

  // 手动建表（避免影响 ./drizzle/）
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS project_repos (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      sub_path TEXT NOT NULL,
      repo_provider TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      repo_default_branch TEXT NOT NULL DEFAULT 'main',
      repo_installation_ref TEXT,
      repo_token_secret_ref TEXT,
      is_primary BOOLEAN NOT NULL DEFAULT FALSE,
      current_branch TEXT,
      clone_status TEXT NOT NULL DEFAULT 'pending',
      clone_error TEXT,
      remote_repo_id TEXT,
      remote_full_name TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS project_repos_project_id_idx ON project_repos(project_id)`));
  await db.execute(sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS project_repos_project_subpath_uniq ON project_repos(project_id, sub_path)`));

  // 准备 test user
  await db.insert(schema.users).values({
    id: 'u1', username: 'u1', passwordHash: 'x', passwordSalt: 'y',
    role: 'user', status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
  }).onConflictDoNothing();
  await db.insert(schema.projects).values({
    id: 'p1', userId: 'u1', name: 'p', serverPath: '/tmp', createdAt: Date.now(),
  });

  // 构建 fastify 实例 + mock auth
  const Fastify = require('fastify');
  fastify = Fastify({ logger: false });
  fastify.decorate('authenticate', async (req, reply) => {
    req.user = { id: 'u1', username: 'u1', role: 'user', status: 'active' };
  });
  fastify.decorate('requireActive', async (req, reply) => {
    if (req.user?.status !== 'active') return reply.code(401).send({ error: 'inactive' });
  });
  fastify.decorateRequest('locale', 'en');

  const getProjectForUser = async (userId, projectId) => {
    if (projectId !== 'p1' || userId !== 'u1') return null;
    return { id: 'p1', userId: 'u1', name: 'p', serverPath: '/tmp' };
  };

  registerRepoRoutes(fastify, {
    db, schema: { projectRepos: projectReposTable }, getProjectForUser,
  });
  await fastify.ready();
});

after(async () => {
  if (fastify) await fastify.close();
  if (ctx) await ctx.teardown();
});

test('GET /api/v1/projects/:id/repos 空 → []', async () => {
  const res = await fastify.inject({
    method: 'GET', url: '/api/v1/projects/p1/repos',
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).repos, []);
});

test('POST /api/v1/projects/:id/repos 创建', async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/p1/repos',
    payload: { role: 'frontend', sub_path: 'a/b/web', repo_url: 'https://x.com/a.git' },
  });
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  assert.equal(body.repo.subPath, 'a/b/web');
  assert.equal(body.repo.isPrimary, false);
});

test('POST /api/v1/projects/:id/repos 拒绝单段 sub_path', async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/p1/repos',
    payload: { role: 'frontend', sub_path: 'a', repo_url: 'https://x.com/a.git' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, 'invalid_subpath');
});

test('POST /api/v1/projects/:id/repos 拒绝缺字段', async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/p1/repos',
    payload: { role: 'frontend' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, 'invalid_input');
});

test('POST /api/v1/projects/:id/repos 重复 sub_path 409', async () => {
  await fastify.inject({
    method: 'POST', url: '/api/v1/projects/p1/repos',
    payload: { role: 'frontend', sub_path: 'a/b/dup', repo_url: 'https://x.com/a.git' },
  });
  const res = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/p1/repos',
    payload: { role: 'frontend', sub_path: 'a/b/dup', repo_url: 'https://x.com/b.git' },
  });
  assert.equal(res.statusCode, 409);
});

test('GET /api/v1/projects/:id/repos 列表', async () => {
  const res = await fastify.inject({
    method: 'GET', url: '/api/v1/projects/p1/repos',
  });
  const body = JSON.parse(res.body);
  assert.ok(body.repos.length >= 1);
});

test('GET /api/v1/projects/:id/repos 找不到 project → 404', async () => {
  const res = await fastify.inject({
    method: 'GET', url: '/api/v1/projects/nonexistent/repos',
  });
  assert.equal(res.statusCode, 404);
});

test('POST /api/v1/projects/:id/repos/:repoId/primary 切换 primary', async () => {
  const list = await fastify.inject({ method: 'GET', url: '/api/v1/projects/p1/repos' });
  const { repos } = JSON.parse(list.body);
  const target = repos[0];
  const res = await fastify.inject({
    method: 'POST', url: `/api/v1/projects/p1/repos/${target.id}/primary`, payload: {},
  });
  assert.equal(res.statusCode, 200);
  // 验证
  const after = await fastify.inject({ method: 'GET', url: '/api/v1/projects/p1/repos' });
  const a = JSON.parse(after.body).repos.find((r) => r.id === target.id);
  assert.equal(a.isPrimary, true);
});

test('DELETE /api/v1/projects/:id/repos/:repoId 删除', async () => {
  const list = await fastify.inject({ method: 'GET', url: '/api/v1/projects/p1/repos' });
  const { repos } = JSON.parse(list.body);
  const target = repos.find((r) => r.subPath !== 'a/b/dup') || repos[repos.length - 1];
  const res = await fastify.inject({
    method: 'DELETE', url: `/api/v1/projects/p1/repos/${target.id}`,
  });
  assert.equal(res.statusCode, 200);
});
