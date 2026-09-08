const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapTestDb } = require('../test/db');

let ctx;
let db;
let schema;
let ProjectRepoService;

before(async () => {
  ctx = await bootstrapTestDb([
    '../db/index',
    './ProjectRepoService',
  ], __dirname);
  ({ db, schema } = ctx);
  ({ ProjectRepoService } = ctx.reloaded['./ProjectRepoService']);
  // 准备 test user (FK 目标)
  await db.insert(schema.users).values({
    id: 'u1', username: 'u1', passwordHash: 'x', passwordSalt: 'y',
    role: 'user', status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
  }).onConflictDoNothing();
});

after(async () => {
  if (ctx) await ctx.teardown();
});

function makeSvc() {
  return new ProjectRepoService({ db, projectReposTable: schema.projectRepos });
}

test('addRepo: 创建新记录并写 createdAt/updatedAt', async () => {
  const svc = makeSvc();
  const projectId = 'proj_test_1';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const repo = await svc.addRepo({
    projectId, role: 'frontend', subPath: 'web',
    repoProvider: 'url', repoUrl: 'https://github.com/x/y.git',
    repoDefaultBranch: 'main', isPrimary: true,
  });
  assert.equal(repo.role, 'frontend');
  assert.equal(repo.subPath, 'web');
  assert.equal(repo.isPrimary, true);
  assert.ok(repo.id.startsWith('pr_'));
  assert.ok(repo.createdAt > 0);
});

test('addRepo: subPath 归一化（去首尾斜杠、多段保留）', async () => {
  const svc = makeSvc();
  const projectId = 'proj_test_norm';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const repo = await svc.addRepo({
    projectId, role: 'custom', subPath: '/libs/shared-ui/',
    repoProvider: 'url', repoUrl: 'https://x.com/a.git',
  });
  assert.equal(repo.subPath, 'libs/shared-ui');
});

test('addRepo: 拒绝非法 subPath', async () => {
  const svc = makeSvc();
  // '' 由「拒绝缺字段」覆盖（required 校验先于 subPath 校验）
  for (const bad of ['  ', '/', 'a/../b', 'a\\b', '.']) {
    await assert.rejects(
      () => svc.addRepo({
        projectId: 'p', role: 'frontend', subPath: bad,
        repoProvider: 'url', repoUrl: 'https://x',
      }),
      /Invalid subPath/,
    );
  }
});

test('addRepo: 拒绝缺字段', async () => {
  const svc = makeSvc();
  await assert.rejects(
    () => svc.addRepo({ projectId: 'p', role: 'frontend' }),
    /required/,
  );
});

test('addRepo: isPrimary=true 时取消其他 repo 的 isPrimary', async () => {
  const svc = makeSvc();
  const projectId = 'proj_test_2';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const r1 = await svc.addRepo({
    projectId, role: 'frontend', subPath: 'web',
    repoProvider: 'url', repoUrl: 'https://x.com/a.git',
    isPrimary: true,
  });
  const r2 = await svc.addRepo({
    projectId, role: 'backend', subPath: 'api',
    repoProvider: 'url', repoUrl: 'https://x.com/b.git',
    isPrimary: false,
  });
  await svc.setPrimary(projectId, r2.id);
  const list = await svc.listByProject(projectId);
  const r1After = list.find((r) => r.id === r1.id);
  const r2After = list.find((r) => r.id === r2.id);
  assert.equal(r1After.isPrimary, false);
  assert.equal(r2After.isPrimary, true);
});

test('addRepo: sub_path 重复被唯一索引拦截', async () => {
  const svc = makeSvc();
  const projectId = 'proj_test_uniq';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  await svc.addRepo({
    projectId, role: 'frontend', subPath: 'web',
    repoProvider: 'url', repoUrl: 'https://x.com/a.git',
  });
  await assert.rejects(
    () => svc.addRepo({
      projectId, role: 'backend', subPath: 'web',
      repoProvider: 'url', repoUrl: 'https://x.com/b.git',
    }),
  );
});

test('listByProject: 按 createdAt 升序返回', async () => {
  const svc = makeSvc();
  const projectId = 'proj_test_3';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  await svc.addRepo({ projectId, role: 'backend', subPath: 'api', repoProvider: 'url', repoUrl: 'https://x.com/a.git' });
  await new Promise((r) => setTimeout(r, 5));
  await svc.addRepo({ projectId, role: 'frontend', subPath: 'web', repoProvider: 'url', repoUrl: 'https://x.com/b.git' });
  const list = await svc.listByProject(projectId);
  assert.equal(list.length, 2);
  assert.equal(list[0].role, 'backend');
  assert.equal(list[1].role, 'frontend');
});

test('getById: 找到 / 找不到', async () => {
  const svc = makeSvc();
  const projectId = 'proj_test_4';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const r = await svc.addRepo({
    projectId, role: 'frontend', subPath: 'web',
    repoProvider: 'url', repoUrl: 'https://x.com/a.git',
  });
  const found = await svc.getById(r.id);
  assert.equal(found.id, r.id);
  const notFound = await svc.getById('pr_nope');
  assert.equal(notFound, null);
});

test('getBySubPath: 找到 / 找不到', async () => {
  const svc = makeSvc();
  const projectId = 'proj_test_5';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  await svc.addRepo({
    projectId, role: 'frontend', subPath: 'web',
    repoProvider: 'url', repoUrl: 'https://x.com/a.git',
  });
  const found = await svc.getBySubPath(projectId, 'web');
  assert.ok(found);
  const notFound = await svc.getBySubPath(projectId, 'api');
  assert.equal(notFound, null);
});

test('removeRepo: 删除记录', async () => {
  const svc = makeSvc();
  const projectId = 'proj_test_6';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const r = await svc.addRepo({
    projectId, role: 'frontend', subPath: 'web',
    repoProvider: 'url', repoUrl: 'https://x.com/a.git',
    isPrimary: true,
  });
  await svc.removeRepo(r.id);
  const list = await svc.listByProject(projectId);
  assert.equal(list.length, 0);
});

test('removeRepo: 删除 primary 自动升级最早 repo 为 primary', async () => {
  const svc = makeSvc();
  const projectId = 'proj_test_7';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const r1 = await svc.addRepo({
    projectId, role: 'frontend', subPath: 'web',
    repoProvider: 'url', repoUrl: 'https://x.com/a.git',
    isPrimary: true,
  });
  await new Promise((r) => setTimeout(r, 5));
  const r2 = await svc.addRepo({
    projectId, role: 'backend', subPath: 'api',
    repoProvider: 'url', repoUrl: 'https://x.com/b.git',
  });
  await svc.removeRepo(r1.id);
  const list = await svc.listByProject(projectId);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, r2.id);
  assert.equal(list[0].isPrimary, true);
});

test('updateCloneStatus: 更新状态与错误', async () => {
  const svc = makeSvc();
  const projectId = 'proj_test_8';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const r = await svc.addRepo({
    projectId, role: 'frontend', subPath: 'web',
    repoProvider: 'url', repoUrl: 'https://x.com/a.git',
  });
  await svc.updateCloneStatus(r.id, 'failed', 'network error');
  const found = await svc.getById(r.id);
  assert.equal(found.cloneStatus, 'failed');
  assert.equal(found.cloneError, 'network error');
});
