import { useState, useCallback, useRef, useEffect } from 'react';
import { useWorkspaceFiles } from './useWorkspaceFiles';

export function useEditorTabs(projectId, sessionId, ready) {
  const [tabs, setTabs] = useState([]);
  const [activePath, setActivePath] = useState(null);
  const [diffView, setDiffView] = useState(null);
  const { listFiles, readFile, writeFile, createDir, deleteFile, deleteDir, moveFile } = useWorkspaceFiles();
  const fetchDirLock = useRef({});
  const lastProjectId = useRef(projectId);
  const lastSessionId = useRef(sessionId);
  const autoOpenedForProject = useRef(null);
  const [treeRefreshTrigger, setTreeRefreshTrigger] = useState(0);
  const bumpTreeRefresh = useCallback(() => setTreeRefreshTrigger((n) => n + 1), []);

  // tabsRef keeps the latest tabs array without triggering re-renders,
  // allowing callbacks (openFile, saveTab, showDiff) to have stable
  // identity instead of depending on `tabs` (which changes on every keystroke).
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  // projectId or sessionId 变化时重置 state，防止跨 session state 泄漏
  useEffect(() => {
    const projectChanged = lastProjectId.current !== projectId;
    const sessionChanged = lastSessionId.current !== sessionId;
    if (projectChanged || sessionChanged) {
      lastProjectId.current = projectId;
      lastSessionId.current = sessionId;
      tabsRef.current = [];
      activePathRef.current = null;
      autoOpenedForProject.current = null;
      setTabs([]);
      setActivePath(null);
      setDiffView(null);
      fetchDirLock.current = {};
      setTreeRefreshTrigger(0);
    }
  }, [projectId, sessionId]);

  const openFile = useCallback(async (projectId, file) => {
    if (!file || file.type !== 'file') return;
    const path = file.path;
    const current = tabsRef.current[0];
    // 单文件模式：右侧同时只保留一个已打开文件
    if (current?.path === path) {
      setActivePath(path);
      return;
    }
    const result = await readFile(projectId, path);
    const now = Date.now();
    const next = {
      path,
      content: result.isBinary ? '' : (result.content || ''),
      originalContent: result.isBinary ? '' : (result.content || ''),
      isBinary: !!result.isBinary,
      loadedAt: now,
    };
    tabsRef.current = [next];
    setTabs([next]);
    setActivePath(path);
  }, [readFile]);

  const closeTab = useCallback((path) => {
    const current = tabsRef.current[0];
    if (!current || (path && current.path !== path)) return;
    tabsRef.current = [];
    activePathRef.current = null;
    setTabs([]);
    setActivePath(null);
  }, []);

  const selectTab = useCallback((path, newContent) => {
    setActivePath(path);
    activePathRef.current = path;
    if (newContent !== undefined) {
      // 同步更新 tabsRef，避免自动保存读到过期 content
      setTabs((prev) => {
        const next = prev.map((t) =>
          t.path === path ? { ...t, content: newContent } : t
        );
        tabsRef.current = next;
        return next;
      });
    }
  }, []);

  const saveTab = useCallback(async (projectId, path) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab) return;
    if (tab.content === tab.originalContent) return;
    await writeFile(projectId, path, tab.content, { loadedAt: tab.loadedAt });
    // 保存成功：更新 originalContent 和 loadedAt
    const savedAt = Date.now();
    setTabs((prev) => {
      const next = prev.map((t) =>
        t.path === path ? { ...t, originalContent: t.content, loadedAt: savedAt } : t
      );
      tabsRef.current = next;
      return next;
    });
  }, [writeFile]);

  const showDiff = useCallback(async (projectId, path) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || tab.isBinary) return;
    setDiffView({ path, original: null, modified: tab.content, loading: true });
    try {
      const result = await readFile(projectId, path);
      setDiffView({ path, original: result.content || '', modified: tab.content, loading: false });
    } catch (err) {
      setDiffView(null);
      throw err;
    }
  }, [readFile]);

  const closeDiff = useCallback(() => {
    setDiffView(null);
  }, []);

  const fetchDir = useCallback(async (projectId, path) => {
    const key = `${projectId}:${path}`;
    if (fetchDirLock.current[key]) return fetchDirLock.current[key];
    const promise = listFiles(projectId, path, 'single').catch(() => []);
    fetchDirLock.current[key] = promise;
    try {
      return await promise;
    } finally {
      delete fetchDirLock.current[key];
    }
  }, [listFiles]);

  // 进入 session 时默认打开根目录文档（优先 README）
  useEffect(() => {
    if (!projectId || !ready) return;
    if (autoOpenedForProject.current === sessionId) return;
    if (tabsRef.current.length > 0) {
      autoOpenedForProject.current = sessionId;
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const entries = await fetchDir(projectId, '.');
        if (cancelled || autoOpenedForProject.current === sessionId) return;
        if (tabsRef.current.length > 0) {
          autoOpenedForProject.current = sessionId;
          return;
        }
        // 只在存在 README 时打开它（并显示内容）；没有 README 不打开任何文件
        const readme = (entries || []).find(
          (f) => f.type === 'file' && /^readme(\.|$)/i.test(f.name || f.path),
        );
        autoOpenedForProject.current = sessionId;
        if (readme) await openFile(projectId, readme);
      } catch {
        if (!cancelled) autoOpenedForProject.current = sessionId;
      }
    })();

    return () => { cancelled = true; };
  }, [projectId, sessionId, ready, fetchDir, openFile]);

  const handleCreateFile = useCallback(async (projectId, name) => {
    // 先创建空文件，然后打开 tab 进入编辑模式
    await writeFile(projectId, name, '');
    bumpTreeRefresh();
  }, [writeFile, bumpTreeRefresh]);

  const handleCreateDir = useCallback(async (projectId, name) => {
    await createDir(projectId, name);
    bumpTreeRefresh();
  }, [createDir, bumpTreeRefresh]);

  const closeTabByPath = useCallback((path) => {
    const current = tabsRef.current[0];
    if (!current || current.path !== path) return;
    tabsRef.current = [];
    activePathRef.current = null;
    setTabs([]);
    setActivePath(null);
  }, []);

  const renameTabPath = useCallback((oldPath, newPath) => {
    const current = tabsRef.current[0];
    if (!current || current.path !== oldPath) return;
    const next = { ...current, path: newPath };
    tabsRef.current = [next];
    setTabs([next]);
    if (activePathRef.current === oldPath) {
      activePathRef.current = newPath;
      setActivePath(newPath);
    }
  }, []);

  return {
    tabs,
    activePath,
    diffView,
    openFile,
    closeTab,
    selectTab,
    saveTab,
    showDiff,
    closeDiff,
    fetchDir,
    handleCreateFile,
    handleCreateDir,
    deleteFile,
    deleteDir,
    moveFile,
    closeTabByPath,
    renameTabPath,
    treeRefreshTrigger,
    bumpTreeRefresh,
  };
}
