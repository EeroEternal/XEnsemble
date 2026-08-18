import { useEffect, useMemo, useRef, useState, useCallback, memo } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Loader2 } from 'lucide-react';
import { buildFileTree, collectAncestorFolderPaths } from '../lib/workspaceFileTree';

const TreeNode = memo(function TreeNode({ node, depth, expanded, selectedPath, onToggle, onOpenFile, onContextMenu }) {
  const indent = depth * 12;
  const handleContextMenu = (e) => {
    e.preventDefault();
    onContextMenu?.(node, e);
  };

  if (node.type === 'file') {
    const selected = selectedPath === node.path;
    return (
      <button
        type="button"
        onClick={() => onOpenFile(node)}
        onContextMenu={handleContextMenu}
        className={`flex w-full min-w-0 items-center gap-0.5 rounded-md py-1 pr-2 text-left text-sm transition-colors ${
          selected ? 'bg-zinc-100 font-medium text-zinc-900' : 'text-zinc-600 hover:bg-zinc-50'
        }`}
        style={{ paddingLeft: indent + 22 }}
        title={node.path}
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <span className="truncate">{node.name}</span>
      </button>
    );
  }

  const isExpanded = expanded.has(node.path);
  const isLoading = node._loading;
  return (
    <div>
      <div
        className="group flex min-w-0 items-center gap-0.5 rounded-md hover:bg-zinc-50"
        style={{ paddingLeft: indent + 4 }}
        onContextMenu={handleContextMenu}
      >
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          className="shrink-0 p-1 text-zinc-400 hover:text-zinc-700"
          aria-expanded={isExpanded}
          aria-label={`Expand/Collapse ${node.name}`}
        >
          {isLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        {isExpanded ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        )}
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          className="min-w-0 flex-1 truncate py-1 pr-2 text-left text-sm text-zinc-800"
          title={node.path}
        >
          {node.name}
        </button>
      </div>
      {isExpanded &&
        node.children.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            selectedPath={selectedPath}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
            onContextMenu={onContextMenu}
          />
        ))}
    </div>
  );
});

function LazyTree({ selectedPath, onOpenFile, projectId, onFetchDir, refreshTrigger = 0, onContextMenu }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const [loadedDirs, setLoadedDirs] = useState(() => new Set());
  const [loadingDirs, setLoadingDirs] = useState(() => new Set());
  const [dirChildren, setDirChildren] = useState(() => ({}));
  const [initialLoading, setInitialLoading] = useState(true);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const loadedDirsRef = useRef(loadedDirs);
  loadedDirsRef.current = loadedDirs;
  const prevRefresh = useRef(refreshTrigger);

  useEffect(() => {
    if (!projectId || !onFetchDir) return;
    setInitialLoading(true);
    onFetchDir(projectId, '.').then((files) => {
      setDirChildren({ '.': files });
      setLoadedDirs(new Set(['.']));
      setInitialLoading(false);
    }).catch(() => {
      setInitialLoading(false);
    });
  }, [projectId, onFetchDir]);

  // Silent refresh when refreshTrigger changes: re-fetch root + all expanded dirs,
  // preserving expanded state. Dirs that fail to fetch (deleted) are collapsed.
  useEffect(() => {
    if (prevRefresh.current === refreshTrigger) return;
    prevRefresh.current = refreshTrigger;
    if (!projectId || !onFetchDir) return;
    const currentExpanded = expandedRef.current;
    const dirsToFetch = ['.', ...Array.from(currentExpanded).filter((p) => p !== '.')];
    Promise.all(dirsToFetch.map((p) => onFetchDir(projectId, p).catch(() => null))).then((results) => {
      const nextChildren = {};
      const nextLoaded = new Set();
      const failedPaths = new Set();
      dirsToFetch.forEach((p, i) => {
        if (results[i] !== null) {
          nextChildren[p] = results[i];
          nextLoaded.add(p);
        } else if (p !== '.') {
          failedPaths.add(p);
        }
      });
      setDirChildren(nextChildren);
      setLoadedDirs(nextLoaded);
      if (failedPaths.size > 0) {
        setExpanded((prev) => {
          const next = new Set(prev);
          for (const p of failedPaths) next.delete(p);
          return next;
        });
      }
    });
  }, [refreshTrigger, projectId, onFetchDir]);

  const toggle = useCallback(async (path) => {
    if (expanded.has(path)) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      return;
    }

    if (!loadedDirs.has(path) && onFetchDir) {
      setLoadingDirs((prev) => new Set(prev).add(path));
      try {
        const files = await onFetchDir(projectId, path);
        setDirChildren((prev) => ({ ...prev, [path]: files }));
        setLoadedDirs((prev) => new Set(prev).add(path));
      } finally {
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      }
    }

    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, [expanded, loadedDirs, onFetchDir, projectId]);

  const buildTree = useCallback((dirPath, depth) => {
    const items = dirChildren[dirPath] || [];
    const nodes = [];
    // Defensive depth limit
    if (depth > 100) return nodes;
    for (const item of items) {
      if (item.type === 'directory') {
        // Skip self-reference
        if (item.path === dirPath) continue;
        nodes.push({
          ...item,
          children: expanded.has(item.path) ? buildTree(item.path, depth + 1) : [],
          _loading: loadingDirs.has(item.path),
        });
      } else {
        nodes.push({ ...item, children: [] });
      }
    }
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }, [dirChildren, expanded, loadingDirs]);

  useEffect(() => {
    if (!selectedPath || !onFetchDir || !projectId) return;
    const ancestors = collectAncestorFolderPaths(selectedPath);
    if (!ancestors.length) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of ancestors) next.add(p);
      return next;
    });
  }, [selectedPath]);

  // Fetch contents of ancestor directories not yet loaded. Runs only after the
  // root directory has finished loading (initialLoading === false). This matters
  // when the component remounts (e.g., switching tabs): the selectedPath effect
  // above adds ancestor folders to `expanded`, but their children may not have
  // been loaded yet. Fetching here — after the root load has completed — avoids
  // racing the root effect, which does a full `setDirChildren({ '.': files })`
  // replacement and would otherwise clobber ancestor data fetched concurrently.
  useEffect(() => {
    if (initialLoading) return;
    if (!selectedPath || !onFetchDir || !projectId) return;
    const ancestors = collectAncestorFolderPaths(selectedPath);
    if (!ancestors.length) return;
    const currentLoaded = loadedDirsRef.current;
    for (const p of ancestors) {
      if (p === '.' || currentLoaded.has(p)) continue;
      onFetchDir(projectId, p).then((files) => {
        setDirChildren((prev) => ({ ...prev, [p]: files }));
        setLoadedDirs((prev) => new Set(prev).add(p));
      }).catch(() => {});
    }
  }, [initialLoading, onFetchDir, projectId, selectedPath]);

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center py-4" data-testid="tree-loading">
        <Loader2 className="animate-spin h-4 w-4 text-zinc-400" />
      </div>
    );
  }

  const tree = buildTree('.', 0);

  if (!tree.length) {
    return <div className="py-4 text-center text-sm text-zinc-400" data-testid="tree-empty">No files</div>;
  }

  return (
    <div className="flex flex-col gap-0.5">
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggle={toggle}
          onOpenFile={onOpenFile}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  );
}

export default function WorkspaceFileTree({ items, selectedPath, onOpenFile, showHidden = false, lazy, projectId, onFetchDir, refreshTrigger, onContextMenu }) {
  if (lazy) {
    return (
      <LazyTree
        selectedPath={selectedPath}
        onOpenFile={onOpenFile}
        projectId={projectId}
        onFetchDir={onFetchDir}
        refreshTrigger={refreshTrigger}
        onContextMenu={onContextMenu}
      />
    );
  }

  const tree = useMemo(() => buildFileTree(items, { showHidden }), [items, showHidden]);
  const [expanded, setExpanded] = useState(() => new Set());

  useEffect(() => {
    if (!selectedPath) return;
    const ancestors = collectAncestorFolderPaths(selectedPath);
    if (!ancestors.length) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of ancestors) next.add(p);
      return next;
    });
  }, [selectedPath]);

  const toggle = (path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (!tree.length) return null;

  return (
    <div className="flex flex-col gap-0.5">
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggle={toggle}
          onOpenFile={onOpenFile}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  );
}
