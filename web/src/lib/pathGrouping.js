/**
 * 前端路径分组纯函数（与后端 PathGroupingService 语义一致）。
 *
 * 关键不变量：
 * - 路径分隔符: `/`
 * - 路径最少 2 层
 * - 同一 batch 中所有 repo 必须共享前 2 层
 * - 3+ 层 repo 按前 2 层合并
 * - 2 层 repo 为 flat row
 *
 * 与后端模块的差异：ES module 语法，导出命名导出。
 */

export const SEPARATOR = '/';
export const MIN_SEGMENTS = 2;
export const PREFIX_DEPTH = 2;
export const MERGE_MIN_DEPTH = 3;

const INVALID_SEGMENT_CHARS = /[\\:*?"<>|\x00-\x1f]/;

export function parsePath(p) {
  if (typeof p !== 'string') return null;
  const trimmed = p.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return null;
  const segs = trimmed.split(SEPARATOR).filter(Boolean);
  if (segs.length < MIN_SEGMENTS) return null;
  for (const s of segs) {
    if (INVALID_SEGMENT_CHARS.test(s)) return null;
    if (s === '.' || s === '..') return null;
  }
  return segs;
}

export function prefixOf(segs, n) {
  return segs.slice(0, n).join(SEPARATOR);
}

export function validateBatch(paths) {
  if (!Array.isArray(paths)) {
    return { ok: false, error: 'paths must be an array' };
  }
  if (paths.length === 0) {
    return { ok: false, error: 'at least one path is required' };
  }
  const segsList = paths.map(parsePath);
  for (let i = 0; i < paths.length; i++) {
    if (segsList[i] === null) {
      return {
        ok: false,
        error: `Invalid path at index ${i}: "${paths[i]}". Each path must be ≥ ${MIN_SEGMENTS} segments separated by "${SEPARATOR}" and contain no special characters.`,
      };
    }
  }
  const prefix2List = segsList.map((s) => prefixOf(s, PREFIX_DEPTH));
  const distinct = [...new Set(prefix2List)];
  if (distinct.length > 1) {
    return {
      ok: false,
      error: `All repos must share the same first ${PREFIX_DEPTH} segments. Found conflicting prefixes: ${distinct.map((p) => `"${p}"`).join(', ')}`,
    };
  }
  return { ok: true, prefix: distinct[0] };
}

export function groupPaths(paths) {
  const validation = validateBatch(paths);
  if (!validation.ok) {
    return { prefix: null, groups: [], error: validation.error };
  }
  const segsList = paths.map(parsePath);
  const sharedPrefix = validation.prefix;

  let flatRow = null;
  let mergedRow = null;
  for (let i = 0; i < paths.length; i++) {
    const segs = segsList[i];
    const path = paths[i];
    if (segs.length === MIN_SEGMENTS) {
      if (!flatRow) {
        flatRow = { prefix: sharedPrefix, type: 'flat', items: [] };
      }
      flatRow.items.push({ path, leaf: null, fullPath: path, segments: segs });
    } else {
      if (!mergedRow) {
        mergedRow = { prefix: sharedPrefix, type: 'merged', items: [] };
      }
      const leaf = segs[PREFIX_DEPTH];
      mergedRow.items.push({ path, leaf, fullPath: path, segments: segs });
    }
  }

  const groups = [];
  if (flatRow) groups.push(flatRow);
  if (mergedRow) groups.push(mergedRow);

  return { prefix: sharedPrefix, groups, error: null };
}
