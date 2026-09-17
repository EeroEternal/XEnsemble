import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Loader2, X, Plus, Check, Star, SlidersHorizontal } from 'lucide-react';
import { ConsoleDialogShell } from './ConsoleDialog';
import SelectMenu from './SelectMenu';
import ProjectSourceSelect from './git/ProjectSourceSelect';
import {
  consoleButtonFocusClass,
  consoleFormLabelClass,
} from '../lib/consoleTokens';
import { buttonClass } from '../lib/buttonStyles';
import { apiFetch } from '../lib/api';
import { cn } from '../lib/utils';
import {
  sortAgentsByRecentUsage,
  loadSidebarPrefs,
} from '../lib/sidebarPrefs';

const ENV_DEFAULT = '__default__';
const ENV_CUSTOMIZE = '__customize__';

const COMPONENT_CATEGORY_ORDER = ['language', 'database', 'package-manager', 'devops', 'shell-tool'];

const CATEGORY_LABEL_KEYS = {
  language: 'images:category.language',
  database: 'images:category.database',
  devops: 'images:category.devops',
  'package-manager': 'images:category.package-manager',
  'shell-tool': 'images:category.shell-tool',
};

export default function OnboardingWizard({
  // flow config
  mode = 'full', // 'full' = project source + agent; 'session' = agent only in current workspace
  // agents
  agents,
  selectedAgentId,
  onSelectAgent,
  // custom images / environment recipe
  customImages,
  presets = [],
  catalog = null,
  catalogLoading = false,
  customImageId,
  setCustomImageId,
  envComponents = [],
  setEnvComponents,
  // git import (full mode)
  importedProject,
  onRepoImported,
  // launch
  onClose,
  onLaunch, // full mode: create workspace + start session
  onLaunchSession, // session mode: start session in current workspace
  launching,
  launchError,
}) {
  const { t } = useTranslation();
  const isSession = mode === 'session';

  const sortedAgents = useMemo(
    () => sortAgentsByRecentUsage(agents || [], loadSidebarPrefs()),
    [agents],
  );

  const agentOptions = useMemo(
    () => sortedAgents.map((a) => ({ value: a.id, label: a.name })),
    [sortedAgents],
  );

  // --- Environment (recipe) ------------------------------------------------
  const [envMode, setEnvMode] = useState(() => (customImageId ? 'saved' : 'default'));
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const [envCheck, setEnvCheck] = useState(null); // { ready, image_ref } | null
  const [envChecking, setEnvChecking] = useState(false);

  // Component display names come from the catalog; load it up-front so saved
  // images can be described with concrete names + versions.
  const componentById = useMemo(() => {
    const map = {};
    for (const comp of (catalog?.components || [])) map[comp.id] = comp;
    return map;
  }, [catalog]);

  const describeComponent = useCallback((c) => {
    const id = c.component_id || '';
    const name = componentById[id]?.name || id.replace(/^[a-z-]+:/, '');
    return `${name} ${c.version}`;
  }, [componentById]);

  // Concrete environment summary, e.g. "Python 3.11 + jq + kubectl".
  const describeComponents = useCallback(
    (components) => (components || [])
      .filter((c) => !(c.component_id || '').startsWith('agent:'))
      .map(describeComponent)
      .join(' + '),
    [describeComponent],
  );

  const envOptions = useMemo(() => {
    // A saved/preset image bakes in an agent; only offer those whose agent this
    // user can actually select, otherwise the launch would send a mismatched agent.
    const agentAvailable = (img) => {
      const ac = (img.components || []).find((c) => (c.component_id || '').startsWith('agent:'));
      const agentId = ac ? ac.component_id.replace('agent:', '') : '';
      return !agentId || (agents || []).some((a) => a.id === agentId);
    };
    // The image name is the label; the concrete components + versions are the
    // hover title. Curated presets are marked with a trailing star icon.
    const seen = new Set();
    const curated = (presets || []).filter(agentAvailable).map((img) => {
      seen.add(img.id);
      return {
        value: `custom:${img.id}`,
        label: img.name,
        title: describeComponents(img.components) || img.name,
        badgeIcon: <Star className="h-3.5 w-3.5" fill="currentColor" strokeWidth={0} />,
      };
    });
    const saved = (customImages || [])
      .filter((img) => !seen.has(img.id) && agentAvailable(img))
      .map((img) => ({
        value: `custom:${img.id}`,
        label: img.name,
        title: describeComponents(img.components) || img.name,
      }));
    const customizeLabel = envComponents.length > 0
      ? describeComponents(envComponents)
      : t('sessions:launch.env_customize');
    return [
      { value: ENV_DEFAULT, label: t('sessions:launch.env_default') },
      ...curated,
      ...saved,
      {
        value: ENV_CUSTOMIZE,
        label: customizeLabel,
        emphasis: true,
        badgeIcon: <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.75} />,
      },
    ];
  }, [presets, customImages, agents, t, describeComponents, envComponents]);

  const envValue = envMode === 'saved' && customImageId
    ? `custom:${customImageId}`
    : envMode === 'customize'
      ? ENV_CUSTOMIZE
      : ENV_DEFAULT;

  const pickableComponents = useMemo(
    () => (catalog?.components || []).filter((c) => c.category !== 'agent'),
    [catalog],
  );

  const groupedComponents = useMemo(() => {
    const grouped = {};
    for (const comp of pickableComponents) {
      (grouped[comp.category] || (grouped[comp.category] = [])).push(comp);
    }
    return grouped;
  }, [pickableComponents]);

  // A prefilled image (e.g. the workspace default) must also select the agent
  // baked into it, otherwise the launch fails the server-side agent check.
  useEffect(() => {
    if (!customImageId) return;
    const img = [...(presets || []), ...(customImages || [])]
      .find((c) => c.id === customImageId);
    if (!img) return;
    const ac = (img.components || []).find((c) => (c.component_id || '').startsWith('agent:'));
    const agentId = ac ? ac.component_id.replace('agent:', '') : '';
    if (agentId && agentId !== selectedAgentId && (agents || []).some((a) => a.id === agentId)) {
      onSelectAgent(agentId);
    }
  }, [customImageId, presets, customImages, agents, selectedAgentId, onSelectAgent]);

  const handleEnvChange = (value) => {
    if (value === ENV_DEFAULT) {
      setEnvMode('default');
      setCustomImageId('');
      setEnvComponents?.([]);
      setEnvCheck(null);
      return;
    }
    if (value === ENV_CUSTOMIZE) {
      setEnvMode('customize');
      setCustomImageId('');
      return;
    }
    if (value.startsWith('custom:')) {
      const id = value.replace('custom:', '');
      setEnvMode('saved');
      setCustomImageId(id);
      setEnvComponents?.([]);
      setEnvCheck(null);
      const img = [...(presets || []), ...(customImages || [])].find((c) => c.id === id);
      if (img) {
        const ac = (img.components || []).find((c) => (c.component_id || '').startsWith('agent:'));
        const aid = ac ? ac.component_id.replace('agent:', '') : '';
        if (aid && (agents || []).some((a) => a.id === aid)) onSelectAgent(aid);
      }
    }
  };

  const handleAgentChange = (agentId) => {
    setCustomImageId('');
    if (envMode === 'saved') setEnvMode('default');
    onSelectAgent(agentId);
  };

  const toggleComponent = (comp) => {
    if (!setEnvComponents) return;
    const exists = envComponents.some((c) => c.component_id === comp.id);
    if (exists) {
      setEnvComponents(envComponents.filter((c) => c.component_id !== comp.id));
    } else {
      setEnvComponents([
        ...envComponents,
        { component_id: comp.id, version: comp.defaultVersion || 'latest' },
      ]);
    }
  };

  const setComponentVersion = (componentId, version) => {
    if (!setEnvComponents) return;
    setEnvComponents(
      envComponents.map((c) => (c.component_id === componentId ? { ...c, version } : c)),
    );
  };

  const toggleGroup = (category) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  // Readiness probe: is this exact recipe already built? Debounced.
  const recipeKey = useMemo(() => {
    if (!selectedAgentId || envComponents.length === 0) return '';
    const parts = [
      `agent:${selectedAgentId}@latest`,
      ...envComponents.map((c) => `${c.component_id}@${c.version}`),
    ].sort();
    return parts.join('|');
  }, [selectedAgentId, envComponents]);

  useEffect(() => {
    if (envMode !== 'customize' || !recipeKey) {
      setEnvCheck(null);
      setEnvChecking(false);
      return;
    }
    let cancelled = false;
    setEnvChecking(true);
    const timer = setTimeout(async () => {
      try {
        const selection = [
          { component_id: `agent:${selectedAgentId}`, version: 'latest' },
          ...envComponents,
        ];
        const res = await apiFetch('/api/v1/custom-images/check', {
          method: 'POST',
          body: JSON.stringify({ selection }),
        });
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setEnvCheck(res.ok ? data : null);
      } catch {
        if (!cancelled) setEnvCheck(null);
      } finally {
        if (!cancelled) setEnvChecking(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [envMode, recipeKey]);

  // full mode can start once a project source is resolved (imported repo) + agent selected.
  // session mode only needs an agent.
  const canStart = isSession
    ? Boolean(selectedAgentId)
    : Boolean(selectedAgentId && importedProject);

  const handleStart = () => {
    if (!canStart) return;
    if (isSession) onLaunchSession?.();
    else onLaunch?.();
  };

  return (
    <ConsoleDialogShell
      onClose={onClose}
      panelClassName="w-[533px] max-w-[calc(100vw-2rem)] h-[512px] max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 shrink-0">
        <h2 className="font-bold text-lg text-zinc-900">
          {isSession ? t('sessions:launch.title') : t('sessions:launch.create_workspace')}
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

      {/* Body: stacked fields (single step) */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 space-y-5">
        {!isSession && (
          <div className="space-y-1.5">
            <label className={consoleFormLabelClass}>{t('sessions:launch.repository')}</label>
            <ProjectSourceSelect
              importedProject={importedProject}
              onImported={(pid) => { onRepoImported?.(pid); }}
              disabled={launching}
            />
          </div>
        )}

        <div className="space-y-1.5">
          <label className={consoleFormLabelClass}>{t('sessions:launch.agent')}</label>
          <SelectMenu
            value={selectedAgentId || ''}
            onChange={handleAgentChange}
            options={agentOptions}
            placeholder={t('sessions:launch.select_agent')}
            searchable
            searchPlaceholder={t('sessions:launch.search_agents')}
            maxHeight={200}
          />
        </div>

        <div className="space-y-1.5">
          <label className={consoleFormLabelClass}>{t('sessions:launch.environment')}</label>
          <SelectMenu
            value={envValue}
            onChange={handleEnvChange}
            options={envOptions}
            placeholder={t('sessions:launch.select_environment')}
            maxHeight={200}
          />

          {envMode === 'customize' && (
            <div className="mt-2 rounded-lg border border-zinc-200">
              {catalogLoading && !catalog ? (
                <div className="flex items-center gap-2 px-3 py-3 text-xs text-zinc-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('common:state.loading')}
                </div>
              ) : pickableComponents.length === 0 ? (
                <p className="px-3 py-3 text-xs text-zinc-400">
                  {t('sessions:launch.env_no_components')}
                </p>
              ) : (
                <div className="max-h-56 overflow-y-auto scrollbar-hover">
                  {COMPONENT_CATEGORY_ORDER.filter((cat) => groupedComponents[cat]?.length > 0).map((cat) => {
                    const expanded = !collapsedGroups.has(cat);
                    return (
                      <div key={cat}>
                        <button
                          type="button"
                          onClick={() => toggleGroup(cat)}
                          aria-expanded={expanded}
                          className={cn(
                            'w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500 bg-zinc-50 border-b border-zinc-100 hover:bg-zinc-100 transition-colors',
                            consoleButtonFocusClass,
                          )}
                        >
                          {expanded
                            ? <ChevronDown className="h-3 w-3 shrink-0" />
                            : <ChevronRight className="h-3 w-3 shrink-0" />}
                          <span className="flex-1 text-left">
                            {CATEGORY_LABEL_KEYS[cat] ? t(CATEGORY_LABEL_KEYS[cat]) : cat}
                          </span>
                          <span className="font-normal normal-case text-zinc-400">{groupedComponents[cat].length}</span>
                        </button>
                        {expanded && groupedComponents[cat].map((comp) => {
                          const selected = envComponents.find((c) => c.component_id === comp.id);
                          return (
                            <div
                              key={comp.id}
                              className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-100 last:border-b-0"
                            >
                              <button
                                type="button"
                                onClick={() => toggleComponent(comp)}
                                disabled={launching}
                                className={cn(
                                  'flex min-w-0 flex-1 items-center gap-2 text-left',
                                  consoleButtonFocusClass,
                                )}
                              >
                                <span
                                  className={cn(
                                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                    selected ? 'border-black bg-black text-white' : 'border-zinc-300 bg-white',
                                  )}
                                >
                                  {selected && <Check className="h-3 w-3" />}
                                </span>
                                <span className="min-w-0 truncate text-sm text-zinc-800">{comp.name}</span>
                              </button>
                              {selected && comp.versions?.length > 0 && (
                                <SelectMenu
                                  value={selected.version}
                                  onChange={(v) => setComponentVersion(comp.id, v)}
                                  options={comp.versions.map((v) => ({ value: v.version, label: v.version }))}
                                  disabled={launching}
                                  className="w-24 shrink-0"
                                  maxHeight={180}
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="border-t border-zinc-100 px-3 py-2 text-xs">
                {envComponents.length === 0 ? (
                  <span className="text-zinc-400">{t('sessions:launch.env_pick_hint')}</span>
                ) : envChecking ? (
                  <span className="inline-flex items-center gap-1.5 text-zinc-400">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t('sessions:launch.env_checking')}
                  </span>
                ) : envCheck?.ready ? (
                  <span className="text-emerald-600">{t('sessions:launch.env_ready')}</span>
                ) : (
                  <span className="text-amber-600">{t('sessions:launch.env_needs_build')}</span>
                )}
              </div>
            </div>
          )}
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
          {t('common:action.cancel')}
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
              {t('sessions:launch.starting')}
            </>
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" />
              {isSession ? t('sessions:launch.start_agent') : t('sessions:launch.create_workspace')}
            </>
          )}
        </button>
      </div>
    </ConsoleDialogShell>
  );
}
