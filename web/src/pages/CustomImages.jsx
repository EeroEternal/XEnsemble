import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Loader2, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';

import Button from '../components/Button';
import Input from '../components/Input';
import PageHeader from '../components/PageHeader';
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
  consoleSectionLabelClass,
  consoleStructuredDialogPanelClass,
  consoleAdminTableShellClass,
  consoleTableBodyCellClass,
  consoleTableHeadCellClass,
} from '../lib/consoleTokens';
import { cn } from '../lib/utils';
import { apiFetch } from '../lib/api';

const BUILD_STATES = {
  queued: { label: 'Queued', icon: Clock, tone: 'warning' },
  building: { label: 'Building', icon: Loader2, tone: 'info', spinning: true },
  ready: { label: 'Ready', icon: CheckCircle2, tone: 'success' },
  failed: { label: 'Failed', icon: XCircle, tone: 'danger' },
};

function formatTime(ts) {
  if (!ts) return '\u2014';
  return new Date(ts).toLocaleString();
}

function stateBadge(state) {
  const entry = BUILD_STATES[state] || { label: state || '\u2014', icon: null, tone: 'neutral' };
  return (
    <StatusBadge tone={entry.tone} icon={entry.icon} spinning={entry.spinning} label={entry.label} />
  );
}

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
      <PageHeader
        title="Custom Images"
        description="Combine components into a pre-installed sandbox image."
        actions={
          <div className="flex items-center gap-2">
            <Button onClick={loadAll} disabled={loading} size="md" variant="secondary">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </Button>
            <Button onClick={openCreate} disabled={!enabled || imageQuota.count >= imageQuota.max} size="md">
              <Plus className="w-4 h-4" />
              New Image
            </Button>
          </div>
        }
      />

      {!enabled && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Custom image builds are currently disabled. Set <code className="bg-amber-100 px-1 rounded">CUSTOM_IMAGE_BUILDS_ENABLED=true</code> and ensure Docker is available.
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-zinc-500 mt-1">
        <span>{imageQuota.count} / {imageQuota.max} images</span>
        {imageQuota.count >= imageQuota.max && (
          <span className="text-amber-600 font-medium">(limit reached)</span>
        )}
      </div>

      {/* Create Dialog */}
      {showCreate && (
      <ConsoleDialogShell onClose={resetForm} fitContent>
        <form onSubmit={handleCreate}>
          <div className={cn(consoleStructuredDialogPanelClass, 'min-w-[420px] max-w-xl')}>
            <ConsoleStructuredDialogHeader
              title="New Custom Image"
              subtitle="Select components and versions to build your image"
            />
            <ConsoleStructuredDialogBody>
              <div className="flex flex-col gap-4">
                <div>
                  <div className={consoleSectionLabelClass}>Image Name</div>
                  <Input
                    ref={nameRef}
                    value={imageName}
                    onChange={(e) => setImageName(e.target.value)}
                    placeholder="my-custom-stack"
                    disabled={creating}
                    className="w-full"
                  />
                </div>

                <div>
                  <div className={consoleSectionLabelClass}>Components</div>
                  <div className="border border-zinc-200 rounded-lg max-h-64 overflow-y-auto console-scroll-hidden">
                    {!catalog?.components?.length ? (
                      <p className="px-3 py-4 text-xs text-zinc-400">No components available.</p>
                    ) : (
                      (() => {
                        const CATEGORY_ORDER = ['agent', 'language', 'database', 'devops', 'package-manager', 'shell-tool'];
                        const CATEGORY_LABELS = {
                          agent: 'Agents', language: 'Languages', database: 'Databases',
                          devops: 'DevOps', 'package-manager': 'Package Managers', 'shell-tool': 'Shell Tools',
                        };
                        const grouped = {};
                        for (const comp of catalog.components) {
                          (grouped[comp.category] || (grouped[comp.category] = [])).push(comp);
                        }
                        return CATEGORY_ORDER.filter((cat) => grouped[cat]?.length > 0).map((cat) => (
                          <div key={cat}>
                            <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500 bg-zinc-50 border-b border-zinc-100">
                              {CATEGORY_LABELS[cat] || cat}
                            </div>
                            {grouped[cat].map((comp) => {
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
                                  {checked && comp.versions && comp.versions.length > 0 && (
                                    <SelectMenu
                                      value={componentVersions[comp.id] || comp.defaultVersion || ''}
                                      onChange={(v) => {
                                        setComponentVersions((prev) => ({ ...prev, [comp.id]: v }));
                                      }}
                                      options={comp.versions.map((v) => ({ value: v.version, label: v.version }))}
                                      disabled={creating}
                                      className="w-24 shrink-0"
                                    />
                                  )}
                                </label>
                              );
                            })}
                          </div>
                        ));
                      })()
                    )}
                  </div>
                  {selectedComponentIds.includes('lang:rust') && !selectedComponentIds.includes('lang:cpp') && (
                    <p className="text-xs text-amber-600 mt-1">Tip: select <b>C/C++</b> with Rust to enable <code>cargo build</code> (gcc required for native compilation).</p>
                  )}
                  {selectedComponentIds.length > 0 && (
                    <p className="text-xs text-zinc-400 mt-1">
                      {selectedComponentIds.length} component{selectedComponentIds.length > 1 ? 's' : ''} selected
                      {!agentSelected && ' — select an agent to enable build'}
                    </p>
                  )}
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
      <div className={cn(consoleAdminTableShellClass, '!overflow-auto')}>
        <table className="w-full min-w-[640px] border-collapse text-left">
          <thead>
            <tr className="border-b border-zinc-200">
              <th className={consoleTableHeadCellClass}>Name</th>
              <th className={consoleTableHeadCellClass}>Status</th>
              <th className={consoleTableHeadCellClass}>Components</th>
              <th className={consoleTableHeadCellClass}>Created</th>
              <th className={consoleTableHeadCellClass}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && images.length === 0 ? (
              <tr>
                <td colSpan={5} className={cn(consoleTableBodyCellClass, 'text-center text-zinc-400')}>
                  <Loader2 className="h-4 w-4 inline-block animate-spin" /> Loading…
                </td>
              </tr>
            ) : images.length === 0 ? (
              <tr>
                <td colSpan={5} className={cn(consoleTableBodyCellClass, 'text-center text-zinc-400')}>
                  No custom images yet. Click &ldquo;New Image&rdquo; to create one.
                </td>
              </tr>
            ) : (
              images.map((img) => (
                <tr key={img.id} className="border-b border-zinc-100 align-top">
                  <td className={cn(consoleTableBodyCellClass, 'font-medium text-zinc-900')}>
                    {img.name}
                    {img.status === 'failed' && img.latest_build?.failure_reason && (
                      <p className="mt-1 max-w-[320px] whitespace-pre-wrap break-words font-normal text-xs text-red-600">
                        {img.latest_build.failure_reason}
                      </p>
                    )}
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    {stateBadge(img.status)}
                  </td>
                  <td className={cn(consoleTableBodyCellClass, 'max-w-[320px]')}>
                    {(() => {
                      const comps = Array.isArray(img.components) ? img.components : [];
                      if (comps.length === 0) return <span className="text-zinc-400">\u2014</span>;
                      const names = comps.map((c) => {
                        const id = (c.component_id || '').replace(/^(agent:|lang:|tool:)/, '');
                        return id;
                      });
                      const max = 5;
                      if (names.length <= max) {
                        return (
                          <div className="flex flex-wrap gap-1">
                            {names.map((n, i) => (
                              <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-zinc-100 text-zinc-700">{n}</span>
                            ))}
                          </div>
                        );
                      }
                      return (
                        <div className="flex flex-wrap gap-1">
                          {names.slice(0, max).map((n, i) => (
                            <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-zinc-100 text-zinc-700">{n}</span>
                          ))}
                          <span className="text-xs text-zinc-400" title={names.slice(max).join(', ')}>
                            +{names.length - max} more
                          </span>
                        </div>
                      );
                    })()}
                  </td>
                  <td className={cn(consoleTableBodyCellClass, 'text-zinc-500')}>
                    {formatTime(img.created_at)}
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <div className="flex items-center gap-1">
                      {img.latest_build?.failure_reason && (
                        <span className="text-red-500 cursor-help" title={img.latest_build.failure_reason}>
                          <AlertTriangle className="h-4 w-4" />
                        </span>
                      )}
                      <button
                        onClick={() => setConfirmDelete(img)}
                        disabled={deletingId === img.id}
                        className="text-zinc-400 hover:text-red-600 transition-colors disabled:opacity-50"
                        title="Delete image"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
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
