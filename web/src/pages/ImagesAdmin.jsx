import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
    Check, ChevronRight, Loader2, RefreshCw,
    Trash2, Upload, XCircle, Terminal as TerminalIcon,
} from 'lucide-react';
import { ConsoleDialogShell } from '../components/ConsoleDialog';
import Input from '../components/Input';
import Button from '../components/Button';
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
    bgActive,
    bgInverse,
    accentGreen,
    accentGreenBg,
    accentGreenText,
    accentRed,
    accentRedBg,
    accentBlue,
} from '../lib/consoleTokens';
import { apiFetch } from '../lib/api';
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
    return d.toLocaleDateString();
}

function formatDuration(started, finished) {
    if (!started) return '-';
    const end = finished || Date.now();
    const s = Math.floor((end - started) / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const STATUS_DOT = {
    active: 'bg-emerald-600',
    ready: 'bg-black',
    deprecated: 'bg-zinc-300',
    building: 'bg-black animate-pulse',
    queued: 'bg-zinc-400',
    failed: 'bg-red-600',
    none: bgActive,
};

function WorkflowStrip({ hasVersions, hasActive }) {
    const steps = [
        { label: 'Build', desc: 'Build an image', done: hasVersions },
        { label: 'Register', desc: 'Auto on build success', done: hasVersions },
        { label: 'Activate', desc: 'Pick a version to use', done: hasActive },
    ];
    return (
        <div className={cn('flex items-center gap-2 px-4 py-2 border-b shrink-0', borderHairline, bgTertiary)}>
            {steps.map((s, i) => (
                <div key={s.label} className="flex items-center gap-2 flex-1 last:flex-none">
                    <div className={cn(
                        'w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-colors',
                        s.done ? 'bg-emerald-600 text-white' : cn(bgActive, textPlaceholder),
                    )}>
                        {s.done ? <Check className="h-3 w-3" /> : i + 1}
                    </div>
                    <div className="min-w-0">
                        <div className={cn('text-xs font-semibold', s.done ? textPrimary : textSecondary)}>{s.label}</div>
                        <div className={cn('text-xs', textPlaceholder)}>{s.desc}</div>
                    </div>
                    {i < steps.length - 1 && (
                        <div className={cn('flex-1 border-t-2 border-dashed mx-1', s.done ? 'border-emerald-600' : 'border-zinc-300')} />
                    )}
                </div>
            ))}
        </div>
    );
}

function AgentListItem({ agent, selected, onClick }) {
    const activeVersion = agent.active_version;
    const hasDefault = Boolean(agent.default_image_ref);
    const isBuilding = agent.build_state === 'building';
    const isQueued = agent.build_state === 'queued';
    const isFailed = agent.build_state === 'failed';
    const dotClass = isBuilding ? STATUS_DOT.building
        : isQueued ? STATUS_DOT.queued
        : isFailed ? STATUS_DOT.failed
        : (activeVersion || hasDefault) ? STATUS_DOT.active
        : STATUS_DOT.none;
    const statusText = isBuilding ? 'Building'
        : isQueued ? 'Queued'
        : isFailed ? 'Failed'
        : activeVersion ? activeVersion.tag
        : hasDefault ? 'default'
        : 'Not built';

    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'w-full text-left px-3 py-2.5 transition-colors border-l-2',
                selected ? cn(bgSecondary, 'border-black') : cn('border-transparent hover:bg-zinc-100'),
                consoleButtonFocusClass,
            )}
        >
            <div className="flex items-center gap-2">
                <div className={cn('w-2 h-2 rounded-full shrink-0', dotClass)} />
                <span className={cn('text-xs font-medium truncate', textPrimary)}>{agent.agent_name}</span>
                {isBuilding && <Loader2 className="h-3 w-3 animate-spin text-black shrink-0" />}
            </div>
            <div className={cn(
                'text-xs mt-0.5 ml-4 truncate',
                isFailed ? accentRed : textPlaceholder,
                !activeVersion && !isBuilding && !isQueued && !isFailed && 'italic',
            )}>
                {statusText}
            </div>
        </button>
    );
}

function VersionRow({ version, actionId, onActivate, onDeactivate, onDelete }) {
    const isBusy = actionId === `activate:${version.id}` || actionId === `deprecate:${version.id}` || actionId === `delete:${version.id}`;
    return (
        <div className={cn('flex items-center gap-3 px-4 py-2.5 transition-colors border-b last:border-b-0', borderHairline, 'hover:bg-zinc-100')}>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className={cn('font-mono text-xs truncate', textPrimary)}>{version.tag}</span>
                    {version.is_active ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-600 shrink-0">
                            <Check className="h-2.5 w-2.5 mr-0.5" />Active
                        </span>
                    ) : (
                        <span className={cn('inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium shrink-0', bgActive, textSecondary)}>Ready</span>
                    )}
                </div>
                <div className={cn('text-xs mt-0.5', textPlaceholder)}>
                    {formatTime(version.built_at || version.created_at)}
                </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
                {isBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />
                ) : (
                    <>
                        {!version.is_active && (
                            <button type="button" onClick={() => onActivate(version.id)} title="Activate" className={cn('group/btn inline-flex items-center gap-1 p-1 rounded text-emerald-600 hover:bg-emerald-50', consoleButtonFocusClass)}>
                                <Check className="h-3.5 w-3.5" />
                                <span className="text-xs hidden group-hover/btn:inline">Activate</span>
                            </button>
                        )}
                        {version.is_active && (
                            <button type="button" onClick={() => onDeactivate(version)} title="Deactivate" className={cn('group/btn inline-flex items-center gap-1 p-1 rounded text-zinc-400 hover:bg-zinc-200', consoleButtonFocusClass)}>
                                <XCircle className="h-3.5 w-3.5" />
                                <span className="text-xs hidden group-hover/btn:inline">Deactivate</span>
                            </button>
                        )}
                        {!version.is_active && (
                            <button type="button" onClick={() => onDelete(version)} title="Delete" className={cn('group/btn inline-flex items-center gap-1 p-1 rounded text-red-600 hover:bg-red-50', consoleButtonFocusClass)}>
                                <Trash2 className="h-3 w-3" />
                                <span className="text-xs hidden group-hover/btn:inline">Delete</span>
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

function BuildStatusCard({ agent, latestBuild, isBuilding, isQueued, isFailed, onBuild, onRetry, onViewLogs, onDiscard, logsBuildId, actionId }) {
    if (isBuilding || isQueued) {
        return (
            <div className={cn('flex items-center gap-3 px-4 py-3 rounded-lg', bgTertiary)}>
                <Loader2 className="h-4 w-4 animate-spin text-black shrink-0" />
                <div className="min-w-0">
                    <div className={cn('text-xs font-medium', textPrimary)}>{isBuilding ? 'Building image…' : 'Queued for build…'}</div>
                    {latestBuild && (
                        <div className={cn('text-xs mt-0.5', textPlaceholder)}>
                            Started {formatTime(latestBuild.started_at)} · {formatDuration(latestBuild.started_at, latestBuild.finished_at)}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    if (isFailed) {
        return (
            <div className={cn('rounded-lg border', accentRedBg, 'border-red-100')}>
                <div className="flex items-center gap-2 px-4 py-2.5">
                    <XCircle className={cn('h-4 w-4 shrink-0', accentRed)} />
                    <span className={cn('text-xs font-medium', accentRed)}>Build failed</span>
                </div>
                {latestBuild?.failure_reason && (
                    <pre className={cn('mx-4 mb-2 rounded p-2 text-xs font-mono overflow-auto whitespace-pre-wrap max-h-20', accentRed, bgTertiary)}>
                        {latestBuild.failure_reason}
                    </pre>
                )}
                <div className="flex items-center gap-3 px-4 py-2 border-t border-red-100">
                    {latestBuild && (
                        <button type="button" onClick={() => onViewLogs(latestBuild.id)} className={cn('text-xs text-black hover:underline', consoleButtonFocusClass)}>
                            {logsBuildId === latestBuild.id ? 'Hide logs' : 'View logs'}
                        </button>
                    )}
                    {latestBuild && (
                        <button type="button" onClick={() => onRetry(latestBuild.id)} className={cn('text-xs', accentGreenText, 'hover:underline', consoleButtonFocusClass)}>
                            Retry
                        </button>
                    )}
                    {latestBuild && (
                        <button type="button" onClick={() => onDiscard(latestBuild.id)} className={cn('text-xs', accentRed, 'hover:underline', consoleButtonFocusClass)}>
                            Discard
                        </button>
                    )}
                </div>
            </div>
        );
    }

    return (
        <button
            type="button"
            onClick={onBuild}
            className={cn(
                'flex items-center gap-2 px-4 py-2.5 text-xs font-medium rounded-lg text-white',
                `${bgInverse} hover:bg-zinc-700 transition-colors`,
                consoleButtonFocusClass,
            )}
        >
            <Upload className="h-3.5 w-3.5" />
            Build new image
        </button>
    );
}

function EmptyState({ onBuild }) {
    return (
        <div className="flex flex-col items-center justify-center py-16">
            <div className={cn('flex items-center justify-center w-12 h-12 rounded-xl mb-4', bgSecondary)}>
                <TerminalIcon className={cn('h-6 w-6', textPlaceholder)} />
            </div>
            <p className={cn('text-sm font-medium', textPrimary)}>No image configured</p>
            <p className={cn('text-xs mt-1 mb-4', textPlaceholder)}>Build a custom image to install this agent in sandboxes.</p>
            <button
                type="button"
                onClick={onBuild}
                className={cn(
                    'flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg text-white',
                    `${bgInverse} hover:bg-zinc-700 transition-colors`,
                    consoleButtonFocusClass,
                )}
            >
                <Upload className="h-3.5 w-3.5" />
                Build image
            </button>
        </div>
    );
}

export function ImagesAdminContent() {
    const { showToast } = useToast();
    const [loading, setLoading] = useState(true);
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
    const [logsBuildId, setLogsBuildId] = useState(null);
    const [logsContent, setLogsContent] = useState('');
    const [logsLoading, setLogsLoading] = useState(false);
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
            setLoading(false);
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

    // Refresh builds when the selected agent's build_state transitions
    // (e.g., building -> ready/failed). Without this, the builds list keeps
    // the stale 'building' state after polling stops.
    useEffect(() => {
        if (selectedAgentId && !pollIds.has(selectedAgentId)) {
            loadBuilds(selectedAgentId);
        }
    }, [pollIds, selectedAgentId, loadBuilds]);

    useEffect(() => {
        if (buildDialogOpen) {
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            setBuildTag(`${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`);
            setBuildNotes('');
            setTimeout(() => tagInputRef.current?.focus(), 50);
        }
    }, [buildDialogOpen]);

    const selectedAgent = useMemo(
        () => (catalog?.agents || []).find((a) => a.agent_id === selectedAgentId),
        [catalog, selectedAgentId],
    );

    const latestBuild = builds[0] || null;
    const isBuilding = selectedAgent?.build_state === 'building';
    const isQueued = selectedAgent?.build_state === 'queued';
    const isFailed = selectedAgent?.build_state === 'failed';

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

    const handleDiscardBuild = async (buildId) => {
        if (!await confirm({ title: 'Discard Build Record', message: 'Discard this build record? Logs will be permanently deleted.', confirmLabel: 'Discard', variant: 'danger' })) return;
        try {
            await api(`/builds/${buildId}`, { method: 'DELETE' });
            showToast('success', 'Build discarded.');
            if (selectedAgentId) await loadBuilds(selectedAgentId);
        } catch (err) {
            showToast('error', err.message);
        }
    };

    const handleViewLogs = async (buildId) => {
        if (logsBuildId === buildId) { setLogsBuildId(null); return; }
        setLogsBuildId(buildId);
        setLogsLoading(true);
        try {
            const data = await api(`/builds/${buildId}/logs`);
            setLogsContent(data.content || '(no logs)');
        } catch (err) {
            setLogsContent(`Error: ${err.message}`);
        } finally {
            setLogsLoading(false);
        }
    };

    const buildableAgents = (catalog?.agents || []).filter((a) => a.buildable);
    const hasNoVersions = !selectedAgent?.versions?.length && !selectedAgent?.default_image_ref;

    return (
        <div className={cn('flex flex-col h-full min-h-0', bgContainer)}>
            {/* Header bar */}
            <div className={cn('flex items-center justify-between border-b px-4 py-3 shrink-0', borderHairline, bgCanvas)}>
                <div className="flex items-center gap-2">
                    <h2 className={cn('text-sm font-bold', textPrimary)}>Agent Images</h2>
                    <span className={cn('text-xs', textPlaceholder)}>
                        {buildableAgents.length} buildable
                    </span>
                </div>
                <div className="flex items-center gap-3">
                    <p className={cn('text-xs hidden sm:block max-w-md', textPlaceholder)}>
                        Rebuild agent sandbox images to update the runtime environment (CLI upgrades, new dependencies). Activate a version after build to use it for new agent sessions.
                    </p>
                    <button
                        type="button"
                        onClick={() => loadCatalog({ reloadBuilds: true })}
                        disabled={refreshing}
                        className={cn('p-1.5 rounded-md text-zinc-500 hover:bg-zinc-200 transition-colors shrink-0', consoleButtonFocusClass)}
                    >
                        {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />}
                    </button>
                </div>
            </div>

            <WorkflowStrip
                hasVersions={Boolean(selectedAgent?.versions?.length || selectedAgent?.default_image_ref)}
                hasActive={Boolean(selectedAgent?.active_version)}
            />

            <div className="flex flex-1 min-h-0">
                {/* Agent list sidebar */}
                <div className={cn('w-56 shrink-0 border-r overflow-y-auto p-1.5', borderHairline, bgCanvas)}>
                    {buildableAgents.map((agent) => (
                        <AgentListItem
                            key={agent.agent_id}
                            agent={agent}
                            selected={selectedAgentId === agent.agent_id}
                            onClick={() => setSelectedAgentId(agent.agent_id)}
                        />
                    ))}
                    {loading && (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                        </div>
                    )}
                    {!loading && buildableAgents.length === 0 && (
                        <div className={cn('px-3 py-8 text-center text-xs', textPlaceholder)}>
                            No buildable agents
                        </div>
                    )}
                </div>

                {/* Detail panel */}
                <div className={cn('flex-1 min-h-0 overflow-y-auto p-5 space-y-4', bgContainer)}>
                    {!selectedAgent ? (
                        <div className="flex flex-col items-center justify-center h-full">
                            <div className={cn('flex items-center justify-center w-12 h-12 rounded-xl mb-4', bgSecondary)}>
                                <TerminalIcon className={cn('h-6 w-6', textPlaceholder)} />
                            </div>
                            <p className={cn('text-sm', textPlaceholder)}>
                                Select an agent to manage its images
                            </p>
                        </div>
                    ) : (
                        <>
                            {/* Agent header card */}
                            <div className={cn('rounded-lg border px-5 py-4', borderHairline, bgCanvas)}>
                                <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0">
                                        <h3 className={cn('text-sm font-bold', textPrimary)}>{selectedAgent.agent_name}</h3>
                                        {selectedAgent.active_version ? (
                                            <div className="mt-2 flex items-center gap-2">
                                                <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-600">
                                                    <Check className="h-2.5 w-2.5 mr-0.5" />Active
                                                </span>
                                                <span className={cn('text-xs font-mono truncate', textPrimary)}>
                                                    {selectedAgent.active_version.image_ref}
                                                </span>
                                            </div>
                                        ) : selectedAgent.default_image_ref ? (
                                            <div className="mt-2 flex items-center gap-2">
                                                <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', bgActive, textSecondary)}>
                                                    Default
                                                </span>
                                                <span className={cn('text-xs font-mono truncate', textSecondary)}>
                                                    {selectedAgent.default_image_ref}
                                                </span>
                                            </div>
                                        ) : null}
                                        {!selectedAgent.active_version && selectedAgent.default_image_ref && (
                                            <p className={cn('text-xs mt-2', textPlaceholder)}>
                                                No active version. The default image will be used for new agent sessions.
                                            </p>
                                        )}
                                    </div>
                                    {selectedAgent.active_version && (
                                        <button
                                            type="button"
                                            onClick={() => setDeactivateTarget(selectedAgent.active_version)}
                                            disabled={actionId === `deprecate:${selectedAgent.active_version.id}`}
                                            className={cn('text-xs text-zinc-400 hover:text-zinc-500 shrink-0', consoleButtonFocusClass)}
                                        >
                                            {actionId === `deprecate:${selectedAgent.active_version.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Deactivate'}
                                        </button>
                                    )}
                                </div>

                                {/* Build status / action */}
                                <div className={cn('mt-4 pt-4 border-t', borderHairline)}>
                                    <BuildStatusCard
                                        agent={selectedAgent}
                                        latestBuild={latestBuild}
                                        isBuilding={isBuilding}
                                        isQueued={isQueued}
                                        isFailed={isFailed}
                                        onBuild={() => setBuildDialogOpen(true)}
                                        onRetry={handleRetry}
                                        onViewLogs={handleViewLogs}
                                        onDiscard={handleDiscardBuild}
                                        logsBuildId={logsBuildId}
                                        actionId={actionId}
                                    />
                                </div>
                            </div>

                            {/* Versions list */}
                            <div className={cn('rounded-lg border overflow-hidden', borderHairline, bgCanvas)}>
                                <div className={cn('flex items-center justify-between px-4 py-3 border-b', borderHairline)}>
                                    <span className={cn('text-xs font-semibold', textSecondary)}>
                                        Versions
                                    </span>
                                    <span className={cn('text-xs', textPlaceholder)}>
                                        {selectedAgent.versions?.length || 0} total
                                    </span>
                                </div>
                                {hasNoVersions ? (
                                    <EmptyState onBuild={() => setBuildDialogOpen(true)} />
                                ) : (
                                    <>
                                        {!selectedAgent.active_version && selectedAgent.default_image_ref && (
                                            <div className={cn('px-4 py-2 border-b text-xs', borderHairline, bgTertiary, textSecondary)}>
                                                Using default image. Activate a version to override.
                                            </div>
                                        )}
                                        {selectedAgent.versions?.map((v) => (
                                            <VersionRow
                                                key={v.id}
                                                version={v}
                                                actionId={actionId}
                                                onActivate={handleActivate}
                                                onDeactivate={(version) => setDeactivateTarget(version)}
                                                onDelete={(version) => setDeleteVersionTarget(version)}
                                            />
                                        ))}
                                    </>
                                )}
                            </div>

                            {/* Build logs */}
                            {logsBuildId && (
                                <div className="rounded-lg bg-[#0D1117] border border-[#0D1117] overflow-hidden">
                                    <div className={cn('flex items-center justify-between px-4 py-2.5 border-b border-[#21262d]')}>
                                        <div className="flex items-center gap-2">
                                            <TerminalIcon className="h-3.5 w-3.5 text-zinc-400" />
                                            <span className="text-xs font-medium text-[#C9D1D9]">
                                                Build logs
                                            </span>
                                            <span className="text-xs font-mono text-zinc-400">{logsBuildId}</span>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setLogsBuildId(null)}
                                            className={cn('text-xs text-zinc-400 hover:text-[#C9D1D9] transition-colors', consoleButtonFocusClass)}
                                        >
                                            Close
                                        </button>
                                    </div>
                                    <pre className="p-4 text-xs font-mono text-[#C9D1D9] max-h-72 overflow-auto whitespace-pre-wrap leading-relaxed">
                                        {logsLoading ? 'Loading…' : logsContent}
                                    </pre>
                                </div>
                            )}

                            {/* Build history */}
                            {builds.filter((b) => b.state === 'ready' || b.state === 'failed').length > 1 && (
                                <div className={cn('rounded-lg border overflow-hidden', borderHairline, bgCanvas)}>
                                    <div className={cn('flex items-center justify-between px-4 py-3 border-b', borderHairline)}>
                                        <span className={cn('text-xs font-semibold', textSecondary)}>
                                            Build history
                                        </span>
                                        <span className={cn('text-xs', textPlaceholder)}>
                                            {builds.length} builds
                                        </span>
                                    </div>
                                    {builds.map((b) => (
                                        <div
                                            key={b.id}
                                            className={cn(
                                                'flex items-center gap-3 px-4 py-2.5 transition-colors border-b last:border-b-0',
                                                borderHairline,
                                                'hover:bg-zinc-100',
                                            )}
                                        >
                                            <span className={cn(
                                                'w-1.5 h-1.5 rounded-full shrink-0',
                                                b.state === 'ready' ? 'bg-emerald-600' : 'bg-red-600',
                                            )} />
                                            <span className={cn('font-mono text-xs truncate flex-1', textSecondary)}>
                                                {b.id}
                                            </span>
                                            <span className={cn(
                                                'text-xs font-medium shrink-0',
                                                b.state === 'ready' ? accentGreenText : accentRed,
                                            )}>
                                                {b.state}
                                            </span>
                                            <span className={cn('text-xs shrink-0', textPlaceholder)}>
                                                {formatDuration(b.started_at, b.finished_at)}
                                            </span>
                                            <span className={cn('text-xs shrink-0', textPlaceholder)}>
                                                {formatTime(b.started_at)}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => handleViewLogs(b.id)}
                                                className={cn('text-xs text-black hover:underline shrink-0', consoleButtonFocusClass)}
                                            >
                                                {logsBuildId === b.id ? 'Hide' : 'Logs'}
                                            </button>
                                            {b.state === 'failed' && (
                                                <button
                                                    type="button"
                                                    onClick={() => handleDiscardBuild(b.id)}
                                                    className={cn('text-xs text-red-600 hover:underline shrink-0', consoleButtonFocusClass)}
                                                >
                                                    Discard
                                                </button>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>

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
        </div>
    );
}

export default function ImagesAdmin() {
    return <ImagesAdminContent />;
}
