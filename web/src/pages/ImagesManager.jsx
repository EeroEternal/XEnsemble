import { useCallback, useContext, useEffect, useState } from 'react';
import { Layers, Loader2 } from 'lucide-react';

import { AuthContext } from '../App';
import AgentImagesModal from '../components/AgentImagesModal';
import PageHeader from '../components/PageHeader';
import { CustomImagesContent } from './CustomImages';
import {
  consoleAdminPageClass,
  consoleButtonFocusClass,
} from '../lib/consoleTokens';
import { cn } from '../lib/utils';
import { apiFetch } from '../lib/api';

function agentStatusLine(agent) {
  if (agent.build_state === 'building') return { dot: 'bg-blue-500 animate-pulse', text: 'Building…' };
  if (agent.build_state === 'queued') return { dot: 'bg-zinc-400', text: 'Queued' };
  if (agent.build_state === 'failed') return { dot: 'bg-red-500', text: 'Build failed' };
  if (agent.active_version) return { dot: 'bg-emerald-500', text: agent.active_version.tag };
  if (agent.default_image_ref) return { dot: 'bg-zinc-300', text: 'Default image' };
  return { dot: 'bg-zinc-300', text: 'Not built' };
}

function AgentImagesSection({ catalog, onManage }) {
  const agents = catalog?.agents || [];
  if (agents.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 -mt-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          <Layers className="h-3.5 w-3.5" />
          Agent Images
        </span>
        <button
          type="button"
          onClick={() => onManage(null)}
          className={cn('text-xs font-medium text-zinc-500 hover:text-zinc-900', consoleButtonFocusClass)}
        >
          Manage all
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2 xl:grid-cols-4 2xl:grid-cols-5">
        {agents.map((agent) => {
          const status = agentStatusLine(agent);
          return (
            <button
              key={agent.agent_id}
              type="button"
              onClick={() => onManage(agent.agent_id)}
              className={cn(
                'flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left shadow-sm transition-colors hover:border-zinc-300 hover:bg-zinc-50',
                consoleButtonFocusClass,
              )}
              title={`Manage ${agent.agent_name} image`}
            >
              <span className={cn('inline-flex h-2 w-2 shrink-0 rounded-full', status.dot)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-zinc-900">{agent.agent_name}</span>
                <span className={cn(
                  'block truncate font-mono text-[11px]',
                  agent.build_state === 'failed' ? 'text-red-500' : 'text-zinc-400',
                )}>
                  {status.text}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function ImagesManager() {
  const { user } = useContext(AuthContext);
  const isAdmin = user?.role === 'admin';
  const [catalog, setCatalog] = useState(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [manageAgentId, setManageAgentId] = useState(null);

  const loadAgentCatalog = useCallback(async () => {
    if (!isAdmin) return;
    setLoadingCatalog(true);
    try {
      const res = await apiFetch('/api/v1/admin/agent-images');
      const data = await res.json();
      if (res.ok && data?.agents) setCatalog(data);
    } catch {
      // keep last known state
    } finally {
      setLoadingCatalog(false);
    }
  }, [isAdmin]);

  useEffect(() => { loadAgentCatalog(); }, [loadAgentCatalog]);

  const closeManage = () => {
    setManageAgentId(null);
    loadAgentCatalog();
  };

  return (
    <div className={consoleAdminPageClass}>
      <PageHeader
        title="Images"
        description="Combine components into a pre-installed sandbox image."
      />

      {isAdmin && (
        loadingCatalog && !catalog ? (
          <div className="flex items-center gap-2 text-xs text-zinc-400 -mt-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading agent images…
          </div>
        ) : (
          <AgentImagesSection catalog={catalog} onManage={setManageAgentId} />
        )
      )}

      <CustomImagesContent />

      {manageAgentId !== null && (
        <AgentImagesModal
          initialAgentId={manageAgentId || null}
          onClose={closeManage}
        />
      )}
    </div>
  );
}
