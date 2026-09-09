const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// WORKSPACE_ROOT 必须在模块加载前就绪：workspace.js 在 require 时解析该 env
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xe-gitmulti-'));
process.env.WORKSPACE_ROOT = tmpRoot;

const { bootstrapTestDb } = require('../test/db');

let ctx;
let fastify;
let projectDir;

function git(cwd, args) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });
}

before(async () => {
  ctx = await bootstrapTestDb([
    '../db/index',
    '../routes/projectGit',
  ], __dirname);
  const { registerProjectGitRoutes } = ctx.reloaded['../routes/projectGit'];
  const { db, schema } = ctx;

  await db.insert(schema.users).values({
    id: 'u1', username: 'u1', passwordHash: 'x', passwordSalt: 'y',
    role: 'user', status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
  }).onConflictDoNothing();
  await db.insert(schema.projects).values({
    id: 'pm', userId: 'u1', name: 'multi', serverPath: '/tmp',
    repoProvider: 'github', repoDefaultBranch: 'main', currentBranch: 'main',
    cloneStatus: 'ready', workspaceMode: 'git_multi', createdAt: Date.now(),
  });
  await db.insert(schema.projectRepos).values([
    {
      id: 'pr_r1', projectId: 'pm', role: 'custom', subPath: 'r1',
      repoProvider: 'github', repoUrl: 'https://x/r1.git', repoDefaultBranch: 'main',
      isPrimary: true, currentBranch: 'main', cloneStatus: 'ready',
      createdAt: Date.now(), updatedAt: Date.now(),
    },
    {
      id: 'pr_r2', projectId: 'pm', role: 'custom', subPath: 'r2',
      repoProvider: 'github', repoUrl: 'https://x/r2.git', repoDefaultBranch: 'main',
      isPrimary: false, currentBranch: 'main', cloneStatus: 'ready',
      createdAt: Date.now(), updatedAt: Date.now(),
    },
  ]);

  // 宿主侧真实 git 仓库：projectDir/r1、projectDir/r2（usesHostWorkspace → host git）
  projectDir = path.join(tmpRoot, 'u1', 'pm');
  for (const r of ['r1', 'r2']) {
    const dir = path.join(projectDir, r);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'init']);
  }
  // r1：修改已跟踪文件 + 新增 untracked；r2：修改已跟踪文件
  fs.writeFileSync(path.join(projectDir, 'r1', 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(projectDir, 'r1', 'new.txt'), 'new\n');
  fs.writeFileSync(path.join(projectDir, 'r2', 'a.txt'), 'r2 changed\n');

  const Fastify = require('fastify');
  fastify = Fastify({ logger: false });
  fastify.decorate('authenticate', async (req) => {
    req.user = { id: 'u1', username: 'u1', role: 'user', status: 'active' };
  });
  fastify.decorate('requireActive', async () => {});
  fastify.decorateRequest('locale', 'en');
  registerProjectGitRoutes(fastify);
  await fastify.ready();
});

after(async () => {
  if (fastify) await fastify.close();
  if (ctx) await ctx.teardown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('GET /git/status 聚合：文件带 <subPath>/ 前缀，dirty 取并集', async () => {
  const res = await fastify.inject({
    method: 'GET', url: '/api/v1/projects/pm/git/status',
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  const paths = body.files.map((f) => f.path);
  assert.ok(paths.includes('r1/a.txt'), `r1/a.txt missing: ${paths}`);
  assert.ok(paths.includes('r1/new.txt'), `r1/new.txt missing: ${paths}`);
  assert.ok(paths.includes('r2/a.txt'), `r2/a.txt missing: ${paths}`);
  assert.equal(body.dirty, true);
  assert.equal(body.multiRepo, true);
  assert.ok(body.branch); // primary 的分支名
  // repos 明细：每仓库一条，路径同样带前缀
  assert.ok(Array.isArray(body.repos));
  assert.equal(body.repos.length, 2);
  const byPath = Object.fromEntries(body.repos.map((r) => [r.subPath, r]));
  assert.ok(byPath.r1, 'r1 missing in repos breakdown');
  assert.ok(byPath.r2, 'r2 missing in repos breakdown');
  assert.equal(byPath.r1.isPrimary, true);
  assert.equal(byPath.r2.isPrimary, false);
  assert.ok(byPath.r1.files.some((f) => f.path === 'r1/a.txt'));
  assert.ok(byPath.r2.files.some((f) => f.path === 'r2/a.txt'));
});

test('POST /git/stage 按前缀路由：只 stage r2 的文件', async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/pm/git/stage',
    payload: { files: ['r2/a.txt'] },
  });
  assert.equal(res.statusCode, 200);
  const status = JSON.parse((await fastify.inject({
    method: 'GET', url: '/api/v1/projects/pm/git/status',
  })).body);
  const r2entry = status.files.find((f) => f.path === 'r2/a.txt');
  assert.equal(r2entry.type, 'staged');
  const r1entry = status.files.find((f) => f.path === 'r1/a.txt');
  assert.notEqual(r1entry.type, 'staged');
});

test('POST /git/commit：只对有暂存内容的 repo 提交', async () => {
  const headOf = (repo) => execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.join(projectDir, repo),
  }).toString().trim();
  const r1Before = headOf('r1');
  const r2Before = headOf('r2');

  const res = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/pm/git/commit',
    payload: { message: 'multi commit', author: { name: 't', email: 't@t' } },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.committed, true);

  assert.equal(headOf('r1'), r1Before); // r1 无暂存 → 不提交
  assert.notEqual(headOf('r2'), r2Before); // r2 有暂存 → 提交
  assert.equal(body.status.files.some((f) => f.path === 'r1/a.txt'), true);
});

test('GET /git/file-diff 按前缀路由到所属 repo', async () => {
  const res = await fastify.inject({
    method: 'GET', url: '/api/v1/projects/pm/git/file-diff?path=r1/a.txt',
  });
  assert.equal(res.statusCode, 200);
  assert.ok(JSON.parse(res.body).diff.includes('changed'));
});

test('GET /git/file-content 按前缀路由（r2 HEAD 内容）', async () => {
  const res = await fastify.inject({
    method: 'GET', url: '/api/v1/projects/pm/git/file-content?path=r2/a.txt&ref=HEAD',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).content, 'r2 changed\n');
});

test('POST /git/push：推所有仓库的当前分支（不只是 primary）', async () => {
  const bareR1 = path.join(tmpRoot, 'bare-r1.git');
  const bareR2 = path.join(tmpRoot, 'bare-r2.git');
  for (const [repo, bare] of [['r1', bareR1], ['r2', bareR2]]) {
    execFileSync('git', ['init', '--bare', bare]);
    execFileSync('git', ['-C', path.join(projectDir, repo), 'remote', 'add', 'origin', bare]);
  }
  // r1 当前只有 unstaged/untracked：先 stage+commit，让两个仓库都有待推提交
  const stageRes = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/pm/git/stage',
    payload: { files: ['r1/a.txt', 'r1/new.txt'] },
  });
  assert.equal(stageRes.statusCode, 200);
  const commitRes = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/pm/git/commit',
    payload: { message: 'r1 push test', author: { name: 't', email: 't@t' } },
  });
  assert.equal(commitRes.statusCode, 200);

  const res = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/pm/git/push',
    payload: { branch: 'main' },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.pushed), 'pushed array missing');
  assert.equal(body.pushed.length, 2, `expected 2 pushed, got ${JSON.stringify(body.pushed)}`);
  const byPath = Object.fromEntries(body.pushed.map((p) => [p.subPath, p]));
  assert.ok(byPath.r1 && byPath.r1.sha, 'r1 not pushed');
  assert.ok(byPath.r2 && byPath.r2.sha, 'r2 not pushed');
  assert.equal(byPath.r1.error, undefined);
  assert.equal(byPath.r2.error, undefined);

  // 验证 bare remote 上分支都已更新
  for (const bare of [bareR1, bareR2]) {
    const refs = execFileSync('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname)'])
      .toString().trim().split('\n').filter(Boolean);
    assert.ok(refs.length >= 1, `remote ${bare} has no refs`);
  }
});

test('POST /git/push 指定 repo_id：只推该仓库', async () => {
  const bare = path.join(tmpRoot, 'bare-r2-only.git');
  execFileSync('git', ['init', '--bare', bare]);
  execFileSync('git', ['-C', path.join(projectDir, 'r2'), 'remote', 'set-url', 'origin', bare]);
  const res = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/pm/git/push',
    payload: { branch: 'main', repo_id: 'pr_r2' },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.pushed.length, 1);
  assert.equal(body.pushed[0].repoId, 'pr_r2');
  assert.ok(body.pushed[0].sha);
});

test('POST /git/commit 指定 repo_id：只提交该仓库', async () => {
  const headOf = (repo) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(projectDir, repo) }).toString().trim();
  const r1Before = headOf('r1');
  const r2Before = headOf('r2');
  // 给 r1 制造一个未跟踪文件并暂存
  fs.writeFileSync(path.join(projectDir, 'r1', 'scoped.txt'), 'scoped\n');
  const stageRes = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/pm/git/stage',
    payload: { files: ['r1/scoped.txt'] },
  });
  assert.equal(stageRes.statusCode, 200);
  const res = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/pm/git/commit',
    payload: { message: 'scoped commit', author: { name: 't', email: 't@t' }, repo_id: 'pr_r1' },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.committedRepos.length, 1);
  assert.equal(body.committedRepos[0].repoId, 'pr_r1');
  assert.notEqual(headOf('r1'), r1Before); // r1 已提交
  assert.equal(headOf('r2'), r2Before);    // r2 未动
});
