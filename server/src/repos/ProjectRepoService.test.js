const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapTestDb } = require('../test/db');
const { sql } = require('drizzle-orm');
const { pgTable, text, boolean, bigint, index, uniqueIndex } = require('drizzle-orm/pg-core');

let ctx;
let db;
let schema;
let ProjectRepoService;
let projectReposTable;

before(async () => {
  ctx = await bootstrapTestDb([
    '../db/index',
    './ProjectRepoService',
  ], __dirname);
  ({ db, schema } = ctx);
  ({ ProjectRepoService } = ctx.reloaded['./ProjectRepoService']);
  // 在测试中直接定义 projectReposTable（不修改 server/src/db/schema.js）
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
  // 由于 project_repos 表尚未合并到 ./drizzle/，在测试库上手动建表
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
  // 准备 test user (FK 目标)
  await db.insert(schema.users).values({
    id: 'u1', username: 'u1', passwordHash: 'x', passwordSalt: 'y',
    role: 'user', status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
  }).onConflictDoNothing();
});

after(async () => {
  if (ctx) await ctx.teardown();
});

test('addRepo: 创建新记录并写 createdAt/updatedAt', async () => {
  const svc = new ProjectRepoService({ db, projectReposTable });
  const projectId = 'proj_test_1';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const repo = await svc.addRepo({
    projectId, role: 'frontend', subPath: 'a/b/c',
    repoProvider: 'url', repoUrl: 'https://github.com/x/y.git',
    repoDefaultBranch: 'main', isPrimary: true,
  });
  assert.equal(repo.role, 'frontend');
  assert.equal(repo.subPath, 'a/b/c');
  assert.equal(repo.isPrimary, true);
  assert.ok(repo.id.startsWith('pr_'));
  assert.ok(repo.createdAt > 0);
});

test('addRepo: 拒绝单段 subPath', async () => {
  const svc = new ProjectRepoService({ db, projectReposTable });
  await assert.rejects(
    () => svc.addRepo({
      projectId: 'p', role: 'frontend', subPath: 'a',
      repoProvider: 'url', repoUrl: 'https://x',
    }),
    /Invalid subPath/,
  );
});

test('addRepo: 拒绝缺字段', async () => {
  const svc = new ProjectRepoService({ db, projectReposTable });
  await assert.rejects(
    () => svc.addRepo({ projectId: 'p', role: 'frontend' }),
    /required/,
  );
});

test('addRepo: isPrimary=true 时取消其他 repo 的 isPrimary', async () => {
  const svc = new ProjectRepoService({ db, projectReposTable });
  const projectId = 'proj_test_2';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const r1 = await svc.addRepo({
    projectId, role: 'frontend', subPath: 'a/b/web',
    repoProvider: 'url', repoUrl: 'https://x.com/a.git',
    isPrimary: true,
  });
  const r2 = await svc.addRepo({
    projectId, role: 'backend', subPath: 'a/b/api',
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

test('listByProject: 按 createdAt 升序返回', async () => {
  const svc = new ProjectRepoService({ db, projectReposTable });
  const projectId = 'proj_test_3';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  await svc.addRepo({ projectId, role: 'backend', subPath: 'a/b/api', repoProvider: 'url', repoUrl: 'https://x.com/a.git' });
  await new Promise((r) => setTimeout(r, 5));
  await svc.addRepo({ projectId, role: 'frontend', subPath: 'a/b/web', repoProvider: 'url', repoUrl: 'https://x.com/b.git' });
  const list = await svc.listByProject(projectId);
  assert.equal(list.length, 2);
  assert.equal(list[0].role, 'backend');
  assert.equal(list[1].role, 'frontend');
});

test('getById: 找到 / 找不到', async () => {
  const svc = new ProjectRepoService({ db, projectReposTable });
  const projectId = 'proj_test_4';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const r = await svc.addRepo({
    projectId, role: 'frontend', subPath: 'a/b/web',
    repoProvider: 'url', repoUrl: 'https://x.com/a.git',
  });
  const found = await svc.getById(r.id);
  assert.equal(found.id, r.id);
  const notFound = await svc.getById('pr_nope');
  assert.equal(notFound, null);
});

test('getBySubPath: 找到 / 找不到', async () => {
  const svc = new ProjectRepoService({ db, projectReposTable });
  const projectId = 'proj_test_5';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  await svc.addRepo({
    projectId, role: 'frontend', subPath: 'a/b/web',
    repoProvider: 'url', repoUrl: 'https://x.com/a.git',
  });
  const found = await svc.getBySubPath(projectId, 'a/b/web');
  assert.ok(found);
  const notFound = await svc.getBySubPath(projectId, 'a/b/api');
  assert.equal(notFound, null);
});

test('removeRepo: 删除记录', async () => {
  const svc = new ProjectRepoService({ db, projectReposTable });
  const projectId = 'proj_test_6';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const r = await svc.addRepo({
    projectId, role: 'frontend', subPath: 'a/b/web',
    repoProvider: 'url', repoUrl: 'https://x.com/a.git',
    isPrimary: true,
  });
  await svc.removeRepo(r.id);
  const list = await svc.listByProject(projectId);
  assert.equal(list.length, 0);
});

test('removeRepo: 删除 primary 自动升级最早 repo 为 primary', async () => {
  const svc = new ProjectRepoService({ db, projectReposTable });
  const projectId = 'proj_test_7';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const r1 = await svc.addRepo({
    projectId, role: 'frontend', subPath: 'a/b/web',
    repoProvider: 'url', repoUrl: 'https://x.com/a.git',
    isPrimary: true,
  });
  await new Promise((r) => setTimeout(r, 5));
  const r2 = await svc.addRepo({
    projectId, role: 'backend', subPath: 'a/b/api',
    repoProvider: 'url', repoUrl: 'https://x.com/b.git',
  });
  await svc.removeRepo(r1.id);
  const list = await svc.listByProject(projectId);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, r2.id);
  assert.equal(list[0].isPrimary, true);
});

test('updateCloneStatus: 更新状态与错误', async () => {
  const svc = new ProjectRepoService({ db, projectReposTable });
  const projectId = 'proj_test_8';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const r = await svc.addRepo({
    projectId, role: 'frontend', subPath: 'a/b/web',
    repoProvider: 'url', repoUrl: 'https://x.com/a.git',
  });
  await svc.updateCloneStatus(r.id, 'failed', 'network error');
  const found = await svc.getById(r.id);
  assert.equal(found.cloneStatus, 'failed');
  assert.equal(found.cloneError, 'network error');
});
