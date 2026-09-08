const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapTestDb } = require('../test/db');

let ctx;
let db;
let schema;
let fastify;

before(async () => {
  ctx = await bootstrapTestDb([
    '../db/index',
    '../routes/repos',
  ], __dirname);
  ({ db, schema } = ctx);
  const { registerRepoRoutes } = ctx.reloaded['../routes/repos'];

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
    db, schema, getProjectForUser,
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

test('POST /api/v1/projects/:id/repos 创建（单段 sub_path，role 默认 custom）', async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/p1/repos',
    payload: { sub_path: 'web', repo_url: 'https://x.com/a.git' },
  });
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  assert.equal(body.repo.subPath, 'web');
  assert.equal(body.repo.role, 'custom');
  assert.equal(body.repo.isPrimary, false);
});

test('POST /api/v1/projects/:id/repos 拒绝非法 sub_path', async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/p1/repos',
    payload: { sub_path: '..', repo_url: 'https://x.com/a.git' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, 'invalid_subpath');
});

test('POST /api/v1/projects/:id/repos 拒绝缺字段', async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/p1/repos',
    payload: { sub_path: 'web' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, 'invalid_input');
});

test('POST /api/v1/projects/:id/repos 重复 sub_path 409', async () => {
  await fastify.inject({
    method: 'POST', url: '/api/v1/projects/p1/repos',
    payload: { sub_path: 'dup', repo_url: 'https://x.com/a.git' },
  });
  const res = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/p1/repos',
    payload: { sub_path: 'dup', repo_url: 'https://x.com/b.git' },
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
  const target = repos.find((r) => r.subPath !== 'dup') || repos[repos.length - 1];
  const res = await fastify.inject({
    method: 'DELETE', url: `/api/v1/projects/p1/repos/${target.id}`,
  });
  assert.equal(res.statusCode, 200);
});
