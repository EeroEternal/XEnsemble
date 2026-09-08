const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePath,
  prefixOf,
  validateBatch,
  groupPaths,
  SEPARATOR,
  MIN_SEGMENTS,
  PREFIX_DEPTH,
} = require('./PathGroupingService');

test('parsePath: 3 层路径 → 3 segments', () => {
  assert.deepEqual(parsePath('a/b/c'), ['a', 'b', 'c']);
});

test('parsePath: 2 层路径 → 2 segments', () => {
  assert.deepEqual(parsePath('myorg/frontend'), ['myorg', 'frontend']);
});

test('parsePath: 去掉首尾 /', () => {
  assert.deepEqual(parsePath('/a/b/'), ['a', 'b']);
});

test('parsePath: 拒绝单段', () => {
  assert.equal(parsePath('a'), null);
});

test('parsePath: 拒绝空字符串', () => {
  assert.equal(parsePath(''), null);
  assert.equal(parsePath('   '), null);
  assert.equal(parsePath('/'), null);
});

test('parsePath: 拒绝非法字符', () => {
  assert.equal(parsePath('a/b/c*d'), null);
  assert.equal(parsePath('a/b/c|d'), null);
  assert.equal(parsePath('a/b/c?d'), null);
  assert.equal(parsePath('a/b/c"d'), null);
  assert.equal(parsePath('a/b/c<d'), null);
});

test('parsePath: 拒绝 . 和 ..', () => {
  assert.equal(parsePath('a/./b'), null);
  assert.equal(parsePath('a/../b'), null);
});

test('parsePath: 拒绝非字符串', () => {
  assert.equal(parsePath(null), null);
  assert.equal(parsePath(undefined), null);
  assert.equal(parsePath(123), null);
  assert.equal(parsePath([]), null);
});

test('prefixOf: 前 2 层 join', () => {
  assert.equal(prefixOf(['a', 'b', 'c'], 2), 'a/b');
  assert.equal(prefixOf(['x', 'y'], 2), 'x/y');
  assert.equal(prefixOf(['a', 'b', 'c'], 3), 'a/b/c');
});

test('validateBatch: 3 个 3 层且共享 a/b → ok', () => {
  const r = validateBatch(['a/b/c', 'a/b/d', 'a/b/e']);
  assert.equal(r.ok, true);
  assert.equal(r.prefix, 'a/b');
});

test('validateBatch: 2 个 2 层共享 a/b → ok', () => {
  const r = validateBatch(['a/b', 'a/c']);
  // 不共享 → 拒绝
  assert.equal(r.ok, false);
});

test('validateBatch: 2 层 a/b + 3 层 a/b/c → ok', () => {
  const r = validateBatch(['a/b', 'a/b/c']);
  assert.equal(r.ok, true);
  assert.equal(r.prefix, 'a/b');
});

test('validateBatch: a/b + a/d/f → 拒绝 (level 2 不一致)', () => {
  const r = validateBatch(['a/b', 'a/d/f']);
  assert.equal(r.ok, false);
  assert.match(r.error, /first 2 segments/);
});

test('validateBatch: a/b/e + a/d/f → 拒绝', () => {
  const r = validateBatch(['a/b/e', 'a/d/f']);
  assert.equal(r.ok, false);
});

test('validateBatch: 单段路径 → 拒绝', () => {
  const r = validateBatch(['a', 'a/b']);
  assert.equal(r.ok, false);
  assert.match(r.error, /Invalid path/);
});

test('validateBatch: 空数组 → 拒绝', () => {
  const r = validateBatch([]);
  assert.equal(r.ok, false);
  assert.match(r.error, /at least one/);
});

test('validateBatch: 非数组 → 拒绝', () => {
  const r = validateBatch('a/b');
  assert.equal(r.ok, false);
});

test('groupPaths: 3 个 3 层 → 1 个 merged group，3 个叶子', () => {
  const r = groupPaths(['a/b/c', 'a/b/d', 'a/b/e']);
  assert.equal(r.error, null);
  assert.equal(r.prefix, 'a/b');
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].type, 'merged');
  assert.equal(r.groups[0].prefix, 'a/b');
  assert.equal(r.groups[0].items.length, 3);
  assert.deepEqual(r.groups[0].items.map((i) => i.leaf), ['c', 'd', 'e']);
  assert.deepEqual(r.groups[0].items.map((i) => i.fullPath), ['a/b/c', 'a/b/d', 'a/b/e']);
});

test('groupPaths: 2 层 + 3 层混合 → 1 flat + 1 merged', () => {
  const r = groupPaths(['a/b', 'a/b/c']);
  assert.equal(r.error, null);
  assert.equal(r.groups.length, 2);
  const flat = r.groups.find((g) => g.type === 'flat');
  const merged = r.groups.find((g) => g.type === 'merged');
  assert.ok(flat, '应该有 flat group');
  assert.ok(merged, '应该有 merged group');
  assert.equal(flat.items.length, 1);
  assert.equal(flat.items[0].path, 'a/b');
  assert.equal(flat.items[0].leaf, null);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].leaf, 'c');
});

test('groupPaths: 2 层 + 多个 3 层', () => {
  const r = groupPaths(['a/b', 'a/b/c', 'a/b/d']);
  assert.equal(r.error, null);
  assert.equal(r.groups.length, 2);
  const flat = r.groups.find((g) => g.type === 'flat');
  const merged = r.groups.find((g) => g.type === 'merged');
  assert.equal(flat.items.length, 1);
  assert.equal(merged.items.length, 2);
  assert.deepEqual(merged.items.map((i) => i.leaf), ['c', 'd']);
});

test('groupPaths: 2 个 2 层共享 a/b → 1 flat group 包含 2 项', () => {
  // 不可能共享 a/b：2 层就只能是 a/b 自己，无法多 repo 同 a/b
  // 所以这个 case 实际不会出现
  // 但 2 个完全相同路径 a/b 是允许的
  const r = groupPaths(['a/b', 'a/b']);
  assert.equal(r.error, null);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].type, 'flat');
  assert.equal(r.groups[0].items.length, 2);
});

test('groupPaths: 非法 batch 返回 error + 空 groups', () => {
  const r = groupPaths(['a/b', 'a/c']);
  assert.notEqual(r.error, null);
  assert.equal(r.groups.length, 0);
  assert.equal(r.prefix, null);
});

test('groupPaths: 4+ 层路径也正确归类为 merged', () => {
  const r = groupPaths(['a/b/c/d', 'a/b/c/e']);
  assert.equal(r.error, null);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].type, 'merged');
  // leaf 取前 2 层之后的第一个 segment
  assert.deepEqual(r.groups[0].items.map((i) => i.leaf), ['c', 'c']);
});

test('导出常量值正确', () => {
  assert.equal(SEPARATOR, '/');
  assert.equal(MIN_SEGMENTS, 2);
  assert.equal(PREFIX_DEPTH, 2);
});
