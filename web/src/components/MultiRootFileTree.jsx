import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import WorkspaceFileTree from './WorkspaceFileTree';
import { useProjectRepos } from '../hooks/useProjectRepos';
import { textPrimary, textSecondary, borderHairline } from '../lib/consoleTokens';

/**
 * MultiRootFileTree — 多根文件树（多仓库项目）
 *
 * - 无 project_repos 记录或单 repo：回退原 WorkspaceFileTree（存量项目零影响）
 * - 多 repo：仓库标签栏 + 每 repo 一棵树（rootPath=<subPath>，VS Code multi-root 风格）
 *   树的选中路径/打开文件回调透传原 props（entry.path 相对 workspace 根，天然带 <subPath> 前缀）
 */
export default function MultiRootFileTree({ projectId, sessionId, onFetchDir, selectedPath, onOpenFile, refreshTrigger, onContextMenu }) {
  const { t } = useTranslation('workspace');
  const { repos, loading, error } = useProjectRepos(projectId);
  const [activeRepoId, setActiveRepoId] = useState(null);

  // 默认选中 primary repo；repos 变化时若当前选中不存在则重置
  useEffect(() => {
    if (repos.length === 0) {
      setActiveRepoId(null);
      return;
    }
    if (!repos.some((r) => r.id === activeRepoId)) {
      setActiveRepoId((repos.find((r) => r.isPrimary) || repos[0]).id);
    }
  }, [repos, activeRepoId]);

  // 存量单仓库 / 无记录：原样渲染（回退）
  if (repos.length <= 1) {
    return (
      <WorkspaceFileTree
        lazy
        projectId={projectId}
        sessionId={sessionId}
        onFetchDir={onFetchDir}
        selectedPath={selectedPath}
        onOpenFile={onOpenFile}
        refreshTrigger={refreshTrigger}
        onContextMenu={onContextMenu}
      />
    );
  }

  if (loading) {
    return <div className={`p-4 text-xs ${textSecondary}`}>{t('repos.loading', { defaultValue: 'Loading repositories…' })}</div>;
  }
  if (error) {
    return <div className="p-4 text-xs text-red-500">{t('repos.load_failed', { defaultValue: 'Failed to load repositories' })}</div>;
  }

  const activeRepo = repos.find((r) => r.id === activeRepoId) || repos[0];

  return (
    <div className="flex flex-col min-h-0">
      <div className={`flex shrink-0 overflow-x-auto border-b ${borderHairline}`}>
        {repos.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setActiveRepoId(r.id)}
            data-testid={`repo-tab-${r.subPath}`}
            className={`px-2.5 py-1.5 text-xs whitespace-nowrap transition-colors ${
              r.id === activeRepo.id
                ? `bg-white ${textPrimary} border-b-2 border-zinc-900 font-medium`
                : `${textSecondary} hover:text-zinc-900`
            }`}
          >
            {r.subPath}
            {r.isPrimary && <span className="ml-1 text-[10px] text-zinc-400" title={t('repos.primary', { defaultValue: 'Primary repository' })}>●</span>}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-1">
        <WorkspaceFileTree
          key={activeRepo.id}
          lazy
          projectId={projectId}
          sessionId={sessionId}
          onFetchDir={onFetchDir}
          selectedPath={selectedPath}
          onOpenFile={onOpenFile}
          refreshTrigger={refreshTrigger}
          onContextMenu={onContextMenu}
          rootPath={activeRepo.subPath}
        />
      </div>
    </div>
  );
}
