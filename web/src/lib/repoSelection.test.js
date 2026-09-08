import { describe, it, expect } from 'vitest';
import { prefixOf, computeSelectionState, toggleRepo } from './repoSelection';

const REPOS = [
  { id: '1', full_name: 'a/b/c' },
  { id: '2', full_name: 'a/b/d' },
  { id: '3', full_name: 'a/e' },
  { id: '4', full_name: 'g/h' },
];

describe('prefixOf', () => {
  it('取最后一段前的路径为前缀', () => {
    expect(prefixOf('a/b/c')).toBe('a/b');
    expect(prefixOf('a/e')).toBe('a');
    expect(prefixOf('g/h')).toBe('g');
    expect(prefixOf('solo')).toBe('');
  });
});

describe('computeSelectionState', () => {
  it('未勾选时全部可勾', () => {
    const states = computeSelectionState(REPOS, []);
    expect(states.every((s) => s.enabled)).toBe(true);
    expect(states.every((s) => !s.checked)).toBe(true);
  });

  it('勾选 a/b/c 后锁定前缀组 a/b：a/b/d 可勾，a/e 与 g/h 禁用', () => {
    const states = computeSelectionState(REPOS, ['1']);
    expect(states.find((s) => s.id === '1').enabled).toBe(true);
    expect(states.find((s) => s.id === '1').checked).toBe(true);
    expect(states.find((s) => s.id === '2').enabled).toBe(true);
    expect(states.find((s) => s.id === '3').enabled).toBe(false);
    expect(states.find((s) => s.id === '4').enabled).toBe(false);
  });

  it('取消全部勾选后重新开放所有仓库', () => {
    expect(computeSelectionState(REPOS, []).every((s) => s.enabled)).toBe(true);
  });

  it('两个同前缀仓库（无子组层级）勾选后互锁', () => {
    const flat = [
      { id: 'x', full_name: 'org/frontend' },
      { id: 'y', full_name: 'org/backend' },
      { id: 'z', full_name: 'other/infra' },
    ];
    const states = computeSelectionState(flat, ['x']);
    expect(states.find((s) => s.id === 'y').enabled).toBe(true);
    expect(states.find((s) => s.id === 'z').enabled).toBe(false);
  });
});

describe('toggleRepo', () => {
  it('勾选/取消互斥', () => {
    expect(toggleRepo([], { id: '1', enabled: true })).toEqual(['1']);
    expect(toggleRepo(['1'], { id: '1', enabled: true })).toEqual([]);
  });

  it('禁用且未勾选的仓库不可勾选', () => {
    expect(toggleRepo(['1'], { id: '4', enabled: false })).toEqual(['1']);
  });

  it('已勾选的仓库始终可取消', () => {
    expect(toggleRepo(['4'], { id: '4', enabled: true })).toEqual([]);
  });
});
