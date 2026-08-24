import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, KeyRound, Pencil, RefreshCw, Info, Loader2, Search } from 'lucide-react';

import Button from '../components/Button';
import Input from '../components/Input';
import RowActionsMenu from '../components/RowActionsMenu';
import PageHeader from '../components/PageHeader';
import StatusBadge from '../components/StatusBadge';
import { getBuildState } from '../lib/imageBuildStates';
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

function getAuthSummary(agent) {
  return {
    mode: 'Gateway',
    hint: agent.keys_ready ? 'Ready' : 'Needs model',
    hintClass: agent.keys_ready ? 'text-emerald-600' : 'text-amber-600',
  };
}

function runtimeBadge(entry) {
  if (entry?.active_version) {
    return { ...getBuildState('ready'), tag: entry.active_version.tag || 'latest' };
  }
  if (entry?.build_state === 'building' || entry?.build_state === 'queued') {
    return getBuildState(entry.build_state);
  }
  if (entry?.build_state === 'failed') {
    return { ...getBuildState('failed'), label: 'Build failed' };
  }
  if (entry?.buildable === false) {
    return { tone: 'neutral', icon: null, label: 'Not buildable' };
  }
  return { tone: 'warning', icon: null, label: 'No image', title: "Build this agent's image under Images" };
}

export default function AgentsAdmin() {
  const [agents, setAgents] = useState(() => loadAdminAgentsCache());
  const [imageCatalog, setImageCatalog] = useState({});
  const [gatewayProviders, setGatewayProviders] = useState([]);
  const [loading, setLoading] = useState(() => loadAdminAgentsCache().length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [registerOpen, setRegisterOpen] = useState(false);
  const [keysAgent, setKeysAgent] = useState(null);
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

  const fetchAgentImages = useCallback(() => {
    return apiFetch('/api/v1/admin/agent-images')
      .then((res) => res.json())
      .then((data) => {
        const list = Array.isArray(data?.agents) ? data.agents : [];
        const map = {};
        for (const entry of list) {
          if (entry?.agent_id) map[entry.agent_id] = entry;
        }
        setImageCatalog(map);
      })
      .catch(() => {});
  }, []);

  const filteredAgents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => (a.name || '').toLowerCase().includes(q));
  }, [agents, searchQuery]);

  useEffect(() => {
    fetchAgents({ silent: agents.length > 0 });
    fetchAgentImages();
  }, [fetchAgents, fetchAgentImages]);

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

  return (
    <div className={consoleAdminPageClass}>
      <PageHeader title="Agents" />

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-zinc-500 shrink-0">{agents.length} agents</span>
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
            onClick={() => { fetchAgents({ silent: true }); fetchAgentImages(); }}
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
      </div>

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
                <th className={consoleTableHeadCellClass}>Runtime</th>
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
                const imageEntry = imageCatalog[agent.id];
                const runtime = runtimeBadge(imageEntry);
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
                      <div className="flex flex-col items-start gap-1">
                        <StatusBadge tone={runtime.tone} icon={runtime.icon} spinning={runtime.spinning} label={runtime.label} title={runtime.title} />
                        {runtime.tag ? (
                          <span className="font-mono text-xs text-zinc-500">{runtime.tag}</span>
                        ) : null}
                      </div>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <span className="font-mono text-xs text-zinc-600">
                        {imageEntry?.active_version ? (imageEntry.active_version.tag || 'latest') : '-'}
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
                          { icon: Pencil, label: 'Edit executable', onClick: () => setEditAgent(agent) },
                          { icon: KeyRound, label: 'Configure', onClick: () => setKeysAgent(agent) },
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
