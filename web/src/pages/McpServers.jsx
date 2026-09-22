import { Component, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2, Pencil, Plug, Plus, Power, RefreshCw, Sparkles, Trash2 } from 'lucide-react';

import Button from '../components/Button';
import Input from '../components/Input';
import PageHeader from '../components/PageHeader';
import RowActionsMenu from '../components/RowActionsMenu';
import SelectMenu from '../components/SelectMenu';
import StatusBadge from '../components/StatusBadge';
import {
  ConsoleDialogShell,
  ConsoleStructuredDialogHeader,
  ConsoleStructuredDialogBody,
  ConsoleStructuredDialogFooter,
} from '../components/ConsoleDialog';
import { confirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { apiFetch } from '../lib/api';
import { cn } from '../lib/utils';
import {
  consoleAdminPageClass,
  consoleAdminTableScrollClass,
  consoleTableHeadBandClass,
  consoleAdminTableShellClass,
  consoleIconButtonClass,
  consoleStructuredDialogPanelClass,
  consoleTableBodyCellClass,
  consoleTableHeadCellClass,
  consoleTableHeadRowClass,
  consoleButtonFocusClass,
} from '../lib/consoleTokens';

/**
 * Local error boundary: the app has no global one, so a render error here would
 * blank the whole console. Surface it instead of "crashing".
 */
class McpErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[mcp] page crashed', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p className="font-medium">MCP 页面渲染出错 / Failed to render the MCP page</p>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs">
            {String(this.state.error?.message || this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const EMPTY_FORM = {
  id: null,
  presetId: null,
  inputValues: {},
  name: '',
  description: '',
  commandLine: '',
  envText: '',
  projectId: '',
};

/** Split a command line into argv, honouring simple quoting. */
function splitCommandLine(text) {
  const out = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < String(text || '').length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < text.length) { current += text[i + 1]; i += 1; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started || current) { out.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
  }
  if (started || current) out.push(current);
  return out;
}

function parseCommandLine(text) {
  const parts = splitCommandLine(text);
  return { command: parts[0] || '', args: parts.slice(1) };
}

function formatCommandLine(command, args) {
  const quote = (value) => {
    const s = String(value ?? '');
    return /[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
  };
  return [command, ...(Array.isArray(args) ? args : [])]
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map(quote)
    .join(' ');
}

function envToText(env) {
  return Object.entries(env || {}).map(([key, value]) => `${key}=${value}`).join('\n');
}

function textToEnv(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function McpServersPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [servers, setServers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [presets, setPresets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [form, setForm] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [supportedAgents, setSupportedAgents] = useState([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [serversRes, projectsRes, presetsRes] = await Promise.all([
        apiFetch('/api/v1/mcp-servers'),
        apiFetch('/api/v1/projects'),
        apiFetch('/api/v1/mcp-servers/presets'),
      ]);
      const serversData = await serversRes.json().catch(() => ({}));
      const projectsData = await projectsRes.json().catch(() => ({}));
      const presetsData = await presetsRes.json().catch(() => ({}));
      if (!serversRes.ok) throw new Error(serversData.error || t('mcp:error.load'));
      setServers(serversData.servers || []);
      const list = projectsData.projects || (Array.isArray(projectsData) ? projectsData : []);
      setProjects(list);
      setPresets(presetsData.presets || []);
      setSupportedAgents(presetsData.supported_agents || []);
    } catch (err) {
      setError(err.message || t('mcp:error.load'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const projectOptions = useMemo(
    () => [{ value: '', label: t('mcp:field.scope_global') }]
      .concat(projects.map((p) => ({ value: p.id, label: p.name || p.id }))),
    [projects, t],
  );

  const projectNameById = useMemo(() => {
    const map = {};
    for (const p of projects) map[p.id] = p.name || p.id;
    return map;
  }, [projects]);

  const activePreset = useMemo(
    () => (form?.presetId ? presets.find((p) => p.id === form.presetId) || null : null),
    [form?.presetId, presets],
  );

  const presetDesc = (preset) => t(`mcp:presets.${preset.id}.desc`, { defaultValue: preset.description });

  // --- dialogs -------------------------------------------------------------

  const openPicker = () => setPickerOpen(true);

  const pickPreset = (preset) => {
    setTestResult(null);
    const inputValues = {};
    for (const input of preset.inputs || []) inputValues[input.key] = input.default || '';
    setForm({
      ...EMPTY_FORM,
      presetId: preset.id,
      inputValues,
      name: preset.name,
      commandLine: formatCommandLine(preset.command, preset.args),
      envText: '',
    });
    setPickerOpen(false);
  };

  const openCustom = () => {
    setTestResult(null);
    setForm({ ...EMPTY_FORM });
    setPickerOpen(false);
  };

  const openEdit = (server) => { setTestResult(null); setForm({
    ...EMPTY_FORM,
    id: server.id,
    name: server.name,
    description: server.description || '',
    commandLine: formatCommandLine(server.command, server.args),
    envText: envToText(server.env),
    projectId: server.project_id || '',
  }); };

  const setInputValue = (key, value) => setForm((prev) => ({
    ...prev,
    inputValues: { ...prev.inputValues, [key]: value },
  }));

  const handleSave = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) {
      showToast('error', t('mcp:error.name_required'));
      return;
    }
    const usePreset = Boolean(form.presetId);
    if (usePreset) {
      const missing = (activePreset?.inputs || [])
        .filter((i) => i.required && !String(form.inputValues[i.key] ?? '').trim());
      if (missing.length > 0) {
        showToast('error', t('mcp:error.missing_required'));
        return;
      }
    } else if (!form.commandLine.trim()) {
      showToast('error', t('mcp:error.command_required'));
      return;
    }

    setSaving(true);
    try {
      const { command, args } = parseCommandLine(form.commandLine);
      const payload = usePreset
        ? {
          name,
          description: form.description.trim(),
          preset_id: form.presetId,
          input_values: form.inputValues,
          project_id: form.projectId || null,
        }
        : {
          name,
          description: form.description.trim(),
          transport: 'stdio',
          command,
          args,
          env: textToEnv(form.envText),
          project_id: form.projectId || null,
        };
      const res = await apiFetch(
        form.id ? `/api/v1/mcp-servers/${form.id}` : '/api/v1/mcp-servers',
        { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('mcp:error.save'));
      showToast('success', t(form.id ? 'mcp:updated_toast' : 'mcp:created_toast', { name }));
      setForm(null);
      load();
    } catch (err) {
      showToast('error', err.message || t('mcp:error.save'));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!form) return;
    const usePreset = Boolean(form.presetId);
    const payload = usePreset
      ? { preset_id: form.presetId, input_values: form.inputValues }
      : { ...parseCommandLine(form.commandLine), env: textToEnv(form.envText) };
    if (!usePreset && !payload.command) {
      showToast('error', t('mcp:error.command_required'));
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiFetch('/api/v1/mcp-servers/test', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('mcp:error.test'));
      setTestResult(data);
    } catch (err) {
      setTestResult({ ok: false, error: err.message || t('mcp:error.test') });
    } finally {
      setTesting(false);
    }
  };

  const handleToggle = async (server) => {
    setBusyId(server.id);
    try {
      const res = await apiFetch(`/api/v1/mcp-servers/${server.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !server.enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('mcp:error.save'));
      setServers((prev) => prev.map((s) => (s.id === server.id ? data : s)));
    } catch (err) {
      showToast('error', err.message || t('mcp:error.save'));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (server) => {
    const ok = await confirm({
      title: t('mcp:confirm_delete_title'),
      message: t('mcp:confirm_delete_body', { name: server.name }),
      confirmLabel: t('mcp:delete'),
      variant: 'danger',
    });
    if (!ok) return;
    setBusyId(server.id);
    try {
      const res = await apiFetch(`/api/v1/mcp-servers/${server.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('mcp:error.delete'));
      }
      showToast('success', t('mcp:deleted_toast', { name: server.name }));
      setServers((prev) => prev.filter((s) => s.id !== server.id));
    } catch (err) {
      showToast('error', err.message || t('mcp:error.delete'));
    } finally {
      setBusyId(null);
    }
  };

  // --- render --------------------------------------------------------------

  const renderNeeds = (preset) => (
    (preset?.needs || []).length > 0 ? (
      <span className="flex flex-wrap items-center gap-1">
        {(preset.needs || []).map((need) => (
          <span
            key={need}
            className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500"
          >
            {t(`mcp:need.${need}`, { defaultValue: need })}
          </span>
        ))}
      </span>
    ) : null
  );

  const renderPresetInputs = () => (
    (activePreset?.inputs || []).map((input) => {
      const inputId = `mcp-preset-input-${input.key}`;
      return (
        <div key={input.key} className="space-y-1.5">
          <label htmlFor={inputId} className="flex items-center gap-1.5 text-xs text-zinc-500">
            {input.label}
            {input.required ? <span className="text-red-500">*</span> : null}
            {input.docs_url ? (
              <a
                href={input.docs_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-zinc-400 hover:text-zinc-700"
              >
                {t('mcp:docs')}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </label>
          <Input
            id={inputId}
            autoFocus={input === activePreset.inputs[0]}
            type={input.secret ? 'password' : 'text'}
            value={form.inputValues[input.key] ?? ''}
            onChange={(e) => setInputValue(input.key, e.target.value)}
            placeholder={input.placeholder || ''}
            disabled={saving}
          />
        </div>
      );
    })
  );

  return (
    <div className={consoleAdminPageClass}>
      <PageHeader
        title={t('mcp:title')}
        actions={(
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className={consoleIconButtonClass}
              title={t('mcp:refresh')}
              aria-label={t('mcp:refresh')}
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} strokeWidth={1.75} />
            </button>
            <Button size="sm" onClick={openPicker}>
              <Plus className="h-3.5 w-3.5" />
              {t('mcp:new')}
            </Button>
          </div>
        )}
      />

      <div className={consoleAdminTableShellClass}>
        <div className={consoleTableHeadBandClass}>
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <colgroup>
              <col />
              <col className="w-1/4" />
              <col className="w-1/5" />
              <col className="w-20" />
            </colgroup>
            <thead>
              <tr className={consoleTableHeadRowClass}>
                <th className={consoleTableHeadCellClass}>{t('mcp:table.name')}</th>
                <th className={consoleTableHeadCellClass}>{t('mcp:table.scope')}</th>
                <th className={consoleTableHeadCellClass}>{t('mcp:table.status')}</th>
                <th className={consoleTableHeadCellClass}>{t('common:table.actions')}</th>
              </tr>
            </thead>
          </table>
        </div>
        <div className={consoleAdminTableScrollClass}>
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <colgroup>
              <col />
              <col className="w-1/4" />
              <col className="w-1/5" />
              <col className="w-20" />
            </colgroup>
            <tbody className="divide-y divide-zinc-100">
              {loading && servers.length === 0 ? (
                <tr>
                  <td className={cn(consoleTableBodyCellClass, 'text-zinc-400')} colSpan={4}>
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t('mcp:loading')}
                    </span>
                  </td>
                </tr>
              ) : servers.length === 0 ? (
                <tr>
                  <td className={cn(consoleTableBodyCellClass, 'text-zinc-400')} colSpan={4}>
                    {error || t('mcp:empty')}
                  </td>
                </tr>
              ) : servers.map((server) => (
                <tr key={server.id}>
                  <td className={cn(consoleTableBodyCellClass, 'font-medium text-zinc-900')}>
                    <span className="flex items-center gap-1.5">
                      <Plug className="h-3.5 w-3.5 shrink-0 text-zinc-400" strokeWidth={1.75} />
                      <span className="truncate" title={server.name}>{server.name}</span>
                    </span>
                    {server.description ? (
                      <span className="mt-0.5 block truncate text-[11px] font-normal text-zinc-400" title={server.description}>
                        {server.description}
                      </span>
                    ) : null}
                  </td>
                  <td className={cn(consoleTableBodyCellClass, 'text-zinc-500')}>
                    {server.project_id
                      ? (projectNameById[server.project_id] || server.project_id)
                      : t('mcp:field.scope_global')}
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <StatusBadge
                      tone={server.enabled ? 'success' : 'neutral'}
                      label={server.enabled ? t('mcp:enabled') : t('mcp:disabled')}
                    />
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <RowActionsMenu
                      label={`${t('mcp:actions_for')} ${server.name}`}
                      items={[
                        { icon: Pencil, label: t('mcp:edit'), onClick: () => openEdit(server) },
                        {
                          icon: Power,
                          label: server.enabled ? t('mcp:disable') : t('mcp:enable'),
                          onClick: () => handleToggle(server),
                          busy: busyId === server.id,
                          busyLabel: t('mcp:saving'),
                        },
                        { separator: true },
                        {
                          icon: Trash2,
                          label: t('mcp:delete'),
                          danger: true,
                          onClick: () => handleDelete(server),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Template picker: one click, then usually one token. */}
      {pickerOpen && (
        <ConsoleDialogShell onClose={() => setPickerOpen(false)} fitContent>
          <div className={cn(consoleStructuredDialogPanelClass, 'min-w-[520px] max-w-2xl')}>
            <ConsoleStructuredDialogHeader title={t('mcp:choose_preset')} />
            <ConsoleStructuredDialogBody>
              <div className="grid grid-cols-2 gap-2">
                {presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => pickPreset(preset)}
                    className={cn(
                      'flex flex-col items-start gap-1 rounded-lg border border-zinc-200 p-3 text-left transition-colors hover:border-zinc-400 hover:bg-zinc-50',
                      consoleButtonFocusClass,
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-medium text-zinc-900">
                      <Plug className="h-3.5 w-3.5 text-zinc-400" strokeWidth={1.75} />
                      {preset.name}
                    </span>
                    <span className="text-xs text-zinc-500">{presetDesc(preset)}</span>
                    {renderNeeds(preset)}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={openCustom}
                  className={cn(
                    'flex flex-col items-start gap-1 rounded-lg border border-dashed border-zinc-300 p-3 text-left transition-colors hover:border-zinc-400 hover:bg-zinc-50',
                    consoleButtonFocusClass,
                  )}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium text-zinc-900">
                    <Sparkles className="h-3.5 w-3.5 text-zinc-400" strokeWidth={1.75} />
                    {t('mcp:custom')}
                  </span>
                  <span className="text-xs text-zinc-500">{t('mcp:custom_desc')}</span>
                </button>
              </div>
            </ConsoleStructuredDialogBody>
            <ConsoleStructuredDialogFooter>
              <div className="flex w-full justify-end">
                <Button variant="secondary" size="sm" onClick={() => setPickerOpen(false)}>
                  {t('common:action.cancel')}
                </Button>
              </div>
            </ConsoleStructuredDialogFooter>
          </div>
        </ConsoleDialogShell>
      )}

      {form && (
        <ConsoleDialogShell onClose={() => (saving ? null : setForm(null))} fitContent>
          <div className={cn(consoleStructuredDialogPanelClass, 'min-w-[460px] max-w-lg')}>
            <ConsoleStructuredDialogHeader
              title={t(form.id ? 'mcp:edit_title' : 'mcp:create_title')}
            />
            <ConsoleStructuredDialogBody>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="mcp-field-name" className="text-xs text-zinc-500">{t('mcp:field.name')}</label>
                  <Input
                    id="mcp-field-name"
                    autoFocus={!activePreset}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder={t('mcp:field.name_placeholder')}
                    maxLength={64}
                    disabled={saving}
                  />
                </div>

                {activePreset ? (
                  renderPresetInputs()
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <label htmlFor="mcp-field-desc" className="text-xs text-zinc-500">{t('mcp:field.description')}</label>
                      <Input
                        id="mcp-field-desc"
                        value={form.description}
                        onChange={(e) => setForm({ ...form, description: e.target.value })}
                        maxLength={500}
                        disabled={saving}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="mcp-field-command" className="text-xs text-zinc-500">{t('mcp:field.command_line')}</label>
                      <Input
                        id="mcp-field-command"
                        value={form.commandLine}
                        onChange={(e) => setForm({ ...form, commandLine: e.target.value })}
                        placeholder={t('mcp:field.command_placeholder')}
                        className="font-mono text-xs"
                        disabled={saving}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="mcp-field-env" className="text-xs text-zinc-500">{t('mcp:field.env')}</label>
                      <textarea
                        id="mcp-field-env"
                        value={form.envText}
                        onChange={(e) => setForm({ ...form, envText: e.target.value })}
                        placeholder={t('mcp:field.env_placeholder')}
                        rows={3}
                        disabled={saving}
                        className="w-full rounded-md border border-zinc-200 px-3 py-2 font-mono text-xs text-zinc-900 focus:border-zinc-400 focus:outline-none"
                      />
                      <p className="text-[11px] text-zinc-400">{t('mcp:field.env_hint')}</p>
                    </div>
                  </>
                )}

                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-500">{t('mcp:field.scope')}</label>
                  <SelectMenu
                    value={form.projectId}
                    onChange={(v) => setForm({ ...form, projectId: v })}
                    options={projectOptions}
                    disabled={saving}
                    maxHeight={220}
                  />
                </div>

                {testResult && (
                  <div className={cn(
                    'rounded-md px-3 py-2 text-xs',
                    testResult.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700',
                  )}>
                    <p className="font-medium">
                      {testResult.ok
                        ? t('mcp:test_ok')
                        : `${t('mcp:test_failed')}${testResult.error ? `：${testResult.error}` : ''}`}
                    </p>
                    {!testResult.ok && testResult.output ? (
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] opacity-80">
                        {testResult.output}
                      </pre>
                    ) : null}
                  </div>
                )}

                {supportedAgents.length > 0 && (
                  <p
                    className="text-[11px] text-zinc-400"
                    title={supportedAgents.map((a) => a.name).join(' / ')}
                  >
                    {t('mcp:supported_agents_count', { count: supportedAgents.length })}
                  </p>
                )}
              </div>
            </ConsoleStructuredDialogBody>
            <ConsoleStructuredDialogFooter>
              <div className="flex w-full items-center justify-between gap-2">
                {form.presetId && !form.id ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => { setForm(null); setPickerOpen(true); }}
                    disabled={saving}
                  >
                    {t('mcp:back')}
                  </Button>
                ) : <span />}
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={handleTest} disabled={saving || testing}>
                    {testing ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {t('mcp:testing')}
                      </>
                    ) : t('mcp:test')}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setForm(null)} disabled={saving}>
                    {t('common:action.cancel')}
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={saving}>
                    {saving ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {t('mcp:saving')}
                      </>
                    ) : t('common:action.save')}
                  </Button>
                </div>
              </div>
            </ConsoleStructuredDialogFooter>
          </div>
        </ConsoleDialogShell>
      )}
    </div>
  );
}

export default function McpServers() {
  return (
    <McpErrorBoundary>
      <McpServersPage />
    </McpErrorBoundary>
  );
}
