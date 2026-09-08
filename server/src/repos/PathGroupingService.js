/**
 * PathGroupingService — 路径解析 + 分组 + 校验 (纯函数，无副作用)
 *
 * 用于多仓库项目导入场景：
 * - 路径分隔符: `/`
 * - 路径最少 2 层 (如 `a/b`)
 * - 同一 import batch 中所有 repo 必须共享前 2 层
 * - 3+ 层 repo 按前 2 层合并为 1 行，下拉展示叶子
 * - 2 层 repo 为 flat row
 *
 * 这是纯函数模块，前后端共享同一组语义。
 * 客户端实现见 `web/src/lib/pathGrouping.js`。
 */

const SEPARATOR = '/';
const MIN_SEGMENTS = 2;
const PREFIX_DEPTH = 2;
const MERGE_MIN_DEPTH = 3;

const INVALID_SEGMENT_CHARS = /[\\:*?"<>|\x00-\x1f]/;

/**
 * 解析路径为 segments 数组
 * @param {string} p
 * @returns {string[]|null} 非法返回 null
 */
function parsePath(p) {
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

/**
 * 取前 N 层 join 为字符串
 */
function prefixOf(segs, n) {
  return segs.slice(0, n).join(SEPARATOR);
}

/**
 * 校验一批 path 全部共享前 2 层且都 ≥ 2 层
 * @param {string[]} paths
 * @returns {{ ok: boolean, error?: string, prefix?: string }}
 */
function validateBatch(paths) {
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

/**
 * 把一批 repo 路径分组成 UI 渲染结构
 *
 * 返回结构：
 * {
 *   prefix: string,           // 共享前 2 层
 *   groups: [
 *     { prefix, type: 'flat' | 'merged', items: [{ path, leaf, fullPath, segments }] }
 *   ],
 *   error: string | null
 * }
 *
 * @param {string[]} paths
 */
function groupPaths(paths) {
  const validation = validateBatch(paths);
  if (!validation.ok) {
    return { prefix: null, groups: [], error: validation.error };
  }
  const segsList = paths.map(parsePath);
  const sharedPrefix = validation.prefix;

  // 把所有路径按 (类型) 分桶
  // 规则: 同 prefix 下, 2 层 → flat row; 3+ 层 → merged row (共享 prefix)
  // 实际只有 1 个 merged row (因为所有 3+ 层 repo 共享 prefix)
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

module.exports = {
  parsePath,
  prefixOf,
  validateBatch,
  groupPaths,
  SEPARATOR,
  MIN_SEGMENTS,
  PREFIX_DEPTH,
  MERGE_MIN_DEPTH,
};
