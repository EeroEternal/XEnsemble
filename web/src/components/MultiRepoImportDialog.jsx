import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { groupPaths, validateBatch, parsePath } from '../lib/pathGrouping';

/**
 * MultiRepoImportDialog — 多仓库项目导入弹窗 (核心 prototype)
 *
 * 核心特性：
 * - 用户输入 repo URL + sub_path（≥ 2 层）
 * - 实时调 groupPaths() 计算分组
 * - 共享前 2 层前缀 → 同一 row，下拉展示叶子
 * - 不共享前缀 → 提交按钮禁用 + 错误提示
 * - 2 层 repo → flat row
 * - 3+ 层 repo → merged row
 *
 * Props:
 *   open: boolean
 *   onClose: () => void
 *   onSubmit: ({ repos: [{role, sub_path, repo_url, is_primary}] }) => Promise
 */
export function MultiRepoImportDialog({ open, onClose, onSubmit }) {
  const { t } = useTranslation(['workspace']);
  const [items, setItems] = useState([
    { id: nextItemId(), role: 'frontend', sub_path: '', repo_url: '' },
  ]);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const updateItem = useCallback((id, key, value) => {
    setItems((arr) => arr.map((it) => (it.id === id ? { ...it, [key]: value } : it)));
  }, []);

  const addItem = useCallback(() => {
    setItems((arr) => [
      ...arr,
      { id: nextItemId(), role: 'backend', sub_path: '', repo_url: '' },
    ]);
  }, []);

  const removeItem = useCallback((id) => {
    setItems((arr) => arr.filter((it) => it.id !== id));
  }, []);

  const validPaths = useMemo(
    () => items.map((it) => it.sub_path).filter((p) => p && parsePath(p)),
    [items],
  );

  const grouping = useMemo(() => {
    if (validPaths.length === 0) {
      return { prefix: null, groups: [], error: null };
    }
    return groupPaths(validPaths);
  }, [validPaths]);

  const validation = useMemo(() => {
    if (items.length === 0) return { ok: false, error: t('workspace:multiRepo.empty', { defaultValue: 'Add at least one repo' }) };
    const incomplete = items.filter((it) => !it.sub_path || !it.repo_url);
    if (incomplete.length > 0) {
      return { ok: false, error: t('workspace:multiRepo.incompleteRow', { defaultValue: 'All rows must have sub_path and repo_url' }) };
    }
    return { ok: true, error: null };
  }, [items, t]);

  const canSubmit = validation.ok && !grouping.error && validPaths.length > 0;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const repos = items.map((it, idx) => ({
        role: it.role,
        sub_path: it.sub_path,
        repo_url: it.repo_url,
        is_primary: idx === 0,
      }));
      await onSubmit({ repos });
    } catch (err) {
      setSubmitError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [canSubmit, items, onSubmit]);

  if (!open) return null;

  return (
    <div
      data-testid="multi-repo-import-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-hidden bg-white dark:bg-zinc-900 rounded-lg shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-3 pb-1 shrink-0">
          <h2 className="font-bold text-lg text-zinc-900 dark:text-zinc-100">
            {t('workspace:multiRepo.title', { defaultValue: 'Import repositories' })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex items-center justify-center w-8 h-8 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 px-6 py-3 overflow-y-auto">
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
            {t('workspace:multiRepo.hint', { defaultValue: 'Each sub_path must be ≥ 2 segments separated by /, e.g. myorg/frontend. Repos sharing the first 2 segments will be grouped.' })}
          </p>

          {/* Items editor */}
          <div className="flex flex-col gap-2 mb-4">
            {items.map((it) => (
              <div
                key={it.id}
                className="grid grid-cols-[120px_1fr_1fr_auto] gap-2 items-center"
                data-testid={`repo-row-${it.id}`}
              >
                <select
                  value={it.role}
                  onChange={(e) => updateItem(it.id, 'role', e.target.value)}
                  className="bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 text-sm"
                  data-testid={`role-select-${it.id}`}
                >
                  <option value="frontend">frontend</option>
                  <option value="backend">backend</option>
                  <option value="shared">shared</option>
                  <option value="infra">infra</option>
                  <option value="custom">custom</option>
                </select>
                <input
                  placeholder="sub_path (e.g. myorg/web)"
                  value={it.sub_path}
                  onChange={(e) => updateItem(it.id, 'sub_path', e.target.value)}
                  className="bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 text-sm"
                  data-testid={`subpath-input-${it.id}`}
                />
                <input
                  placeholder="https://github.com/owner/repo.git"
                  value={it.repo_url}
                  onChange={(e) => updateItem(it.id, 'repo_url', e.target.value)}
                  className="bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 text-sm"
                  data-testid={`url-input-${it.id}`}
                />
                <button
                  type="button"
                  onClick={() => removeItem(it.id)}
                  className="text-red-500 hover:text-red-700 px-2"
                  data-testid={`remove-${it.id}`}
                  aria-label="Remove"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addItem}
              className="self-start text-sm text-blue-600 dark:text-blue-400 hover:underline"
              data-testid="add-row"
            >
              {t('workspace:multiRepo.addRow', { defaultValue: '+ Add repo' })}
            </button>
          </div>

          {/* Grouping preview */}
          {validPaths.length > 0 && (
            <div
              className="border border-zinc-200 dark:border-zinc-700 rounded p-3 mb-3"
              data-testid="grouping-preview"
            >
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
                {t('workspace:multiRepo.preview', { defaultValue: 'Preview' })}:
              </div>
              {grouping.error ? (
                <div className="text-sm text-red-600 dark:text-red-400" data-testid="grouping-error">
                  {grouping.error}
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {grouping.groups.map((g, gi) => (
                    <div
                      key={`${g.type}-${gi}`}
                      className="flex items-center gap-2 text-sm"
                      data-testid={`group-${g.type}-${gi}`}
                    >
                      <span className="font-mono px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 rounded text-zinc-900 dark:text-zinc-100">
                        {g.prefix}
                      </span>
                      {g.type === 'flat' ? (
                        <span className="text-zinc-600 dark:text-zinc-400">
                          ({g.items.length} {t('workspace:multiRepo.flatItem', { defaultValue: 'flat item' })})
                        </span>
                      ) : (
                        <select
                          className="bg-zinc-50 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-0.5 text-sm"
                          data-testid={`merged-dropdown-${gi}`}
                        >
                          {g.items.map((it) => (
                            <option key={it.path} value={it.path}>
                              {it.leaf} ({it.fullPath})
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {submitError && (
            <div className="text-sm text-red-600 dark:text-red-400 mb-2" data-testid="submit-error">
              {submitError}
            </div>
          )}
        </div>

        <div className="flex justify-between gap-2 px-6 py-3 border-t border-zinc-200 dark:border-zinc-700">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded"
          >
            {t('common:cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || busy}
            data-testid="submit-button"
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy
              ? t('workspace:multiRepo.submitting', { defaultValue: 'Importing…' })
              : t('workspace:multiRepo.submit', { defaultValue: 'Import' })}
          </button>
        </div>
      </div>
    </div>
  );
}

let _idCounter = 0;
function nextItemId() {
  _idCounter += 1;
  return `item_${_idCounter}_${Date.now()}`;
}

export default MultiRepoImportDialog;
