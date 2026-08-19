import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
    AlertTriangle, Check, CheckCircle, Clock, Loader2, Pause, RefreshCw,
    RotateCw, ScrollText, Trash2, Upload, XCircle, Layers,
} from 'lucide-react';
import { ConsoleDialogShell } from '../components/ConsoleDialog';
import Button from '../components/Button';
import RowActionsMenu from '../components/RowActionsMenu';
import SelectMenu from '../components/SelectMenu';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { confirm } from '../components/ConfirmDialog';
import {
    consoleButtonFocusClass,
    consoleInputClass,
    textPrimary,
    textSecondary,
    textPlaceholder,
    borderHairline,
    bgCanvas,
    bgContainer,
    bgSecondary,
    bgTertiary,
    accentGreenText,
    accentRed,
    accentRedBg,
} from '../lib/consoleTokens';
import { apiFetch } from '../lib/api';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import { cn } from '../lib/utils';

const API_BASE = '/api/v1/admin/agent-images';

async function api(path, options) {
    const res = await apiFetch(`${API_BASE}${path}`, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const e = new Error(data.error || `Request failed: ${res.status}`);
        if (data.code) e.code = data.code;
        throw e;
    }
    return data;
}

function formatTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleString();
}

function formatDuration(started, finished) {
    if (!started) return '-';
    const end = finished || Date.now();
    const s = Math.floor((end - started) / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
}

function agentBadge(agent) {
    if (agent.build_state === 'building') return { tone: 'info', icon: Loader2, spinning: true, label: 'Building…' };
    if (agent.build_state === 'queued') return { tone: 'warning', icon: Clock, label: 'Queued' };
    if (agent.build_state === 'failed') return { tone: 'danger', icon: XCircle, label: 'Failed' };
    if (agent.active_version) return { tone: 'success', icon: CheckCircle, label: 'Active' };
    if (agent.default_image_ref) {
        return {
            tone: 'neutral',
            icon: null,
            label: 'Using default',
            title: 'No active version — new sessions use the default image.',
        };
    }
    return { tone: 'neutral', icon: null, label: 'Not built' };
}

function versionBadge(version) {
    return version.is_active
        ? { tone: 'success', icon: CheckCircle, label: 'Active' }
        : { tone: 'neutral', icon: null, label: 'Ready' };
}

export function ImagesAdminContent() {
    const { showToast } = useToast();
    const [catalog, setCatalog] = useState(null);
    const [selectedAgentId, setSelectedAgentId] = useState(null);
    const [builds, setBuilds] = useState([]);
    const [actionId, setActionId] = useState(null);
    const [buildDialogOpen, setBuildDialogOpen] = useState(false);
    const [buildTag, setBuildTag] = useState('');
    const [buildNotes, setBuildNotes] = useState('');
    const [building, setBuilding] = useState(false);
    const [deleteVersionTarget, setDeleteVersionTarget] = useState(null);
    const [deactivateTarget, setDeactivateTarget] = useState(null);
    const [logsDialog, setLogsDialog] = useState(null);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const tagInputRef = useRef(null);
    const [refreshing, setRefreshing] = useState(false);

    const loadBuilds = useCallback(async (agentId) => {
        if (!agentId) return;
        try {
            const data = await api(`/${agentId}/builds`);
            setBuilds(data.builds || []);
        } catch { setBuilds([]); }
    }, []);

    const loadCatalog = useCallback(async (opts = {}) => {
        if (!opts.silent) setRefreshing(true);
        try {
            const data = await api('');
            setCatalog(data);
            if (opts.reloadBuilds && selectedAgentId) {
                await loadBuilds(selectedAgentId);
            }
        } catch (err) {
            showToast('error', err.message);
        } finally {
            setRefreshing(false);
        }
    }, [showToast, selectedAgentId, loadBuilds]);

    useEffect(() => { loadCatalog(); }, [loadCatalog]);

    const pollIds = useMemo(() => {
        if (!catalog) return new Set();
        const ids = new Set();
        for (const agent of catalog.agents || []) {
            if (agent.build_state === 'building' || agent.build_state === 'queued') ids.add(agent.agent_id);
        }
        return ids;
    }, [catalog]);

    useEffect(() => {
        if (pollIds.size === 0) return;
        const timer = setInterval(() => { loadCatalog({ reloadBuilds: true }); }, 5000);
        return () => clearInterval(timer);
    }, [pollIds.size, loadCatalog]);

    useEffect(() => {
        if (selectedAgentId) loadBuilds(selectedAgentId);
        else setBuilds([]);
    }, [selectedAgentId, loadBuilds]);

    useEffect(() => {
        if (selectedAgentId && !pollIds.has(selectedAgentId)) {
            loadBuilds(selectedAgentId);
        }
    }, [pollIds, selectedAgentId, loadBuilds]);

    const selectedAgent = useMemo(
        () => (catalog?.agents || []).find((a) => a.agent_id === selectedAgentId),
        [catalog, selectedAgentId],
    );

    const isBuilding = selectedAgent?.build_state === 'building';
    const isQueued = selectedAgent?.build_state === 'queued';
    const isFailed = selectedAgent?.build_state === 'failed';
    const inProgress = isBuilding || isQueued;

    useEffect(() => {
        if (!inProgress) return;
        const timer = setInterval(() => setNowMs(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [inProgress]);

    useEffect(() => {
        if (buildDialogOpen) {
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            setBuildTag(`${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`);
            setBuildNotes('');
            setTimeout(() => tagInputRef.current?.focus(), 50);
        }
    }, [buildDialogOpen]);

    const agentOptions = useMemo(
        () => (catalog?.agents || []).map((a) => ({ value: a.agent_id, label: a.agent_name })),
        [catalog],
    );

    const latestBuild = builds[0] || null;
    const hasNoVersions = !selectedAgent?.versions?.length && !selectedAgent?.default_image_ref;
    const agentImageRef = selectedAgent?.active_version?.image_ref || selectedAgent?.default_image_ref || null;

    const handleBuild = async () => {
        if (!selectedAgentId || !buildTag.trim()) return;
        setBuilding(true);
        try {
            await api(`/${selectedAgentId}/build`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag: buildTag.trim(), notes: buildNotes.trim() || undefined }),
            });
            showToast('success', 'Build started.');
            setBuildDialogOpen(false);
            await loadCatalog();
            await loadBuilds(selectedAgentId);
        } catch (err) {
            showToast('error', err.message);
        } finally {
            setBuilding(false);
        }
    };

    const handleActivate = async (versionId) => {
        setActionId(`activate:${versionId}`);
        try {
            await api(`/versions/${versionId}/activate`, { method: 'POST' });
            showToast('success', 'Version activated.');
            await loadCatalog();
        } catch (err) {
            showToast('error', err.message);
        } finally {
            setActionId(null);
        }
    };

    const handleDeactivate = async (versionId) => {
        setActionId(`deprecate:${versionId}`);
        try {
            await api(`/versions/${versionId}/deprecate`, { method: 'POST' });
            showToast('success', 'Version deactivated.');
            await loadCatalog();
        } catch (err) {
            showToast('error', err.message);
        } finally {
            setActionId(null);
        }
    };

    const handleDeleteVersion = async () => {
        if (!deleteVersionTarget) return;
        const vid = deleteVersionTarget.id;
        setActionId(`delete:${vid}`);
        setDeleteVersionTarget(null);
        try {
            await api(`/versions/${vid}`, { method: 'DELETE' });
            showToast('success', 'Version deleted.');
            await loadCatalog();
        } catch (err) {
            showToast('error', err.message);
        } finally {
            setActionId(null);
        }
    };

    const handleRetry = async (buildId) => {
        if (!await confirm({ title: 'Retry Build', message: 'Retry this build?', confirmLabel: 'Retry' })) return;
        try {
            await api(`/builds/${buildId}/retry`, { method: 'POST' });
            showToast('success', 'Build retried.');
            await loadCatalog();
            if (selectedAgentId) await loadBuilds(selectedAgentId);
        } catch (err) {
            showToast('error', err.message);
        }
    };

    const handleViewLogs = async (buildId) => {
        setLogsDialog({ buildId, content: '', loading: true });
        try {
            const data = await api(`/builds/${buildId}/logs`);
            setLogsDialog({ buildId, content: data.content || '(no logs)', loading: false });
        } catch (err) {
            setLogsDialog({ buildId, content: `Error: ${err.message}`, loading: false });
        }
    };

    return (
        <div className={cn('flex flex-col h-full min-h-0', bgContainer)}>
            {/* Toolbar */}
            <div className={cn('flex items-center justify-between gap-6 px-1 shrink-0 mb-4')}>
                <div className="flex items-center gap-2 min-w-0">
                    <span className={cn('text-xs shrink-0', textSecondary)}>Agent</span>
                    <SelectMenu
                        value={selectedAgentId || ''}
                        onChange={setSelectedAgentId}
                        options={agentOptions}
                        placeholder="Select an agent…"
                        className="w-56"
                    />
                    {selectedAgent && <StatusBadge {...agentBadge(selectedAgent)} />}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <button
                        type="button"
                        onClick={() => loadCatalog({ reloadBuilds: true })}
                        disabled={refreshing}
                        className={cn('p-1.5 rounded-md text-zinc-500 hover:bg-zinc-200 transition-colors shrink-0', consoleButtonFocusClass)}
                        title="Refresh"
                    >
                        {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    </button>
                    <Button
                        onClick={() => setBuildDialogOpen(true)}
                        disabled={!selectedAgentId || !selectedAgent?.buildable || inProgress}
                        size="md"
                    >
                        <Upload className="h-4 w-4" />
                        Build new image
                    </Button>
                </div>
            </div>

            {!selectedAgent ? (
                <div className="flex flex-col items-center justify-center flex-1 min-h-0">
                    <div className={cn('flex items-center justify-center w-12 h-12 rounded-xl mb-4', bgSecondary)}>
                        <Layers className={cn('h-6 w-6', textPlaceholder)} />
                    </div>
                    <p className={cn('text-sm', textPlaceholder)}>Select an agent to manage its images</p>
                </div>
            ) : (
                <div className={cn('flex-1 min-h-0 overflow-y-auto p-0 space-y-4')}>
                    {/* Header card */}
                    <div className={cn('rounded-lg border px-5 py-4', borderHairline, bgCanvas)}>
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <h3 className={cn('text-base font-bold', textPrimary)}>{selectedAgent.agent_name}</h3>
                                    <StatusBadge {...agentBadge(selectedAgent)} />
                                </div>
                                {agentImageRef ? (
                                    <p className={cn('mt-1 text-xs font-mono truncate', textPlaceholder)} title={agentImageRef}>
                                        {agentImageRef}
                                    </p>
                                ) : (
                                    <p className={cn('mt-1 text-xs', textPlaceholder)}>
                                        No version yet — build an image to install this agent in sandboxes.
                                    </p>
                                )}
                            </div>
                        </div>
                        {selectedAgent.active_version ? (
                            <p className={cn('mt-3 pt-3 border-t text-xs flex items-center gap-1.5', borderHairline, textSecondary)}>
                                <CheckCircle className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                                Active version is used for new agent sessions. Build a new version, then activate it to switch.
                            </p>
                        ) : null}
                    </div>

                    {/* Build status strip */}
                    {inProgress ? (
                        <div className={cn('flex items-center gap-3 px-4 py-3 rounded-lg', bgTertiary)}>
                            <Loader2 className="h-4 w-4 animate-spin text-black shrink-0" />
                            <div className="min-w-0 flex-1">
                                <div className={cn('text-xs font-medium', textPrimary)}>
                                    {isBuilding ? 'Building image…' : 'Queued for build…'}
                                </div>
                                {isBuilding && latestBuild?.started_at && (
                                    <div className={cn('text-xs mt-0.5 tabular-nums', textPlaceholder)}>
                                        {formatDuration(latestBuild.started_at, nowMs)}
                                    </div>
                                )}
                            </div>
                            {latestBuild && (
                                <button
                                    type="button"
                                    onClick={() => handleViewLogs(latestBuild.id)}
                                    className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200 bg-white border border-zinc-200', consoleButtonFocusClass)}
                                >
                                    <ScrollText className="h-3.5 w-3.5" />
                                    View logs
                                </button>
                            )}
                        </div>
                    ) : isFailed ? (
                        <div className={cn('rounded-lg border overflow-hidden', accentRedBg, 'border-red-100')}>
                            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-red-100">
                                <div className="flex items-center gap-2 text-sm font-medium text-red-700">
                                    <AlertTriangle className="h-4 w-4 shrink-0" />
                                    Build failed
                                    {latestBuild && (
                                        <span className={cn('text-xs font-normal', accentRed)}>
                                            · {formatTime(latestBuild.started_at)} · {formatDuration(latestBuild.started_at, latestBuild.finished_at)}
                                        </span>
                                    )}
                                </div>
                                <div className="flex items-center gap-1">
                                    {latestBuild && (
                                        <>
                                            <button
                                                type="button"
                                                onClick={() => handleViewLogs(latestBuild.id)}
                                                className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200 bg-white border border-zinc-200', consoleButtonFocusClass)}
                                            >
                                                <ScrollText className="h-3.5 w-3.5" />
                                                View logs
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleRetry(latestBuild.id)}
                                                className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium bg-white border border-emerald-200', accentGreenText, 'hover:bg-emerald-50', consoleButtonFocusClass)}
                                            >
                                                <RotateCw className="h-3.5 w-3.5" />
                                                Retry
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>
                            {latestBuild?.failure_reason && (
                                <pre className={cn('mx-4 mb-3 mt-2 rounded p-2 text-xs font-mono overflow-auto whitespace-pre-wrap max-h-20', accentRed, bgTertiary)}>
                                    {latestBuild.failure_reason}
                                </pre>
                            )}
                        </div>
                    ) : latestBuild?.state === 'ready' ? (
                        <div className={cn('flex items-center gap-3 px-4 py-3 rounded-lg', bgTertiary)}>
                            <CheckCircle className={cn('h-4 w-4 shrink-0', accentGreenText)} />
                            <span className={cn('text-xs font-medium', textPrimary)}>Up to date</span>
                            <span className={cn('text-xs', textPlaceholder)}>
                                · last build succeeded · {formatDuration(latestBuild.started_at, latestBuild.finished_at)}
                            </span>
                            <button
                                type="button"
                                onClick={() => handleViewLogs(latestBuild.id)}
                                className={cn('ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200 bg-white border border-zinc-200', consoleButtonFocusClass)}
                            >
                                <ScrollText className="h-3.5 w-3.5" />
                                View logs
                            </button>
                        </div>
                    ) : null}

                    {/* Versions table */}
                    <div className={cn('rounded-lg border overflow-hidden', borderHairline, bgCanvas)}>
                        <div className={cn('flex items-center justify-between px-4 py-2.5 border-b', borderHairline, bgTertiary)}>
                            <span className={cn('text-xs font-semibold uppercase tracking-wider', textSecondary)}>
                                Versions
                            </span>
                            <span className={cn('text-xs', textPlaceholder)}>
                                {selectedAgent.versions?.length || 0} total
                            </span>
                        </div>
                        {hasNoVersions ? (
                            <div className="flex flex-col items-center justify-center py-12 px-6">
                                <div className={cn('flex items-center justify-center w-12 h-12 rounded-xl mb-4', bgSecondary)}>
                                    <Layers className={cn('h-6 w-6', textPlaceholder)} />
                                </div>
                                <p className={cn('text-sm font-medium', textPrimary)}>No version yet</p>
                                <p className={cn('text-xs mt-1 mb-5 text-center max-w-xs', textPlaceholder)}>
                                    Build an image for {selectedAgent.agent_name} to install it in sandboxes. Successful builds appear here as versions.
                                </p>
                                <Button
                                    onClick={() => setBuildDialogOpen(true)}
                                    disabled={!selectedAgent.buildable || inProgress}
                                    size="sm"
                                >
                                    <Upload className="h-3.5 w-3.5" />
                                    Build image
                                </Button>
                            </div>
                        ) : (
                            <table className="w-full table-fixed text-left">
                                <colgroup>
                                    <col className="w-auto" />
                                    <col className="w-36" />
                                    <col className="w-40" />
                                    <col className="w-20" />
                                </colgroup>
                                <thead>
                                    <tr className={cn('border-b', borderHairline)}>
                                        <th className={cn('px-4 py-2 text-xs font-semibold uppercase tracking-wider', textSecondary)}>Tag</th>
                                        <th className={cn('px-4 py-2 text-xs font-semibold uppercase tracking-wider', textSecondary)}>Status</th>
                                        <th className={cn('px-4 py-2 text-xs font-semibold uppercase tracking-wider', textSecondary)}>Built</th>
                                        <th className={cn('px-4 py-2 text-xs font-semibold uppercase tracking-wider', textSecondary)}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {selectedAgent.versions?.map((version) => {
                                        const badge = versionBadge(version);
                                        return (
                                            <tr key={version.id} className={cn('border-b last:border-b-0 transition-colors hover:bg-zinc-50/50', borderHairline)}>
                                                <td className="px-4 py-2.5">
                                                    <span className={cn('font-mono text-xs truncate block', textPrimary)} title={version.tag}>{version.tag}</span>
                                                </td>
                                                <td className="px-4 py-2.5">
                                                    <StatusBadge tone={badge.tone} icon={badge.icon} label={badge.label} />
                                                </td>
                                                 <td className={cn('px-4 py-2.5 text-xs', textPlaceholder)}>
                                                    <span title={formatTime(version.built_at || version.created_at)}>
                                                        {formatRelativeTime(version.built_at || version.created_at) || '-'}
                                                    </span>
                                                 </td>
                                                 <td className="px-4 py-2.5">
                                                    <RowActionsMenu
                                                        label={`Actions for ${version.tag}`}
                                                        items={[
                                                            !version.is_active && {
                                                                icon: Check,
                                                                label: 'Activate',
                                                                onClick: () => handleActivate(version.id),
                                                                busy: actionId === `activate:${version.id}`,
                                                            },
                                                            version.is_active && {
                                                                icon: Pause,
                                                                label: 'Deactivate',
                                                                onClick: () => setDeactivateTarget(version),
                                                                busy: actionId === `deprecate:${version.id}`,
                                                            },
                                                            !version.is_active && {
                                                                icon: Trash2,
                                                                label: 'Delete version',
                                                                danger: true,
                                                                onClick: () => setDeleteVersionTarget(version),
                                                                busy: actionId === `delete:${version.id}`,
                                                                busyLabel: 'Deleting…',
                                                            },
                                                        ].filter(Boolean)}
                                                    />
                                                 </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            )}

            {/* Build dialog */}
            {buildDialogOpen && (
                <ConsoleDialogShell onClose={() => setBuildDialogOpen(false)} panelClassName="w-96">
                    <div className="px-5 pt-5 pb-2">
                        <h3 className={cn('text-sm font-semibold', textPrimary)}>Build new image</h3>
                        <p className={cn('text-xs mt-1', textPlaceholder)}>
                            Build {selectedAgent?.agent_name} from the latest definition.
                        </p>
                    </div>
                    <div className="px-5 pb-5 space-y-3">
                        <label className="block">
                            <span className={cn('text-xs font-semibold uppercase tracking-wider', textPlaceholder)}>Version tag</span>
                            <input
                                ref={tagInputRef}
                                type="text"
                                value={buildTag}
                                onChange={(e) => setBuildTag(e.target.value)}
                                className={cn('mt-1 w-full', consoleInputClass, 'text-xs')}
                            />
                        </label>
                        <label className="block">
                            <span className={cn('text-xs font-semibold uppercase tracking-wider', textPlaceholder)}>Notes (optional)</span>
                            <input
                                type="text"
                                value={buildNotes}
                                onChange={(e) => setBuildNotes(e.target.value)}
                                className={cn('mt-1 w-full', consoleInputClass, 'text-xs')}
                            />
                        </label>
                    </div>
                    <div className={cn('flex justify-end gap-2 px-5 py-3 border-t', borderHairline)}>
                        <Button type="button" variant="secondary" size="sm" onClick={() => setBuildDialogOpen(false)} disabled={building}>Cancel</Button>
                        <Button type="button" size="sm" onClick={handleBuild} disabled={!buildTag.trim() || building}>
                            {building ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />Building…</> : 'Build'}
                        </Button>
                    </div>
                </ConsoleDialogShell>
            )}

            {/* Delete version dialog */}
            {deleteVersionTarget && (
                <ConsoleDialogShell onClose={() => setDeleteVersionTarget(null)} panelClassName="w-96">
                    <div className="px-5 pt-5 pb-2">
                        <h3 className={cn('text-sm font-semibold', textPrimary)}>Delete version</h3>
                    </div>
                    <div className="px-5 pb-4">
                        <p className={cn('text-xs', textSecondary)}>
                            Delete <span className={cn('font-mono font-medium', textPrimary)}>{deleteVersionTarget.tag}</span>?
                        </p>
                        <p className={cn('text-xs mt-1', textPlaceholder)}>
                            This removes the version and its image from the registry. This cannot be undone.
                        </p>
                    </div>
                    <div className={cn('flex justify-end gap-2 px-5 py-3 border-t', borderHairline)}>
                        <Button type="button" variant="secondary" size="sm" onClick={() => setDeleteVersionTarget(null)}>Cancel</Button>
                        <Button type="button" size="sm" onClick={handleDeleteVersion} className="bg-red-600 hover:bg-red-700 text-white">Delete</Button>
                    </div>
                </ConsoleDialogShell>
            )}

            {/* Deactivate version dialog */}
            {deactivateTarget && (
                <ConsoleDialogShell onClose={() => setDeactivateTarget(null)} panelClassName="w-96">
                    <div className="px-5 pt-5 pb-2">
                        <h3 className={cn('text-sm font-semibold', textPrimary)}>Deactivate version</h3>
                    </div>
                    <div className="px-5 pb-4">
                        <p className={cn('text-xs', textSecondary)}>
                            Deactivate <span className={cn('font-mono font-medium', textPrimary)}>{deactivateTarget.tag}</span>?
                        </p>
                        <p className={cn('text-xs mt-1', textPlaceholder)}>
                            The agent will fall back to the default image. You can re-activate this version anytime.
                        </p>
                    </div>
                    <div className={cn('flex justify-end gap-2 px-5 py-3 border-t', borderHairline)}>
                        <Button type="button" variant="secondary" size="sm" onClick={() => setDeactivateTarget(null)}>Cancel</Button>
                        <Button type="button" size="sm" onClick={() => { const t = deactivateTarget; setDeactivateTarget(null); handleDeactivate(t.id); }}>Deactivate</Button>
                    </div>
                </ConsoleDialogShell>
            )}

            {/* Build logs dialog */}
            {logsDialog && (
                <ConsoleDialogShell onClose={() => setLogsDialog(null)} panelClassName="w-[640px]">
                    <div className={cn('flex items-center justify-between px-4 py-3 border-b shrink-0', borderHairline, bgCanvas)}>
                        <div className="flex items-center gap-2 min-w-0">
                            <ScrollText className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                            <span className={cn('text-sm font-semibold', textPrimary)}>Build logs</span>
                            <span className={cn('text-xs font-mono truncate', textPlaceholder)}>{logsDialog.buildId}</span>
                        </div>
                        <button
                            type="button"
                            onClick={() => setLogsDialog(null)}
                            className={cn('text-xs text-zinc-400 hover:text-zinc-700 transition-colors shrink-0', consoleButtonFocusClass)}
                        >
                            Close
                        </button>
                    </div>
                    <div className="max-h-[70vh] overflow-auto">
                        <pre className="p-4 text-xs font-mono text-zinc-100 bg-zinc-950 whitespace-pre-wrap leading-relaxed">
                            {logsDialog.loading ? 'Loading…' : logsDialog.content}
                        </pre>
                    </div>
                </ConsoleDialogShell>
            )}
        </div>
    );
}

export default function ImagesAdmin() {
    return <ImagesAdminContent />;
}
