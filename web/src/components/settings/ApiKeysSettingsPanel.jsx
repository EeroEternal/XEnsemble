import { useState, useEffect, useCallback } from 'react';
import { Loader2, ChevronDown, ChevronRight, Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { apiFetch } from '../../lib/api';
import {
  consoleSectionLabelClass,
  consoleButtonFocusClass,
} from '../../lib/consoleTokens';
import {
  textPrimary,
  textPlaceholder,
  borderHairline,
} from '../../lib/consoleTokens';
import ByokConfigForm from '../ByokConfigForm';

export default function ApiKeysSettingsPanel() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedAgent, setExpandedAgent] = useState(null);
  const [configuredKeys, setConfiguredKeys] = useState({});

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/v1/agents');
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.agents || []);
      setAgents(list);
      const byokAgents = list.filter((a) => a.llm_auth_mode === 'byok' || !a.llm_auth_mode);
      const secretsRes = await apiFetch('/api/v1/secrets');
      const secretsData = await secretsRes.json();
      const configured = {};
      for (const a of byokAgents) {
        const required = a.env_required || [];
        configured[a.id] = required.length > 0 && required.every((k) => secretsData[k]);
      }
      setConfiguredKeys(configured);
    } catch {
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <p className="text-sm text-zinc-500 py-8 text-center">No agents available.</p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className={cn('mb-1', consoleSectionLabelClass)}>Agent API Keys</h3>
        <p className={cn('text-xs', textPlaceholder)}>
          BYOK agents require your own API keys. Gateway agents use the shared platform key and need no configuration.
        </p>
      </div>

      <div className={cn('rounded-lg border', borderHairline, 'overflow-hidden')}>
        {agents.map((agent, idx) => {
          const isByok = agent.llm_auth_mode === 'byok' || !agent.llm_auth_mode;
          const isExpanded = expandedAgent === agent.id;
          const isConfigured = configuredKeys[agent.id];
          const showDivider = idx > 0;

          return (
            <div key={agent.id}>
              {showDivider && <div className={cn('border-t', borderHairline)} />}
              <button
                type="button"
                disabled={!isByok}
                onClick={() => setExpandedAgent(isExpanded ? null : agent.id)}
                className={cn(
                  'w-full flex items-center gap-2 px-4 py-3 text-left transition-colors',
                  isByok ? 'hover:bg-zinc-50 cursor-pointer' : 'cursor-default',
                  consoleButtonFocusClass,
                )}
              >
                {isByok && (
                  isExpanded
                    ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                    : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                )}
                <span className={cn('text-sm font-medium', textPrimary)}>{agent.name}</span>
                <span className={cn(
                  'ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0',
                  isByok
                    ? isConfigured
                      ? 'bg-emerald-50 text-emerald-600'
                      : 'bg-amber-50 text-amber-500'
                    : 'bg-zinc-100 text-zinc-500',
                )}>
                  {isByok
                    ? isConfigured
                      ? (<span className="flex items-center gap-0.5"><Check className="h-2.5 w-2.5" />Configured</span>)
                      : 'Needs keys'
                    : 'Gateway'}
                </span>
              </button>
              {isByok && isExpanded && (
                <div className={cn('px-4 pb-4 pt-1 bg-zinc-50/50 border-t', borderHairline)}>
                  <ByokConfigForm
                    agentId={agent.id}
                    loading={false}
                    onSave={() => {
                      fetchAgents();
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
