import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, RotateCw, ScrollText, Search, Trash2, X } from 'lucide-react';

import Button from '../components/Button';
import BuildLogDialog from '../components/BuildLogDialog';
import Input from '../components/Input';
import RowActionsMenu from '../components/RowActionsMenu';
import SelectMenu from '../components/SelectMenu';
import StatusBadge from '../components/StatusBadge';
import {
  ConsoleDialogShell,
  ConsoleStructuredDialogBody,
  ConsoleStructuredDialogFooter,
  ConsoleStructuredDialogHeader,
} from '../components/ConsoleDialog';
import { useToast } from '../components/Toast';
import {
  consoleAdminPageClass,
  consoleButtonFocusClass,
  consoleDialogPanelClass,
  consoleIconButtonClass,
  consoleSectionLabelClass,
  consoleStructuredDialogPanelClass,
  consoleTableBodyCellClass,
  consoleTableHeadCellClass,
  consoleTableHeadRowClass,
  consoleTableShellClass,
} from '../lib/consoleTokens';
import { formatDuration, getBuildState } from '../lib/imageBuildStates';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import { cn } from '../lib/utils';
import { apiFetch } from '../lib/api';

function formatTime(ts) {
  if (!ts) return '\u2014';
  return new Date(ts).toLocaleString();
}

function stateBadge(state) {
  const entry = getBuildState(state);
  return (
    <StatusBadge tone={entry.tone} icon={entry.icon} spinning={entry.spinning} label={entry.label} />
  );
}

function componentIds(components) {
  return Array.isArray(components)
    ? components.map((c) => (c.component_id || '').replace(/^(agent:|lang:|tool:)/, ''))
    : [];
}

const CATEGORY_ORDER = ['agent', 'language', 'database', 'devops', 'package-manager', 'shell-tool'];

const CATEGORY_LABELS = {
  agent: 'Agents', language: 'Languages', database: 'Databases',
  devops: 'DevOps', 'package-manager': 'Package Managers', 'shell-tool': 'Shell Tools',
};

async function fetchCatalog() {
  const res = await apiFetch('/api/v1/custom-images/catalog');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load catalog');
  return data;
}

async function fetchImages() {
  const res = await apiFetch('/api/v1/custom-images');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load images');
  return { images: data.images ?? data, count: data.count, max: data.max };
}

export function CustomImagesContent() {
  const { showToast } = useToast();
  const nameRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState(null);
  const [images, setImages] = useState([]);
  const [imageQuota, setImageQuota] = useState({ count: 0, max: 10 });
  const [selectedComponentIds, setSelectedComponentIds] = useState([]);
  const [componentVersions, setComponentVersions] = useState({});
  const [imageName, setImageName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [pollIds, setPollIds] = useState(new Set());
  const [showCreate, setShowCreate] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [componentSearch, setComponentSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set(CATEGORY_ORDER));
  const [logImage, setLogImage] = useState(null);
  const [rebuildingId, setRebuildingId] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const inProgressCount = images.filter(
    (img) => img.status === 'queued' || img.status === 'building',
  ).length;

  useEffect(() => {
    if (inProgressCount === 0) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [inProgressCount]);

  const filteredImages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return images;
    return images.filter((img) => {
      const haystack = [img.name, ...componentIds(img.components)].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [images, searchQuery]);

  const filteredComponents = useMemo(() => {
    const q = componentSearch.trim().toLowerCase();
    if (!q) return catalog?.components || [];
    return (catalog?.components || []).filter((c) => (c.name || '').toLowerCase().includes(q));
  }, [catalog, componentSearch]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [cat, imgData] = await Promise.all([fetchCatalog(), fetchImages()]);
      setCatalog(cat);
      setImages(imgData.images);
      setImageQuota({ count: imgData.count ?? imgData.images?.length ?? 0, max: imgData.max ?? 10 });

      const polling = new Set();
      for (const img of imgData.images) {
        if (img.latest_build && (img.latest_build.state === 'queued' || img.latest_build.state === 'building')) {
          polling.add(img.id);
        }
      }
      setPollIds(polling);
    } catch (err) {
      showToast('error', err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    if (pollIds.size === 0) return;
    const interval = setInterval(async () => {
      try {
        const imgData = await fetchImages();
        setImages(imgData.images);
        setImageQuota({ count: imgData.count ?? imgData.images?.length ?? 0, max: imgData.max ?? 10 });

        const stillPolling = new Set();
        for (const img of imgData.images) {
          if (img.latest_build && (img.latest_build.state === 'queued' || img.latest_build.state === 'building')) {
            stillPolling.add(img.id);
          }
        }
        setPollIds(stillPolling);
      } catch { /* ignore polling errors */ }
    }, 10000);

    return () => clearInterval(interval);
  }, [pollIds.size]);


  const componentMap = useMemo(() => {
    if (!catalog?.components) return {};
    return Object.fromEntries(catalog.components.map((c) => [c.id, c]));
  }, [catalog]);

  function resetForm() {
    setSelectedComponentIds([]);
    setComponentVersions({});
    setImageName('');
    setShowCreate(false);
  }

  function toggleGroup(category) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  function openCreate() {
    resetForm();
    setShowCreate(true);
    setTimeout(() => nameRef.current?.focus(), 50);
  }

  async function handleCreate(event) {
    event.preventDefault();
    if (!imageName.trim()) {
      showToast('error', 'Image name is required');
      return;
    }
    if (selectedComponentIds.length === 0) {
      showToast('error', 'Select at least one component');
      return;
    }
    const hasAgent = selectedComponentIds.some((id) => id.startsWith('agent:'));
    if (!hasAgent) {
      showToast('error', 'Select an agent (required)');
      return;
    }

    const selection = selectedComponentIds.map((compId) => ({
      component_id: compId,
      version: componentVersions[compId] || componentMap[compId]?.defaultVersion || 'latest',
    }));

    const missingVersion = selection.find((s) => !s.version);
    if (missingVersion) {
      showToast('error', `Select a version for ${componentMap[missingVersion.component_id]?.name || missingVersion.component_id}`);
      return;
    }

    setCreating(true);
    try {
      const res = await apiFetch('/api/v1/custom-images', {
        method: 'POST',
        body: JSON.stringify({ name: imageName.trim(), selection }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to create image');

      setImages((prev) => [data, ...prev]);
      setImageQuota((prev) => ({ ...prev, count: prev.count + 1 }));
      setPollIds((prev) => new Set([...prev, data.id]));
      resetForm();
      showToast('success', 'Image build started');
    } catch (err) {
      showToast('error', err.message || 'Failed to create image');
    } finally {
      setCreating(false);
    }
  }

  async function handleRebuild(image) {
    setRebuildingId(image.id);
    try {
      const res = await apiFetch(`/api/v1/custom-images/${image.id}/rebuild`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to rebuild image');

      setImages((prev) => prev.map((img) => (img.id === image.id ? data : img)));
      setPollIds((prev) => new Set([...prev, image.id]));
      showToast('success', `Rebuild started for "${image.name}"`);
    } catch (err) {
      showToast('error', err.message || 'Failed to rebuild image');
    } finally {
      setRebuildingId(null);
    }
  }

  async function handleDelete(image) {
    setDeletingId(image.id);
    try {
      const res = await apiFetch(`/api/v1/custom-images/${image.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to delete image');

      setImages((prev) => prev.filter((img) => img.id !== image.id));
      setImageQuota((prev) => ({ ...prev, count: Math.max(0, prev.count - 1) }));
      setPollIds((prev) => {
        const next = new Set(prev);
        next.delete(image.id);
        return next;
      });
      setConfirmDelete(null);
      showToast('success', `Deleted "${image.name}"`);
    } catch (err) {
      showToast('error', err.message || 'Failed to delete image');
    } finally {
      setDeletingId(null);
    }
  }

  const enabled = catalog?.enabled !== false;
  const agentSelected = selectedComponentIds.some((id) => id.startsWith('agent:'));

  return (
    <>
      {!enabled && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Custom image builds are currently disabled. Set <code className="bg-amber-100 px-1 rounded">CUSTOM_IMAGE_BUILDS_ENABLED=true</code> and ensure Docker is available.
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>{imageQuota.count} / {imageQuota.max} images</span>
          {imageQuota.count >= imageQuota.max && (
            <span className="text-amber-600 font-medium">(limit reached)</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search images…"
              className="w-full pl-8"
            />
          </div>
          <button
            type="button"
            onClick={loadAll}
            disabled={loading}
            className={consoleIconButtonClass}
            title="Refresh"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
          <Button onClick={openCreate} disabled={!enabled || imageQuota.count >= imageQuota.max} size="md">
            <Plus className="w-4 h-4" />
            New Image
          </Button>
        </div>
      </div>

      {/* Create Dialog */}
      {showCreate && (
      <ConsoleDialogShell onClose={resetForm} fitContent>
        <form onSubmit={handleCreate}>
          <div className={cn(consoleStructuredDialogPanelClass, 'w-[680px] max-w-[calc(100vw-2rem)] h-[560px]')}>
            <ConsoleStructuredDialogHeader
              title="New Image"
              subtitle="Select components and versions to build your image"
            />
            <ConsoleStructuredDialogBody>
              <div className="flex flex-col gap-4">
                <div>
                  <div className={consoleSectionLabelClass}>Image Name<span className="text-red-500 ml-0.5">*</span></div>
                  <Input
                    ref={nameRef}
                    value={imageName}
                    onChange={(e) => setImageName(e.target.value)}
                    placeholder="my-custom-stack"
                    disabled={creating}
                    className="w-full"
                  />
                </div>

                <div className="grid grid-cols-[2fr_3fr] gap-4">
                  {/* Component library */}
                  <div className="min-w-0">
                    <div className={consoleSectionLabelClass}>Components<span className="text-red-500 ml-0.5">*</span></div>
                    <div className="relative mt-1.5">
                      <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                      <Input
                        value={componentSearch}
                        onChange={(e) => setComponentSearch(e.target.value)}
                        placeholder="Search components…"
                        className="w-full pl-8"
                      />
                    </div>
                    <div className="mt-1.5 border border-zinc-200 rounded-lg max-h-56 overflow-y-auto console-scroll-hidden">
                      {!filteredComponents.length ? (
                        <p className="px-3 py-4 text-xs text-zinc-400">
                          {catalog?.components?.length ? 'No components match your search.' : 'No components available.'}
                        </p>
                      ) : (
                        (() => {
                          const grouped = {};
                          for (const comp of filteredComponents) {
                            (grouped[comp.category] || (grouped[comp.category] = [])).push(comp);
                          }
                          const searching = componentSearch.trim() !== '';
                          return CATEGORY_ORDER.filter((cat) => grouped[cat]?.length > 0).map((cat) => {
                            const expanded = !collapsedGroups.has(cat) || searching;
                            return (
                            <div key={cat}>
                              <button
                                type="button"
                                onClick={() => toggleGroup(cat)}
                                className={cn(
                                  'w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500 bg-zinc-50 border-b border-zinc-100 hover:bg-zinc-100 transition-colors',
                                  consoleButtonFocusClass,
                                )}
                                aria-expanded={expanded}
                              >
                                {expanded
                                  ? <ChevronDown className="h-3 w-3 shrink-0" />
                                  : <ChevronRight className="h-3 w-3 shrink-0" />}
                                <span className="flex-1 text-left">
                                  {CATEGORY_LABELS[cat] || cat}
                                  {cat === 'agent' && <span className="text-red-500 ml-0.5">*</span>}
                                </span>
                                <span className="font-normal normal-case text-zinc-400">{grouped[cat].length}</span>
                              </button>
                              {expanded && grouped[cat].map((comp) => {
                                const checked = selectedComponentIds.includes(comp.id);
                                const isAgent = comp.category === 'agent';
                                const agentAlreadySelected = selectedComponentIds.some(
                                  (id) => componentMap[id]?.category === 'agent',
                                );
                                const disabled = isAgent && agentAlreadySelected && !checked;

                                return (
                                  <label
                                    key={comp.id}
                                    className={cn(
                                      'flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-zinc-50 transition-colors',
                                      disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent',
                                    )}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      disabled={creating || disabled}
                                      onChange={() => {
                                        if (creating || disabled) return;
                                        if (checked) {
                                          setSelectedComponentIds((prev) => prev.filter((id) => id !== comp.id));
                                          setComponentVersions((prev) => {
                                            const next = { ...prev };
                                            delete next[comp.id];
                                            return next;
                                          });
                                        } else {
                                          if (isAgent && agentAlreadySelected) {
                                            const existingAgent = selectedComponentIds.find(
                                              (id) => componentMap[id]?.category === 'agent',
                                            );
                                            setSelectedComponentIds((prev) =>
                                              prev.filter((id) => id !== existingAgent).concat(comp.id),
                                            );
                                            setComponentVersions((prev) => {
                                              const next = { ...prev };
                                              delete next[existingAgent];
                                              next[comp.id] = comp.defaultVersion;
                                              return next;
                                            });
                                          } else {
                                            setSelectedComponentIds((prev) => [...prev, comp.id]);
                                            setComponentVersions((prev) => ({
                                              ...prev,
                                              [comp.id]: comp.defaultVersion,
                                            }));
                                          }
                                        }
                                      }}
                                      className="h-4 w-4 shrink-0 rounded border-zinc-300 text-zinc-900 focus:ring-black"
                                    />
                                    <span className="flex-1 min-w-0 truncate text-sm text-zinc-800">
                                      {comp.name}
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                            );
                          });
                        })()
                      )}
                    </div>
                  </div>

                  {/* Selected summary */}
                  <div className="min-w-0">
                    <div className={consoleSectionLabelClass}>Selected ({selectedComponentIds.length})</div>
                    <div className="mt-1.5 border border-zinc-200 rounded-lg max-h-56 overflow-y-auto console-scroll-hidden">
                      {selectedComponentIds.length === 0 ? (
                        <p className="px-3 py-4 text-xs text-zinc-400">
                          No components selected yet. Pick from the list to add.
                        </p>
                      ) : (
                        selectedComponentIds.map((id) => {
                          const comp = componentMap[id];
                          if (!comp) return null;
                          return (
                            <div
                              key={id}
                              className="flex items-center gap-2 px-3 py-2 border-b border-zinc-100 last:border-b-0"
                            >
                              <div className="min-w-0 flex-1">
                                <span className="block truncate text-sm text-zinc-800">{comp.name}</span>
                              </div>
                              {comp.versions?.length > 0 ? (
                                <SelectMenu
                                  value={componentVersions[id] || comp.defaultVersion || ''}
                                  onChange={(v) => {
                                    setComponentVersions((prev) => ({ ...prev, [id]: v }));
                                  }}
                                  options={comp.versions.map((v) => ({ value: v.version, label: v.version }))}
                                  disabled={creating}
                                  className="w-24 shrink-0"
                                />
                              ) : (
                                <span className="shrink-0 font-mono text-xs text-zinc-400">
                                  {componentVersions[id] || comp.defaultVersion || 'latest'}
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedComponentIds((prev) => prev.filter((sid) => sid !== id));
                                  setComponentVersions((prev) => {
                                    const next = { ...prev };
                                    delete next[id];
                                    return next;
                                  });
                                }}
                                disabled={creating}
                                className="p-1 shrink-0 rounded text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                                title={`Remove ${comp.name}`}
                                aria-label={`Remove ${comp.name}`}
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                    {selectedComponentIds.includes('lang:rust') && !selectedComponentIds.includes('lang:cpp') && (
                      <p className="text-xs text-amber-600 mt-1">Tip: select <b>C/C++</b> with Rust to enable <code>cargo build</code> (gcc required for native compilation).</p>
                    )}
                  </div>
                </div>
              </div>
            </ConsoleStructuredDialogBody>
            <ConsoleStructuredDialogFooter>
              <div className="flex items-center gap-2 w-full justify-end">
                <Button type="button" onClick={resetForm} disabled={creating} variant="secondary" size="sm">
                  Cancel
                </Button>
                <Button type="submit" disabled={creating || !imageName.trim() || selectedComponentIds.length === 0 || !agentSelected} size="sm">
                  {creating ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" />Building…</>
                  ) : (
                    'Start Build'
                  )}
                </Button>
              </div>
            </ConsoleStructuredDialogFooter>
          </div>
        </form>
      </ConsoleDialogShell>
      )}

      {/* Build Log Dialog */}
      {logImage && (
        <BuildLogDialog image={logImage} onClose={() => setLogImage(null)} />
      )}

      {/* Delete Confirm Dialog */}
      {confirmDelete && (
        <ConsoleDialogShell onClose={() => setConfirmDelete(null)} fitContent>
          <div className={cn(consoleStructuredDialogPanelClass, 'min-w-[360px] max-w-md')}>
            <ConsoleStructuredDialogHeader
              title="Delete Custom Image"
              subtitle={`Are you sure you want to delete "${confirmDelete.name}"? This cannot be undone.`}
            />
            <ConsoleStructuredDialogFooter>
              <div className="flex items-center gap-2 w-full justify-end">
                <Button onClick={() => setConfirmDelete(null)} disabled={deletingId === confirmDelete.id} variant="secondary" size="sm">
                  Cancel
                </Button>
                <Button
                  onClick={() => handleDelete(confirmDelete)}
                  disabled={deletingId === confirmDelete.id}
                  size="sm"
                  className="bg-red-600 hover:bg-red-700 text-white"
                >
                  {deletingId === confirmDelete.id ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" />Deleting…</>
                  ) : (
                    'Delete'
                  )}
                </Button>
              </div>
            </ConsoleStructuredDialogFooter>
          </div>
        </ConsoleDialogShell>
      )}

      {/* Image List */}
      <div className={cn(consoleTableShellClass, 'overflow-x-auto')}>
        <table className="w-full table-fixed border-collapse text-left text-sm">
          <colgroup>
            <col className="w-1/4" />
            <col className="w-36" />
            <col className="w-1/4" />
            <col className="w-28" />
            <col className="w-28" />
            <col className="w-24" />
          </colgroup>
          <thead>
            <tr className={consoleTableHeadRowClass}>
              <th className={consoleTableHeadCellClass}>Name</th>
              <th className={consoleTableHeadCellClass}>Status</th>
              <th className={consoleTableHeadCellClass}>Components</th>
              <th className={consoleTableHeadCellClass}>Build time</th>
              <th className={consoleTableHeadCellClass}>Created</th>
              <th className={consoleTableHeadCellClass}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && images.length === 0 ? (
              <tr>
                <td colSpan={6} className={cn(consoleTableBodyCellClass, 'text-center text-zinc-400')}>
                  <Loader2 className="h-4 w-4 inline-block animate-spin" /> Loading…
                </td>
              </tr>
            ) : filteredImages.length === 0 ? (
              <tr>
                <td colSpan={6} className={cn(consoleTableBodyCellClass, 'text-center text-zinc-400')}>
                  {images.length === 0
                    ? <>No custom images yet. Click &ldquo;New Image&rdquo; to create one.</>
                    : 'No images match your search.'}
                </td>
              </tr>
            ) : (
              filteredImages.map((img) => {
                const build = img.latest_build;
                const buildTimeMs = img.status === 'building' && build?.started_at
                  ? nowMs - new Date(build.started_at).getTime()
                  : build?.started_at && build?.finished_at
                    ? new Date(build.finished_at) - new Date(build.started_at)
                    : null;
                const names = componentIds(img.components);
                const max = 5;

                return (
                  <tr key={img.id} className="border-b border-zinc-100 align-top">
                    <td className={cn(consoleTableBodyCellClass, 'font-medium text-zinc-900')}>
                      <span className="block truncate" title={img.name}>{img.name}</span>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      {stateBadge(img.status)}
                    </td>
                    <td className={cn(consoleTableBodyCellClass, 'max-w-[320px]')}>
                      {names.length === 0 ? (
                        <span className="text-zinc-400">\u2014</span>
                      ) : names.length <= max ? (
                        <div className="flex flex-wrap gap-1">
                          {names.map((n, i) => (
                            <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-zinc-100 text-zinc-700">{n}</span>
                          ))}
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {names.slice(0, max).map((n, i) => (
                            <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-zinc-100 text-zinc-700">{n}</span>
                          ))}
                          <span className="text-xs text-zinc-400" title={names.slice(max).join(', ')}>
                            +{names.length - max} more
                          </span>
                        </div>
                      )}
                    </td>
                    <td className={cn(consoleTableBodyCellClass, 'text-zinc-500 tabular-nums')}>
                      {buildTimeMs != null ? formatDuration(buildTimeMs) : '\u2014'}
                    </td>
                    <td className={cn(consoleTableBodyCellClass, 'text-zinc-500')}>
                      <span className="block truncate" title={formatTime(img.created_at)}>{formatRelativeTime(img.created_at)}</span>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <RowActionsMenu
                        label={`Actions for ${img.name}`}
                        items={[
                          { icon: ScrollText, label: 'View logs', onClick: () => setLogImage(img) },
                          img.status === 'failed' && {
                            icon: RotateCw,
                            label: 'Rebuild',
                            onClick: () => handleRebuild(img),
                            busy: rebuildingId === img.id,
                            busyLabel: 'Rebuilding…',
                          },
                          { separator: true },
                          {
                            icon: Trash2,
                            label: 'Delete',
                            danger: true,
                            onClick: () => setConfirmDelete(img),
                            busy: deletingId === img.id,
                            busyLabel: 'Deleting…',
                          },
                        ].filter(Boolean)}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function CustomImages() {
  return (
    <div className={consoleAdminPageClass}>
      <CustomImagesContent />
    </div>
  );
}
