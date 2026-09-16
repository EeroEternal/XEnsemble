import { useState, useEffect, useCallback, useMemo } from 'react';
import { Loader2, Search, Settings2 } from 'lucide-react';

import Input from '../components/Input';
import PageHeader from '../components/PageHeader';
import {
  consoleAdminPageClass,
  consoleAdminTableScrollClass,
  consoleAdminTableShellClass,
  consoleIconButtonClass,
  consoleTableBodyCellClass,
  consoleTableHeadCellClass,
  consoleTableHeadRowClass,
} from '../lib/consoleTokens';
import { loadAdminAgentsCache, saveAdminAgentsCache } from '../lib/adminAgentsCache';
import { apiFetch } from '../lib/api';
import AgentConfigDialog from '../components/admin/AgentConfigDialog';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  const [agents, setAgents] = useState(() => loadAdminAgentsCache());
  const [gatewayProviders, setGatewayProviders] = useState([]);
  const [loading, setLoading] = useState(() => loadAdminAgentsCache().length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [keysAgent, setKeysAgent] = useState(null);

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
      <PageHeader title={t('agents:title')} />

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-zinc-500 shrink-0">{t('agents:count', { count: agents.length })}</span>
        <div className="flex items-center gap-2">
          <div className="relative w-64 shrink-0">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('agents:search_placeholder')}
              className="w-full pl-8"
            />
          </div>
        </div>
      </div>

      <AgentConfigDialog
        agent={keysAgent}
        gatewayProviders={gatewayProviders}
        onClose={() => setKeysAgent(null)}
        onSaved={() => fetchAgents({ silent: true })}
      />

      <div className={consoleAdminTableShellClass}>
        <div className={consoleAdminTableScrollClass}>
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <colgroup>
              <col className="w-1/4" />
              <col className="w-1/4" />
              <col className="w-1/4" />
              <col className="w-48" />
            </colgroup>
            <thead className="sticky top-0 z-10 console-table-head-sticky">
              <tr className={consoleTableHeadRowClass}>
                <th className={consoleTableHeadCellClass}>{t('agents:field.name')}</th>
                <th className={consoleTableHeadCellClass}>{t('agents:field.provider')}</th>
                <th className={consoleTableHeadCellClass}>{t('agents:field.model')}</th>
                <th className={consoleTableHeadCellClass}>{t('agents:field.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {loading && agents.length === 0 ? (
                <tr>
                  <td colSpan={4} className={`${consoleTableBodyCellClass} text-zinc-500`}>
                    {t('common:state.loading')}
                  </td>
                </tr>
              ) : filteredAgents.length === 0 ? (
                <tr>
                  <td colSpan={4} className={`${consoleTableBodyCellClass} text-zinc-500`}>
                    {agents.length === 0 ? t('agents:empty.none_registered') : t('agents:empty.no_match')}
                  </td>
                </tr>
              ) : filteredAgents.map((agent) => {
                const model = getModelSummary(agent);
                return (
                  <tr key={agent.id} className="hover:bg-zinc-50/50">
                    <td className={`${consoleTableBodyCellClass} min-w-0`}>
                      <div className="truncate text-zinc-900" title={agent.name}>
                        <span className="font-medium">{agent.name}</span>
                      </div>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      {model.provider ? (
                        <span className="text-xs font-medium text-zinc-700">{model.provider}</span>
                      ) : (
                        <span className="text-xs text-zinc-400">—</span>
                      )}
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      {model.modelText ? (
                        <div className="flex flex-col items-start gap-0.5">
                          <span className="text-xs font-mono text-zinc-600">{model.modelText}</span>
                          <span className={`text-xs font-medium ${model.ready ? 'text-emerald-600' : 'text-amber-600'}`}>
                            {model.ready ? t('agents:status.ready') : t('agents:status.needs_model')}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-amber-600 font-medium">{t('agents:status.needs_model')}</span>
                      )}
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <button
                        type="button"
                        onClick={() => setKeysAgent(agent)}
                        className={consoleIconButtonClass}
                        title={t('agents:action.configure')}
                        aria-label={t('agents:action.configure')}
                      >
                        <Settings2 className="h-4 w-4" />
                      </button>
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
