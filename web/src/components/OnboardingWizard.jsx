import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Github,
  Sparkles,
  Check,
  ChevronRight,
  ChevronLeft,
  Loader2,
  X,
  GitBranch,
  Plus,
} from 'lucide-react';
import RepoImportDialog from './git/RepoImportDialog';
import BrandMark from './BrandMark';
import {
  consoleButtonFocusClass,
  consoleInputClass,
} from '../lib/consoleTokens';
import { buttonClass } from '../lib/buttonStyles';
import {
  sortAgentsByRecentUsage,
  loadSidebarPrefs,
} from '../lib/sidebarPrefs';

const GIT_PROVIDERS = [
  { id: 'github', label: 'GitHub' },
  { id: 'gitlab', label: 'GitLab' },
  { id: 'gitea', label: 'Gitea' },
];

function agentSubtitle(a) {
  if (a.llm_auth_mode === 'gateway' && a.gateway_config?.model) return a.gateway_config.model;
  if (a.llm_auth_mode === 'byok') return 'Bring your own key';
  if (!a.installed) return 'Not installed';
  return a.id;
}

function StepDot({ n, label, active, done }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-semibold transition-colors ${
          active
            ? 'border-black bg-black text-white'
            : done
              ? 'border-zinc-900 bg-zinc-900 text-white'
              : 'border-zinc-300 bg-white text-zinc-400'
        }`}
      >
        {done ? <Check className="h-3 w-3" /> : n}
      </span>
      <span className={`text-xs font-medium ${active ? 'text-zinc-900' : 'text-zinc-400'}`}>{label}</span>
    </div>
  );
}

export default function OnboardingWizard({
  // flow config
  mode = 'full', // 'full' = step 1 (source) + step 2 (agent); 'session' = step 2 only in current workspace
  startStep = 1,
  workspace, // current workspace project object (session mode)
  // agents
  agents,
  selectedAgentId,
  onSelectAgent,
  // custom images
  customImages,
  customImageId,
  setCustomImageId,
  // git import
  gitProvider,
  setGitProvider,
  gitImportMode,
  setGitImportMode,
  importedProject,
  setImportedProject,
  onRepoImported,
  fetchWorkspaces,
  // blank workspace
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
  const [step, setStep] = useState(startStep);
  const [sourceChoice, setSourceChoice] = useState(null); // 'git' | 'blank'

  const sortedAgents = useMemo(
    () => sortAgentsByRecentUsage(agents || [], loadSidebarPrefs()),
    [agents],
  );

  // Auto-advance to step 2 once a repo import completes (full mode only).
  useEffect(() => {
    if (importedProject && step === 1 && !isSession) setStep(2);
  }, [importedProject, step, isSession]);

  const chooseSource = (choice) => {
    setSourceChoice(choice);
    if (choice === 'blank') {
      setGitImportMode(false);
      setGitProvider('');
      setImportedProject(null);
    } else {
      setNewProjectName('');
    }
  };

  const pickProvider = (p) => {
    setGitProvider(p);
    setGitImportMode(true);
    setImportedProject(null);
  };

  const selectBuiltInAgent = (agentId) => {
    setCustomImageId('');
    onSelectAgent(agentId);
  };

  const selectCustomImage = (img) => {
    setCustomImageId(img.id);
    const ac = (img.components || []).find((c) => (c.component_id || '').startsWith('agent:'));
    const aid = ac ? ac.component_id.replace('agent:', '') : '';
    if (aid && (agents || []).some((a) => a.id === aid)) onSelectAgent(aid);
  };

  const canAdvanceStep1 = Boolean(
    importedProject || (sourceChoice === 'blank' && newProjectName.trim()),
  );

  const handleNext = () => {
    if (!canAdvanceStep1) return;
    setStep(2);
  };

  const handleStart = () => {
    if (!selectedAgentId) return;
    if (isSession) onLaunchSession?.();
    else onLaunch?.();
  };

  // Workspace name shown in step 2 summary
  const workspaceName = isSession
    ? (workspace?.name || 'Current workspace')
    : (importedProject ? importedProject.name : newProjectName.trim() || 'my-workspace');
  const workspaceKind = isSession
    ? (workspace ? 'Current' : 'Current')
    : (importedProject ? 'From Git' : 'Blank');

  // Stepper config
  const stepper = isSession
    ? [
        { n: 1, label: 'Workspace', done: true, active: false },
        { n: 2, label: 'Select agent', done: false, active: true },
      ]
    : [
        { n: 1, label: 'Code source', done: step > 1, active: step === 1 },
        { n: 2, label: 'Select agent', done: false, active: step === 2 },
      ];

  // Footer left button: full step2 -> Back; otherwise Cancel
  const showBack = step === 2 && !isSession;

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-50">
      {/* Top bar: XEnsemble far-left, stepper center, close far-right */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-4">
        <div className="flex items-center gap-2">
          <BrandMark className="h-7 w-7" iconClassName="h-3.5 w-3.5" />
          <span className="text-sm font-bold text-zinc-900">XEnsemble</span>
        </div>
        <div className="flex items-center gap-2">
          {stepper.map((s, i) => (
            <Fragment key={s.n}>
              <StepDot n={s.n} label={s.label} active={s.active} done={s.done} />
              {i < stepper.length - 1 && <ChevronRight className="h-3.5 w-3.5 text-zinc-300" />}
            </Fragment>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={`shrink-0 rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 ${consoleButtonFocusClass}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Centered card */}
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-6">
        <div className="w-full max-w-xl rounded-lg border border-zinc-200 bg-white shadow-sm">
          {/* Card header */}
          <div className="shrink-0 border-b border-zinc-200 px-6 pt-5 pb-4">
            <h2 className="text-lg font-bold text-zinc-900">
              {isSession ? 'Start a new agent session' : 'Create your workspace'}
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              {isSession
                ? 'Pick an agent to launch a new session in this workspace.'
                : 'Set up a workspace and launch your first agent in two steps.'}
            </p>
          </div>

          {/* Card body */}
          <div className="px-6 py-5 space-y-5">
            {step === 1 && !isSession ? (
              <>
                {/* Source choice cards */}
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => chooseSource('git')}
                    className={`flex flex-col items-center gap-2 rounded-lg border-2 p-5 text-center transition-colors ${consoleButtonFocusClass} ${
                      sourceChoice === 'git'
                        ? 'border-black bg-zinc-50'
                        : 'border-zinc-200 hover:border-zinc-400 bg-white'
                    }`}
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-700">
                      <Github className="h-5 w-5" />
                    </span>
                    <span className="text-sm font-semibold text-zinc-900">Import from Git</span>
                    <span className="text-[11px] leading-relaxed text-zinc-500">
                      Clone a GitHub / GitLab / Gitea repository with its branch history.
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => chooseSource('blank')}
                    className={`flex flex-col items-center gap-2 rounded-lg border-2 p-5 text-center transition-colors ${consoleButtonFocusClass} ${
                      sourceChoice === 'blank'
                        ? 'border-black bg-zinc-50'
                        : 'border-zinc-200 hover:border-zinc-400 bg-white'
                    }`}
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-700">
                      <Sparkles className="h-5 w-5" />
                    </span>
                    <span className="text-sm font-semibold text-zinc-900">Start from blank</span>
                    <span className="text-[11px] leading-relaxed text-zinc-500">
                      Create an empty workspace and begin from scratch.
                    </span>
                  </button>
                </div>

                {/* Source-specific configuration */}
                {sourceChoice === 'git' && (
                  <div className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50/60 p-4">
                    {importedProject ? (
                      <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm">
                        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                        <span className="truncate font-medium text-zinc-900">{importedProject.name}</span>
                        <span className="ml-auto shrink-0 text-[10px] text-zinc-400">Imported</span>
                      </div>
                    ) : (
                      <>
                        <div>
                          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                            Git provider
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {GIT_PROVIDERS.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => pickProvider(p.id)}
                              className={`flex-1 h-9 px-2 rounded-md border text-xs font-medium capitalize transition-colors ${consoleButtonFocusClass} ${
                                gitProvider === p.id
                                  ? 'bg-black text-white border-zinc-900'
                                  : 'bg-white text-zinc-500 border-zinc-200 hover:bg-zinc-100'
                              }`}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                        <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                          <GitBranch className="h-3 w-3" />
                          Select a provider to connect and import a repository.
                        </p>
                        {gitProvider === 'gitea' && (
                          <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                            Gitea OAuth is not configured. Please ask an administrator to set it up.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}

                {sourceChoice === 'blank' && (
                  <div className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/60 p-4">
                    <label htmlFor="onb-ws-name" className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
                      Workspace name
                    </label>
                    <input
                      id="onb-ws-name"
                      type="text"
                      value={newProjectName}
                      onChange={(e) => setNewProjectName(e.target.value)}
                      placeholder="my-workspace"
                      autoFocus
                      className={consoleInputClass}
                    />
                    <p className="text-[11px] text-zinc-500">
                      A workspace is an isolated environment that stores your project files and session history.
                    </p>
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Step 2: agent selection */}
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900">Select an agent</h3>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    You can create or switch agents anytime after entering the workspace.
                  </p>
                </div>

                {/* Workspace summary */}
                <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs">
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                  <span className="text-zinc-500">Workspace:</span>
                  <span className="truncate font-medium text-zinc-900">{workspaceName}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{workspaceKind}</span>
                </div>

                <div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                    Built-in agents
                  </span>
                  {sortedAgents.length === 0 ? (
                    <div className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Loading agents…
                    </div>
                  ) : (
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {sortedAgents.map((a) => {
                        const selected = !customImageId && a.id === selectedAgentId;
                        return (
                          <button
                            key={a.id}
                            type="button"
                            onClick={() => selectBuiltInAgent(a.id)}
                            className={`flex flex-col gap-1 rounded-lg border-2 p-3 text-left transition-colors ${consoleButtonFocusClass} ${
                              selected
                                ? 'border-black bg-zinc-50'
                                : 'border-zinc-200 hover:border-zinc-400 bg-white'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="truncate text-sm font-semibold text-zinc-900">{a.name}</span>
                              {selected && <Check className="h-3.5 w-3.5 shrink-0 text-black" />}
                            </div>
                            <span className="truncate font-mono text-[10px] text-zinc-500">{agentSubtitle(a)}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {customImages && customImages.length > 0 && (
                  <div>
                    <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                      Custom images
                    </span>
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {customImages.map((img) => {
                        const selected = customImageId === img.id;
                        return (
                          <button
                            key={img.id}
                            type="button"
                            onClick={() => selectCustomImage(img)}
                            className={`flex flex-col gap-1 rounded-lg border-2 p-3 text-left transition-colors ${consoleButtonFocusClass} ${
                              selected
                                ? 'border-black bg-zinc-50'
                                : 'border-zinc-200 hover:border-zinc-400 bg-white'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="truncate text-sm font-semibold text-zinc-900">{img.name}</span>
                              {selected && <Check className="h-3.5 w-3.5 shrink-0 text-black" />}
                            </div>
                            <span className="truncate text-[10px] text-zinc-500">Custom image</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {launchError && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                    {launchError}
                  </p>
                )}
              </>
            )}
          </div>

          {/* Card footer */}
          <div className="shrink-0 border-t border-zinc-200 bg-zinc-50/80 px-6 py-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={showBack ? () => setStep(1) : onClose}
              className={`${buttonClass('secondary', 'sm')} ${consoleButtonFocusClass}`}
            >
              {showBack ? (
                <>
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Back
                </>
              ) : 'Cancel'}
            </button>

            {step === 1 && !isSession ? (
              <button
                type="button"
                onClick={handleNext}
                disabled={!canAdvanceStep1}
                className={`${buttonClass('primary', 'sm')} ${consoleButtonFocusClass}`}
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStart}
                disabled={launching || !selectedAgentId}
                className={`${buttonClass('primary', 'sm')} ${consoleButtonFocusClass}`}
              >
                {launching ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Starting…
                  </>
                ) : (
                  <>
                    <Plus className="h-3.5 w-3.5" />
                    Start agent
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Nested RepoImportDialog (centered modal, reuses existing component) */}
      {step === 1 && !isSession && gitImportMode && !importedProject && gitProvider && gitProvider !== 'gitea' && (
        <RepoImportDialog
          key={gitProvider}
          open={true}
          forceProvider={gitProvider}
          onClose={() => { setGitImportMode(false); setGitProvider(''); }}
          onImported={onRepoImported}
          fetchWorkspaces={fetchWorkspaces}
        />
      )}
    </div>
  );
}
