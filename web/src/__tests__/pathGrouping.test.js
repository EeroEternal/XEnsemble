import { describe, it, expect } from 'vitest';
import {
  parsePath,
  prefixOf,
  validateBatch,
  groupPaths,
  SEPARATOR,
  MIN_SEGMENTS,
  PREFIX_DEPTH,
} from '../lib/pathGrouping';

describe('parsePath', () => {
  it('3 层路径 → 3 segments', () => {
    expect(parsePath('a/b/c')).toEqual(['a', 'b', 'c']);
  });

  it('2 层路径 → 2 segments', () => {
    expect(parsePath('myorg/frontend')).toEqual(['myorg', 'frontend']);
  });

  it('去掉首尾 /', () => {
    expect(parsePath('/a/b/')).toEqual(['a', 'b']);
  });

  it('拒绝单段', () => {
    expect(parsePath('a')).toBe(null);
  });

  it('拒绝空字符串', () => {
    expect(parsePath('')).toBe(null);
    expect(parsePath('   ')).toBe(null);
    expect(parsePath('/')).toBe(null);
  });

  it('拒绝非法字符', () => {
    expect(parsePath('a/b/c*d')).toBe(null);
    expect(parsePath('a/b/c|d')).toBe(null);
    expect(parsePath('a/b/c?d')).toBe(null);
  });

  it('拒绝 . 和 ..', () => {
    expect(parsePath('a/./b')).toBe(null);
    expect(parsePath('a/../b')).toBe(null);
  });

  it('拒绝非字符串', () => {
    expect(parsePath(null)).toBe(null);
    expect(parsePath(undefined)).toBe(null);
    expect(parsePath(123)).toBe(null);
  });
});

describe('prefixOf', () => {
  it('前 2 层 join', () => {
    expect(prefixOf(['a', 'b', 'c'], 2)).toBe('a/b');
    expect(prefixOf(['x', 'y'], 2)).toBe('x/y');
  });
});

describe('validateBatch', () => {
  it('3 个 3 层且共享 a/b → ok', () => {
    const r = validateBatch(['a/b/c', 'a/b/d', 'a/b/e']);
    expect(r.ok).toBe(true);
    expect(r.prefix).toBe('a/b');
  });

  it('2 个 2 层 a/b + a/c → 拒绝', () => {
    const r = validateBatch(['a/b', 'a/c']);
    expect(r.ok).toBe(false);
  });

  it('2 层 a/b + 3 层 a/b/c → ok', () => {
    const r = validateBatch(['a/b', 'a/b/c']);
    expect(r.ok).toBe(true);
    expect(r.prefix).toBe('a/b');
  });

  it('a/b + a/d/f → 拒绝 (level 2 不一致)', () => {
    const r = validateBatch(['a/b', 'a/d/f']);
    expect(r.ok).toBe(false);
  });

  it('a/b/e + a/d/f → 拒绝', () => {
    const r = validateBatch(['a/b/e', 'a/d/f']);
    expect(r.ok).toBe(false);
  });

  it('空数组 → 拒绝', () => {
    const r = validateBatch([]);
    expect(r.ok).toBe(false);
  });

  it('非数组 → 拒绝', () => {
    const r = validateBatch('a/b');
    expect(r.ok).toBe(false);
  });
});

describe('groupPaths', () => {
  it('3 个 3 层 → 1 个 merged group，3 个叶子', () => {
    const r = groupPaths(['a/b/c', 'a/b/d', 'a/b/e']);
    expect(r.error).toBe(null);
    expect(r.prefix).toBe('a/b');
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].type).toBe('merged');
    expect(r.groups[0].items).toHaveLength(3);
    expect(r.groups[0].items.map((i) => i.leaf)).toEqual(['c', 'd', 'e']);
  });

  it('2 层 + 3 层混合 → 1 flat + 1 merged', () => {
    const r = groupPaths(['a/b', 'a/b/c']);
    expect(r.error).toBe(null);
    expect(r.groups).toHaveLength(2);
    const flat = r.groups.find((g) => g.type === 'flat');
    const merged = r.groups.find((g) => g.type === 'merged');
    expect(flat).toBeTruthy();
    expect(merged).toBeTruthy();
    expect(flat.items[0].path).toBe('a/b');
    expect(flat.items[0].leaf).toBe(null);
    expect(merged.items[0].leaf).toBe('c');
  });

  it('2 层 + 多个 3 层', () => {
    const r = groupPaths(['a/b', 'a/b/c', 'a/b/d']);
    expect(r.error).toBe(null);
    const flat = r.groups.find((g) => g.type === 'flat');
    const merged = r.groups.find((g) => g.type === 'merged');
    expect(flat.items).toHaveLength(1);
    expect(merged.items).toHaveLength(2);
    expect(merged.items.map((i) => i.leaf)).toEqual(['c', 'd']);
  });

  it('非法 batch 返回 error + 空 groups', () => {
    const r = groupPaths(['a/b', 'a/c']);
    expect(r.error).not.toBe(null);
    expect(r.groups).toHaveLength(0);
    expect(r.prefix).toBe(null);
  });

  it('4+ 层路径归类为 merged', () => {
    const r = groupPaths(['a/b/c/d', 'a/b/c/e']);
    expect(r.error).toBe(null);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].type).toBe('merged');
    expect(r.groups[0].items.map((i) => i.leaf)).toEqual(['c', 'c']);
  });
});

describe('导出常量', () => {
  it('值正确', () => {
    expect(SEPARATOR).toBe('/');
    expect(MIN_SEGMENTS).toBe(2);
    expect(PREFIX_DEPTH).toBe(2);
  });
});
