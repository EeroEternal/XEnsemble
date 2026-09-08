const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { repoWorktreePath, worktreeDir } = require('../workspace');

test('repoWorktreePath 拼接 user/project/runtimeId/subPath', () => {
    const result = repoWorktreePath('u1', 'p1', 'rt_1', 'frontend');
    const base = worktreeDir('u1', 'p1', 'rt_1');
    assert.equal(result, path.join(base, 'frontend'));
    assert.match(result, /u1[\\/]p1\.wt[\\/]rt_1[\\/]frontend$/);
});

test('repoWorktreePath 支持多段 subPath', () => {
    const result = repoWorktreePath('u1', 'p1', 'rt_1', 'libs/shared-ui');
    assert.match(result, /rt_1[\\/]libs[\\/]shared-ui$/);
});
