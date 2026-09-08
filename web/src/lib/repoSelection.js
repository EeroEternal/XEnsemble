// 仓库勾选层级约束（多仓库导入）：所有仓库平铺展示，勾选第一个后锁定其前缀组。
// 前缀 = full_name 去掉最后一段（group/subgroup/repo → group/subgroup）。
// 同前缀（同业务组）可继续勾选；不同前缀禁用；取消全部勾选后重新开放。

export function prefixOf(fullName) {
  const s = String(fullName || '');
  const idx = s.lastIndexOf('/');
  return idx > 0 ? s.slice(0, idx) : '';
}

/**
 * 计算每个仓库的勾选可用状态。
 * @param {Array<{id: string|number, full_name: string}>} repos
 * @param {Array<string|number>} selectedIds
 * @returns {Array<{id, full_name, enabled, checked}>}
 */
export function computeSelectionState(repos, selectedIds) {
  const ids = Array.isArray(selectedIds) ? selectedIds : [];
  const first = repos.find((r) => ids.includes(r.id));
  const lockedPrefix = first ? prefixOf(first.full_name) : null;
  return repos.map((r) => ({
    ...r,
    enabled: lockedPrefix === null || prefixOf(r.full_name) === lockedPrefix,
    checked: ids.includes(r.id),
  }));
}

/**
 * 切换勾选：禁用状态的仓库不可勾选。
 * @param {Array<string|number>} selectedIds
 * @param {{id: string|number, enabled: boolean}} repo
 * @returns {Array<string|number>} 新数组（不可变）
 */
export function toggleRepo(selectedIds, repo) {
  if (!repo?.enabled && !selectedIds.includes(repo?.id)) return selectedIds;
  return selectedIds.includes(repo.id)
    ? selectedIds.filter((id) => id !== repo.id)
    : [...selectedIds, repo.id];
}
