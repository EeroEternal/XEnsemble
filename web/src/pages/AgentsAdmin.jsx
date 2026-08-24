import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, KeyRound, Pencil, RefreshCw, Info, Loader2, Search } from 'lucide-react';

import Button from '../components/Button';
import Input from '../components/Input';
import RowActionsMenu from '../components/RowActionsMenu';
import PageHeader from '../components/PageHeader';
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

function normalizeModels(model) {
  if (Array.isArray(model)) return model.map((m) => String(m || '').trim()).filter(Boolean);
  if (model) return [String(model).trim()];
  return [];
}

function getModelSummary(agent) {
  const cfg = agent.gateway_config;
  const provider = cfg?.provider || '';
  const models = normalizeModels(cfg?.model);
  const modelText = models.join(', ');
  const ready = Boolean(agent.keys_ready);
  return { provider, modelText, ready };
}

export default function AgentsAdmin() {
  const [agents, setAgents] = useState(() => loadAdminAgentsCache());
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
              <col className="w-56" />
              <col className="w-16" />
            </colgroup>
            <thead className="border-b border-zinc-200 bg-white">
              <tr>
                <th className={consoleTableHeadCellClass}>Name</th>
                <th className={consoleTableHeadCellClass}>Model</th>
                <th className={`${consoleTableHeadCellClass} w-16`}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {loading && agents.length === 0 ? (
                <tr>
                  <td colSpan={3} className={`${consoleTableBodyCellClass} text-zinc-500`}>
                    Loading...
                  </td>
                </tr>
              ) : filteredAgents.length === 0 ? (
                <tr>
                  <td colSpan={3} className={`${consoleTableBodyCellClass} text-zinc-500`}>
                    {agents.length === 0 ? 'No agents registered yet.' : 'No agents match your search.'}
                  </td>
                </tr>
              ) : filteredAgents.map((agent) => {
                const model = getModelSummary(agent);
                return (
                  <tr key={agent.id} className="hover:bg-zinc-50/50">
                    <td className={`${consoleTableBodyCellClass} min-w-0`}>
                      <div className="truncate text-zinc-900" title={`${agent.name} (${agent.id})`}>
                        <span className="font-medium">{agent.name}</span>
                        <span className="ml-1 font-mono text-xs text-zinc-400">({agent.id})</span>
                      </div>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      {model.provider || model.modelText ? (
                        <div className="flex flex-col items-start gap-0.5">
                          <span className="text-xs text-zinc-700">
                            <span className="font-medium">{model.provider}</span>
                            {model.modelText ? (
                              <span className="text-zinc-500"> / {model.modelText}</span>
                            ) : null}
                          </span>
                          <span className={`text-xs font-medium ${model.ready ? 'text-emerald-600' : 'text-amber-600'}`}>
                            {model.ready ? 'Ready' : 'Needs model'}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-amber-600 font-medium">Needs model</span>
                      )}
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
