import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Download, KeyRound, Pencil, Trash2, RefreshCw, Info, CheckCircle, Clock, Loader2, Search } from 'lucide-react';

import Button from '../components/Button';
import Input from '../components/Input';
import RowActionsMenu from '../components/RowActionsMenu';
import PageHeader from '../components/PageHeader';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { confirm } from '../components/ConfirmDialog';
import {
  consoleAdminPageClass,
  consoleIconButtonClass,
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
  const [searchQuery, setSearchQuery] = useState('');
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
      .catch(() => {})
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  const filteredAgents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => (a.name || '').toLowerCase().includes(q));
  }, [agents, searchQuery]);

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
          <div className="flex items-center gap-2">
            <div className="relative w-64 shrink-0">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search agents…"
                className="w-full pl-8"
              />
            </div>
            <button
              type="button"
              onClick={() => fetchAgents({ silent: true })}
              disabled={refreshing}
              className={consoleIconButtonClass}
              title="Refresh"
            >
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
            <Button type="button" onClick={() => setRegisterOpen(true)} size="md" className="shrink-0">
              <Plus className="w-4 h-4" />
              Add Agent
            </Button>
          </div>
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
          <table className="w-full min-w-[640px] table-fixed text-left text-sm">
            <colgroup>
              <col className="w-48" />
              <col className="w-36" />
              <col className="w-20" />
              <col className="w-44" />
              <col className="w-36" />
              <col className="w-16" />
            </colgroup>
            <thead className="border-b border-zinc-200 bg-white">
              <tr>
                <th className={consoleTableHeadCellClass}>Name</th>
                <th className={consoleTableHeadCellClass}>Status</th>
                <th className={consoleTableHeadCellClass}>Version</th>
                <th className={consoleTableHeadCellClass}>Executable</th>
                <th className={consoleTableHeadCellClass}>Auth</th>
                <th className={`${consoleTableHeadCellClass} w-16`}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {loading && agents.length === 0 ? (
                <tr>
                  <td colSpan={6} className={`${consoleTableBodyCellClass} text-zinc-500`}>
                    Loading...
                  </td>
                </tr>
              ) : filteredAgents.length === 0 ? (
                <tr>
                  <td colSpan={6} className={`${consoleTableBodyCellClass} text-zinc-500`}>
                    {agents.length === 0 ? 'No agents registered yet.' : 'No agents match your search.'}
                  </td>
                </tr>
              ) : filteredAgents.map((agent) => {
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
                    <td className={`${consoleTableBodyCellClass} w-16`}>
                      <RowActionsMenu
                        label={`Actions for ${agent.name}`}
                        items={[
                          { icon: Info, label: 'View details', onClick: () => setDetailsAgent(agent) },
                          { icon: Pencil, label: 'Edit executable', onClick: () => setEditAgent(agent), disabled: Boolean(actionLoading?.startsWith(`${agent.id}:`)) },
                          { icon: KeyRound, label: 'Configure', onClick: () => setKeysAgent(agent), disabled: Boolean(actionLoading?.startsWith(`${agent.id}:`)) },
                          { separator: true },
                          ...(!agent.installed
                            ? [{ icon: Download, label: 'Install on server', onClick: () => handleInstall(agent), busy: actionLoading === `${agent.id}:install`, busyLabel: 'Installing…' }]
                            : [
                                { icon: RefreshCw, label: 'Check and update', onClick: () => handleCheckAndUpdate(agent), busy: actionLoading === `${agent.id}:update`, busyLabel: 'Updating…' },
                                { icon: Trash2, label: 'Uninstall', danger: true, onClick: () => handleUninstall(agent), busy: actionLoading === `${agent.id}:uninstall`, busyLabel: 'Removing…' },
                              ]),
                        ]}
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
