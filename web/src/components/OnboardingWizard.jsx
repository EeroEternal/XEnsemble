import { useMemo, useState } from 'react';
import { Loader2, X, Plus } from 'lucide-react';
import { ConsoleDialogShell } from './ConsoleDialog';
import SelectMenu from './SelectMenu';
import ProjectSourceSelect from './git/ProjectSourceSelect';
import {
  consoleButtonFocusClass,
  consoleFormLabelClass,
} from '../lib/consoleTokens';
import { buttonClass } from '../lib/buttonStyles';
import {
  sortAgentsByRecentUsage,
  loadSidebarPrefs,
} from '../lib/sidebarPrefs';

export default function OnboardingWizard({
  // flow config
  mode = 'full', // 'full' = project source + agent; 'session' = agent only in current workspace
  // agents
  agents,
  selectedAgentId,
  onSelectAgent,
  // custom images
  customImages,
  customImageId,
  setCustomImageId,
  // git import (full mode)
  importedProject,
  onRepoImported,
  newProjectName,
  setNewProjectName,
  // launch
  onClose,
  onLaunch, // full mode: create workspace + start session
  onLaunchSession, // session mode: start session in current workspace
  launching,
  launchError,
}) {
  const isSession = mode === 'session';
  const [sourceChoice, setSourceChoice] = useState(null); // 'git' | 'blank' | null

  const sortedAgents = useMemo(
    () => sortAgentsByRecentUsage(agents || [], loadSidebarPrefs()),
    [agents],
  );

  // Merged agent options: built-in agents + custom images in one dropdown.
  const agentOptions = useMemo(() => {
    const builtIn = sortedAgents.map((a) => ({ value: `agent:${a.id}`, label: a.name }));
    const custom = (customImages || []).map((img) => {
      const ac = (img.components || []).find((c) => (c.component_id || '').startsWith('agent:'));
      const agentId = ac ? ac.component_id.replace('agent:', '') : '';
      const agent = (agents || []).find((a) => a.id === agentId);
      return { value: `custom:${img.id}`, label: `${img.name}${agent ? ` (${agent.name})` : ' · Custom'}` };
    });
    return [...builtIn, ...custom];
  }, [sortedAgents, customImages, agents]);

  const agentValue = customImageId
    ? `custom:${customImageId}`
    : (selectedAgentId ? `agent:${selectedAgentId}` : '');

  const handleAgentChange = (v) => {
    if (v.startsWith('agent:')) {
      setCustomImageId('');
      onSelectAgent(v.replace('agent:', ''));
    } else if (v.startsWith('custom:')) {
      const id = v.replace('custom:', '');
      setCustomImageId(id);
      const img = (customImages || []).find((c) => c.id === id);
      if (img) {
        const ac = (img.components || []).find((c) => (c.component_id || '').startsWith('agent:'));
        const aid = ac ? ac.component_id.replace('agent:', '') : '';
        if (aid && (agents || []).some((a) => a.id === aid)) onSelectAgent(aid);
      }
    }
  };

  // full mode can start once a project source is resolved (imported repo or blank name) + agent selected.
  // session mode only needs an agent.
  const canStart = isSession
    ? Boolean(selectedAgentId)
    : Boolean(selectedAgentId && (importedProject || (sourceChoice === 'blank' && (newProjectName || '').trim())));

  const handleStart = () => {
    if (!canStart) return;
    if (isSession) onLaunchSession?.();
    else onLaunch?.();
  };

  return (
    <ConsoleDialogShell
      onClose={onClose}
      panelClassName="w-[800px] max-w-[calc(100vw-2rem)] h-[512px] max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 shrink-0">
        <h2 className="font-bold text-lg text-zinc-900">
          {isSession ? 'New agent session' : 'Create workspace'}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={`flex items-center justify-center w-8 h-8 rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 transition-colors ${consoleButtonFocusClass}`}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body: two stacked dropdowns (single step) */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 space-y-5">
        {!isSession && (
          <div className="space-y-1.5">
            <label className={consoleFormLabelClass}>Project source</label>
            <ProjectSourceSelect
              importedProject={importedProject}
              onImported={(pid) => { setSourceChoice('git'); onRepoImported?.(pid); }}
              blankName={newProjectName}
              onBlankNameChange={setNewProjectName}
              isBlank={sourceChoice === 'blank'}
              onSelectBlank={() => { setSourceChoice('blank'); }}
              disabled={launching}
            />
          </div>
        )}

        <div className="space-y-1.5">
          <label className={consoleFormLabelClass}>Agent</label>
          <SelectMenu
            value={agentValue}
            onChange={handleAgentChange}
            options={agentOptions}
            placeholder="Select agent"
            searchable
            searchPlaceholder="Search agents…"
          />
        </div>

        {launchError && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
            {launchError}
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-zinc-200 px-5 py-3 bg-zinc-50/80 flex justify-end gap-2 shrink-0">
        <button
          type="button"
          onClick={onClose}
          className={`${buttonClass('secondary', 'sm')} ${consoleButtonFocusClass}`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleStart}
          disabled={launching || !canStart}
          className={`${buttonClass('primary', 'sm')} ${consoleButtonFocusClass}`}
        >
          {launching ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Starting…
            </>
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" />
              {isSession ? 'Start agent' : 'Create workspace'}
            </>
          )}
        </button>
      </div>
    </ConsoleDialogShell>
  );
}
