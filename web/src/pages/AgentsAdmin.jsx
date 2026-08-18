import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Download, KeyRound, Pencil, Trash2, RefreshCw, Info, MoreHorizontal, CheckCircle, Clock } from 'lucide-react';

import Button from '../components/Button';
import PageHeader from '../components/PageHeader';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { confirm } from '../components/ConfirmDialog';
import {
  consoleIconButtonClass,
  consoleMenuDropdownZClass,
  consoleAdminPageClass,
  consoleTableBodyCellClass,
  consoleTableHeadCellClass,
  consoleTableShellClass,
} from '../lib/consoleTokens';
import { loadAdminAgentsCache, saveAdminAgentsCache } from '../lib/adminAgentsCache';
import { apiFetch } from '../lib/api';
import AgentRegisterDialog from '../components/admin/AgentRegisterDialog';
import AgentEditDialog from '../components/admin/AgentEditDialog';
import AgentConfigDialog from '../components/admin/AgentConfigDialog';
import AgentDetailsDialog from '../components/admin/AgentDetailsDialog';

const ACTION_PROGRESS_LABEL = {
  install: 'Installing',
  uninstall: 'Removing',
  update: 'Updating',
};

const ACTION_LOADING_HINT = {
  install: 'This may take several minutes.',
};

function statusBadge(installed) {
  return installed
    ? { tone: 'success', icon: CheckCircle, label: 'Installed' }
    : { tone: 'warning', icon: Clock, label: 'Not installed' };
}

function formatLifecycleTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

function getAuthSummary(agent) {
  const isGateway = agent.llm_auth_mode === 'gateway';
  if (isGateway) {
    return {
      mode: 'Gateway',
      hint: agent.keys_ready ? 'Ready' : 'Needs model',
      hintClass: agent.keys_ready ? 'text-emerald-600' : 'text-amber-600',
    };
  }
  return {
    mode: 'BYOK',
    hint: 'User keys',
    hintClass: 'text-zinc-500',
  };
}

function LifecycleInfoDot({ lifecycle }) {
  if (!lifecycle) return null;
  const label = lifecycle.ok
    ? `${lifecycle.action} OK`
    : `${lifecycle.action} failed`;
  const when = formatLifecycleTime(lifecycle.finished_at);

  return (
    <span className="relative inline-flex group/lifecycle">
      <button
        type="button"
        tabIndex={-1}
        className={`ml-1.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
          lifecycle.ok
            ? 'border-zinc-300 bg-zinc-50 text-zinc-400 hover:border-zinc-400 hover:text-zinc-600'
            : 'border-red-200 bg-red-50 text-red-500 hover:border-red-300'
        }`}
        aria-label={`${label}, ${when}`}
      >
        <span className="h-1 w-1 rounded-full bg-current" />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 hidden w-max max-w-xs -translate-x-1/2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs shadow-sm group-hover/lifecycle:block"
      >
        <span className={`block font-medium ${lifecycle.ok ? 'text-zinc-700' : 'text-red-600'}`}>
          {label}
        </span>
        {!lifecycle.ok && lifecycle.message ? (
          <span className="mt-0.5 block text-zinc-500">{lifecycle.message}</span>
        ) : null}
        <span className="mt-0.5 block text-zinc-400">{when}</span>
      </span>
    </span>
  );
}

function AgentActionsMenu({
  agent,
  loadingAction,
  onViewDetails,
  onEdit,
  onInstall,
  onCheckUpdate,
  onUninstall,
  onConfigure,
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef(null);
  const installLoading = loadingAction === `${agent.id}:install`;
  const updateLoading = loadingAction === `${agent.id}:update`;
  const uninstallLoading = loadingAction === `${agent.id}:uninstall`;
  const busy = Boolean(loadingAction?.startsWith(`${agent.id}:`));

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleToggle = () => {
    if (!open && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setDropUp(spaceBelow < 260);
    }
    setOpen((v) => !v);
  };

  const run = (fn) => () => {
    setOpen(false);
    fn();
  };

  const itemClass = (danger = false) => (
    `w-full flex items-center gap-2 px-3 py-2 text-sm disabled:opacity-40 disabled:pointer-events-none ${
      danger
        ? 'text-red-600 hover:bg-red-50 hover:text-red-700'
        : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900'
    }`
  );

  return (
    <div ref={rootRef} className="relative flex justify-end">
      <button
        type="button"
        onClick={() => handleToggle()}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Actions for ${agent.name}`}
        className={`${consoleIconButtonClass} ${open ? 'bg-zinc-100 text-zinc-900' : ''}`}
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute right-0 ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'} w-52 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg shadow-zinc-200/50 ${consoleMenuDropdownZClass}`}
        >
          <button type="button" role="menuitem" onClick={run(onViewDetails)} className={itemClass()}>
            <Info className="w-4 h-4 shrink-0" />
            View details
          </button>
          <button type="button" role="menuitem" onClick={run(onEdit)} className={itemClass()} disabled={busy}>
            <Pencil className="w-4 h-4 shrink-0" />
            Edit executable
          </button>
          <button type="button" role="menuitem" onClick={run(onConfigure)} className={itemClass()} disabled={busy}>
            <KeyRound className="w-4 h-4 shrink-0" />
            Configure
          </button>
          <div className="my-1 border-t border-zinc-100" role="separator" />
          {!agent.installed ? (
            <button
              type="button"
              role="menuitem"
              onClick={run(onInstall)}
              className={itemClass()}
              disabled={installLoading}
            >
              <Download className="w-4 h-4 shrink-0" />
              {installLoading ? 'Installing...' : 'Install on server'}
            </button>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={run(onCheckUpdate)}
                className={itemClass()}
                disabled={updateLoading}
              >
                <RefreshCw className={`w-4 h-4 shrink-0 ${updateLoading ? 'animate-spin' : ''}`} />
                {updateLoading ? 'Updating...' : 'Check and update'}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={run(onUninstall)}
                className={itemClass(true)}
                disabled={uninstallLoading}
              >
                <Trash2 className="w-4 h-4 shrink-0" />
                {uninstallLoading ? 'Removing...' : 'Uninstall'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function patchAgentLifecycle(agents, agentId, lastLifecycle) {
  if (!lastLifecycle) return agents;
  return agents.map((agent) => (
    agent.id === agentId ? { ...agent, last_lifecycle: lastLifecycle } : agent
  ));
}

export default function AgentsAdmin() {
  const { showToast } = useToast();
  const [agents, setAgents] = useState(() => loadAdminAgentsCache());
  const [gatewayProviders, setGatewayProviders] = useState([]);
  const [loading, setLoading] = useState(() => loadAdminAgentsCache().length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [keysAgent, setKeysAgent] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [editAgent, setEditAgent] = useState(null);
  const [detailsAgent, setDetailsAgent] = useState(null);

  const fetchAgents = useCallback(({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    return apiFetch('/api/v1/admin/agents')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setAgents(data);
          saveAdminAgentsCache(data);
        }
      })
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    fetchAgents({ silent: agents.length > 0 });
  }, [fetchAgents]);

  const fetchGatewayProviders = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/admin/gateway/providers');
      if (!res.ok) return;
      const data = await res.json();
      setGatewayProviders(data?.data || []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    fetchGatewayProviders();
  }, [fetchGatewayProviders]);

  const runAgentAction = async (agentId, action, { agentName, method = 'POST', successMsg, onSuccess } = {}) => {
    const label = ACTION_PROGRESS_LABEL[action] || 'Processing';
    const name = agentName || agentId;
    const hint = ACTION_LOADING_HINT[action];
    showToast('loading', hint ? `${label} ${name}... ${hint}` : `${label} ${name}...`);
    setActionLoading(`${agentId}:${action}`);
    try {
      const res = await apiFetch(`/api/v1/admin/agents/${agentId}/${action}`, {
        method,
        ...(method !== 'GET' ? { body: '{}' } : {}),
      });
      const data = await res.json();
      if (data.last_lifecycle) {
        setAgents((prev) => {
          const next = patchAgentLifecycle(prev, agentId, data.last_lifecycle);
          saveAdminAgentsCache(next);
          return next;
        });
      }
      if (!res.ok) throw new Error(data.error);
      if (onSuccess) onSuccess(data);
      else if (successMsg) showToast('success', successMsg);
      fetchAgents({ silent: true });
      return data;
    } catch (err) {
      showToast('error', err.message || 'Action failed.');
      return null;
    } finally {
      setActionLoading(null);
    }
  };

  const handleInstall = (agent) => runAgentAction(agent.id, 'install', {
    agentName: agent.name,
    onSuccess: (data) => showToast(
      'success',
      data.already_installed ? `${agent.name} is already installed.` : `${agent.name} installed.`,
    ),
  });

  const handleUninstall = async (agent) => {
    if (!await confirm({ title: 'Uninstall Agent', message: `Uninstall ${agent.name} from this server?`, confirmLabel: 'Uninstall', variant: 'danger' })) return;
    await runAgentAction(agent.id, 'uninstall', {
      agentName: agent.name,
      onSuccess: (data) => showToast(
        'success',
        data.already_removed ? `${agent.name} is already removed.` : `${agent.name} uninstalled.`,
      ),
    });
  };

  const handleCheckAndUpdate = async (agent) => {
    setActionLoading(`${agent.id}:update`);
    try {
      const checkRes = await apiFetch(`/api/v1/admin/agents/${agent.id}/check-update`);
      const check = await checkRes.json();
      if (!checkRes.ok) throw new Error(check.error);
      if (!check.installed) {
        showToast('error', `${agent.name} is not installed.`);
        return;
      }

      const shouldUpdate = check.update_available || !check.latest_version;
      if (!shouldUpdate) {
        showToast('success', `${agent.name} is up to date (${check.local_version}).`);
        return;
      }

      showToast('loading', `Updating ${agent.name}...`);
      const updateRes = await apiFetch(`/api/v1/admin/agents/${agent.id}/update`, {
        method: 'POST',
        body: '{}',
      });
      const updated = await updateRes.json();
      if (updated.last_lifecycle) {
        setAgents((prev) => {
          const next = patchAgentLifecycle(prev, agent.id, updated.last_lifecycle);
          saveAdminAgentsCache(next);
          return next;
        });
      }
      if (!updateRes.ok) throw new Error(updated.error);

      const newVersion = updated.local_version || check.latest_version;
      if (check.update_available && check.local_version && newVersion) {
        showToast('success', `${agent.name} updated (${check.local_version} -> ${newVersion}).`);
      } else {
        showToast('success', newVersion ? `${agent.name} updated to ${newVersion}.` : `${agent.name} updated.`);
      }
      fetchAgents({ silent: true });
    } catch (err) {
      showToast('error', err.message || 'Update failed.');
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className={consoleAdminPageClass}>
      <PageHeader
        title="Agents"
        description={
          refreshing
            ? 'Refreshing agent status...'
            : 'Install agents on the server, configure platform API keys, and manage the registry.'
        }
        actions={(
          <Button type="button" onClick={() => setRegisterOpen(true)} size="md" className="shrink-0">
            <Plus className="w-4 h-4" />
            Add Agent
          </Button>
        )}
      />

      <AgentRegisterDialog
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onRegistered={() => fetchAgents({ silent: true })}
      />

      <AgentEditDialog
        agent={editAgent}
        onClose={() => setEditAgent(null)}
        onSaved={() => fetchAgents({ silent: true })}
      />

      <AgentConfigDialog
        agent={keysAgent}
        gatewayProviders={gatewayProviders}
        onClose={() => setKeysAgent(null)}
        onSaved={() => fetchAgents({ silent: true })}
      />

      <AgentDetailsDialog
        agent={detailsAgent}
        onClose={() => setDetailsAgent(null)}
      />

      <div className={consoleTableShellClass}>
        <div className="overflow-auto max-h-[calc(100vh-200px)]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-white">
              <tr>
                <th className={consoleTableHeadCellClass}>Name</th>
                <th className={consoleTableHeadCellClass}>Status</th>
                <th className={consoleTableHeadCellClass}>Version</th>
                <th className={consoleTableHeadCellClass}>Executable</th>
                <th className={consoleTableHeadCellClass}>Auth</th>
                <th className={`${consoleTableHeadCellClass} w-12 text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {loading && agents.length === 0 ? (
                <tr>
                  <td colSpan={6} className={`${consoleTableBodyCellClass} text-zinc-500`}>
                    Loading...
                  </td>
                </tr>
              ) : agents.length === 0 ? (
                <tr>
                  <td colSpan={6} className={`${consoleTableBodyCellClass} text-zinc-500`}>
                    No agents registered yet.
                  </td>
                </tr>
              ) : agents.map((agent) => {
                const authSummary = getAuthSummary(agent);
                const executable = [agent.cmd, ...(agent.args || [])].filter(Boolean).join(' ');
                return (
                  <tr key={agent.id} className="hover:bg-zinc-50/50">
                    <td className={`${consoleTableBodyCellClass} min-w-0`}>
                      <div className="truncate text-zinc-900" title={`${agent.name} (${agent.id})`}>
                        <span className="font-medium">{agent.name}</span>
                        <span className="ml-1 font-mono text-xs text-zinc-400">({agent.id})</span>
                      </div>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <div className="flex items-center">
                        <StatusBadge tone={statusBadge(agent.installed).tone} icon={statusBadge(agent.installed).icon} label={statusBadge(agent.installed).label} />
                        <LifecycleInfoDot lifecycle={agent.last_lifecycle} />
                      </div>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <span className="font-mono text-xs text-zinc-600">
                        {agent.local_version ? `v${agent.local_version}` : '-'}
                      </span>
                    </td>
                    <td className={`${consoleTableBodyCellClass} min-w-0 max-w-[16rem]`}>
                      <span className="block truncate font-mono text-xs text-zinc-600" title={executable}>
                        {executable}
                      </span>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <span className="text-xs text-zinc-700">
                        <span className="font-medium">{authSummary.mode}</span>
                        <span
                          className={`ml-1 ${authSummary.hintClass}`}
                          title={
                            agent.llm_auth_mode === 'gateway'
                              ? (agent.keys_ready
                                ? 'Gateway model configured; agent can launch.'
                                : 'Select a model under Configure.')
                              : 'Users supply API keys before launching.'
                          }
                        >
                          ({authSummary.hint})
                        </span>
                      </span>
                    </td>
                    <td className={`${consoleTableBodyCellClass} w-12`}>
                      <AgentActionsMenu
                        agent={agent}
                        loadingAction={actionLoading}
                        onViewDetails={() => setDetailsAgent(agent)}
                        onEdit={() => setEditAgent(agent)}
                        onInstall={() => handleInstall(agent)}
                        onCheckUpdate={() => handleCheckAndUpdate(agent)}
                        onUninstall={() => handleUninstall(agent)}
                        onConfigure={() => setKeysAgent(agent)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
