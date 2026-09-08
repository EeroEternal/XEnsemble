const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getMultiRepoStatus } = require('./multiRepoStatus');

test('getMultiRepoStatus 聚合多个 repo status 并附 repo meta', async () => {
  const fakeSvc = (subPath) => ({
    getStatus: async () => ({
      branch: 'main',
      sha: 'abc',
      dirty: true,
      files: [{ path: 'x', status: 'M' }],
      ahead: 0,
      behind: 0,
    }),
  });
  const repos = [
    { id: 'pr_1', subPath: 'frontend', role: 'frontend', isPrimary: true },
    { id: 'pr_2', subPath: 'backend', role: 'backend', isPrimary: false },
  ];
  const result = await getMultiRepoStatus(repos, fakeSvc);
  assert.equal(result.length, 2);
  assert.equal(result[0].repoId, 'pr_1');
  assert.equal(result[0].subPath, 'frontend');
  assert.equal(result[0].role, 'frontend');
  assert.equal(result[0].isPrimary, true);
  assert.equal(result[0].status.dirty, true);
  assert.equal(result[1].repoId, 'pr_2');
  assert.equal(result[1].subPath, 'backend');
  assert.equal(result[1].isPrimary, false);
});

test('getMultiRepoStatus 空 repos 数组 → 空结果', async () => {
  const fakeSvc = () => ({ getStatus: async () => ({}) });
  const result = await getMultiRepoStatus([], fakeSvc);
  assert.deepEqual(result, []);
});

test('getMultiRepoStatus 拒入非数组', async () => {
  await assert.rejects(
    () => getMultiRepoStatus(null, () => ({ getStatus: async () => ({}) })),
    /repos must be an array/,
  );
});

test('getMultiRepoStatus 拒入非函数 svcFactory', async () => {
  await assert.rejects(
    () => getMultiRepoStatus([], null),
    /svcFactory must be a function/,
  );
});

test('getMultiRepoStatus 某个 repo 失败不影响其他', async () => {
  const fakeSvc = (subPath) => ({
    getStatus: async () => {
      if (subPath === 'broken') {
        throw new Error('git status failed');
      }
      return { branch: 'main', dirty: false, files: [] };
    },
  });
  const repos = [
    { id: 'pr_1', subPath: 'ok', role: 'frontend', isPrimary: true },
    { id: 'pr_2', subPath: 'broken', role: 'backend', isPrimary: false },
  ];
  await assert.rejects(
    () => getMultiRepoStatus(repos, fakeSvc),
    /git status failed/,
  );
});
