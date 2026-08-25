import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Settings2, Play, Square, RotateCw, RefreshCw, Loader2, Pencil, Trash2, Activity, List, CheckCircle, XCircle, Clock, Search } from 'lucide-react';
import Button from '../Button';
import Input, { FormLabel, Textarea } from '../Input';
import MaskedApiKeyInput from '../MaskedApiKeyInput';
import RowActionsMenu from '../RowActionsMenu';
import StatusBadge from '../StatusBadge';
import {
  ConsoleDialogShell,
  ConsoleStructuredDialogBody,
  ConsoleStructuredDialogFooter,
  ConsoleStructuredDialogHeader,
} from '../ConsoleDialog';
import { useToast } from '../Toast';
import {
  consoleCardClass,
  consoleIconButtonClass,
  consoleStructuredDialogPanelClass,
  consoleTableBodyCellClass,
  consoleTableBodyDivideClass,
  consoleTableBodyRowClass,
  consoleTableHeadCellClass,
  consoleTableHeadRowClass,
  consoleTableShellClass,
} from '../../lib/consoleTokens';

import { apiFetch } from '../../lib/api';

const NESTED_DIALOG_BACKDROP = 'z-[110]';
const NESTED_DIALOG_SHELL =
  'fixed inset-0 z-[111] flex items-center justify-center p-4 pointer-events-none';

const EMPTY_PROVIDER = {
  name: '',
  base_url: '',
  api_key: '',
  default_model: '',
  models: '',
};

function modelsToText(models) {
  return Array.isArray(models) ? models.join('\n') : '';
}

function textToModels(text) {
  return text
    .split(/[\n,]+/)
    .map((m) => m.trim())
    .filter(Boolean);
}

function splitBindAddr(bindAddr) {
  const trimmed = String(bindAddr || '').trim();
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon <= 0) return { host: '127.0.0.1', port: '8741' };
  return {
    host: trimmed.slice(0, lastColon),
    port: trimmed.slice(lastColon + 1),
  };
}

function connectionIconColor(health, testing) {
  if (testing || health?.status === 'testing') return 'text-zinc-500';
  if (health?.status === 'ok') return 'text-green-600';
  if (health?.status === 'error') return 'text-red-600';
  return 'text-zinc-500';
}

function TestConnectionButton({
  health,
  testing,
  disabled,
  onClick,
  iconClassName = 'w-3.5 h-3.5',
  title = 'Verify provider',
}) {
  const busy = testing || health?.status === 'testing';
  const label = busy ? 'Verifying provider' : title;
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
      className={`${consoleIconButtonClass} ${connectionIconColor(health, testing)}`}
      title={label}
      aria-label={label}
    >
      {busy ? (
        <Loader2 className={`${iconClassName} animate-spin`} />
      ) : (
        <Activity className={iconClassName} />
      )}
    </button>
  );
}

function FetchModelsButton({ fetching, disabled, onClick, iconClassName = 'w-3.5 h-3.5' }) {
  const label = fetching ? 'Fetching models' : 'Fetch models';
  return (
    <button
      type="button"
      disabled={disabled || fetching}
      onClick={onClick}
      className={`${consoleIconButtonClass} text-zinc-600`}
      title={label}
      aria-label={label}
    >
      {fetching ? (
        <Loader2 className={`${iconClassName} animate-spin`} />
      ) : (
        <List className={iconClassName} />
      )}
    </button>
  );
}

function formatTestTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function ProviderStatusBadge({ health }) {
  const status = health?.status || 'unknown';
  const testedAt = formatTestTime(health?.tested_at);
  const detailTitle = [
    health?.message,
    health?.latency_ms != null ? `Latency: ${health.latency_ms}ms` : null,
    testedAt && `Verified at ${testedAt}`,
  ].filter(Boolean).join('\n');

  let label = 'Not verified';
  let tone = 'neutral';
  let icon = Clock;
  let spinning = false;

  if (status === 'testing') {
    label = 'Verifying…';
    tone = 'info';
    spinning = true;
  } else if (status === 'ok') {
    label = 'Available';
    tone = 'success';
    icon = CheckCircle;
  } else if (status === 'error') {
    label = 'Unavailable';
    tone = 'danger';
    icon = XCircle;
  }

  return (
    <StatusBadge
      tone={tone}
      icon={icon}
      spinning={spinning}
      label={label}
      title={detailTitle || undefined}
    />
  );
}

function resolveFormTestModel(form) {
  const fromDefault = String(form.default_model || '').trim();
  if (fromDefault) return fromDefault;
  return textToModels(form.models)[0] || '';
}

function usesSavedApiKey(dialog) {
  return Boolean(dialog?.mode === 'edit' && dialog.apiKeySaved && !dialog.apiKeyDirty);
}

function getEffectiveApiKey(dialog) {
  if (!dialog) return '';
  if (dialog.apiKeyRevealed && dialog.apiKeyFull) return String(dialog.apiKeyFull).trim();
  return String(dialog.form?.api_key || '').trim();
}

function hasApiKeyForActions(dialog) {
  if (!dialog) return false;
  if (usesSavedApiKey(dialog)) return true;
  return Boolean(getEffectiveApiKey(dialog));
}

async function fetchSavedApiKey(name) {
  const res = await apiFetch(`/api/v1/admin/gateway/providers/${encodeURIComponent(name)}/api-key`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to load API Key.');
  }
  return String(data.data?.api_key || '').trim();
}

function ProviderFormFields({
  form,
  onChange,
  isEdit,
  apiKeyMasked,
  apiKeyRevealed,
  apiKeyCanToggle,
  onApiKeyChange,
  onToggleApiKeyReveal,
  hasApiKey,
  onFetchModels,
  fetchingModels,
  onTestConnection,
  testingConnection,
  connectionHealth,
}) {
  return (
    <div className={`${consoleCardClass} bg-zinc-50/70 p-4 space-y-4`}>
      {!isEdit && (
        <div className="space-y-2">
          <FormLabel htmlFor="provider-name">Name<span className="text-red-500 ml-0.5">*</span></FormLabel>
          <Input
            id="provider-name"
            value={form.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="deepseek"
            className="h-9 min-h-9 py-1.5"
          />
        </div>
      )}
      <div className="space-y-2">
        <FormLabel htmlFor="provider-base-url">Base URL<span className="text-red-500 ml-0.5">*</span></FormLabel>
        <Input
          id="provider-base-url"
          value={form.base_url}
          onChange={(e) => onChange({ base_url: e.target.value })}
          placeholder="https://api.deepseek.com"
          className="h-9 min-h-9 py-1.5 font-mono"
        />
      </div>
      <div className="space-y-2">
        <FormLabel htmlFor="provider-api-key">API Key<span className="text-red-500 ml-0.5">*</span></FormLabel>
        <MaskedApiKeyInput
          value={form.api_key}
          maskedPreview={apiKeyMasked}
          revealed={apiKeyRevealed}
          canToggle={apiKeyCanToggle}
          onToggleReveal={onToggleApiKeyReveal}
          onChange={onApiKeyChange}
          placeholder="sk-…"
          aria-label="API Key"
        />
      </div>
      <div className="space-y-2">
        <FormLabel htmlFor="provider-default-model">Default model</FormLabel>
        <Input
          id="provider-default-model"
          value={form.default_model}
          onChange={(e) => onChange({ default_model: e.target.value })}
          placeholder="deepseek-chat"
          className="h-9 min-h-9 py-1.5 font-mono"
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <FormLabel htmlFor="provider-models" className="mb-0">Models</FormLabel>
          <div className="flex shrink-0 items-center gap-0.5">
            <TestConnectionButton
              health={connectionHealth}
              testing={testingConnection}
              disabled={
                !form.base_url.trim()
                || !hasApiKey
                || !resolveFormTestModel(form)
              }
              onClick={onTestConnection}
            />
            <FetchModelsButton
              fetching={fetchingModels}
              disabled={!form.base_url.trim() || !hasApiKey}
              onClick={onFetchModels}
            />
          </div>
        </div>
        <Textarea
          id="provider-models"
          value={form.models}
          onChange={(e) => onChange({ models: e.target.value })}
          rows={4}
          placeholder={'deepseek-chat\ndeepseek-reasoner'}
          className="font-mono min-h-[5rem]"
        />
        <p className="text-xs text-zinc-500">One model ID per line.</p>
      </div>
    </div>
  );
}

export default function GatewaySettingsPanel() {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [status, setStatus] = useState(null);
  const [processConfig, setProcessConfig] = useState({
    host: '127.0.0.1',
    port: '8741',
    auto_start: true,
    public_url: '',
    upstream_url: '',
  });
  const [envBindLocked, setEnvBindLocked] = useState(false);
  const [providers, setProviders] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [refreshingProviders, setRefreshingProviders] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [processSaving, setProcessSaving] = useState(false);
  const [processAction, setProcessAction] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [processDialogOpen, setProcessDialogOpen] = useState(false);
  const [processDraft, setProcessDraft] = useState(null);
  const [providerDialog, setProviderDialog] = useState(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [providerHealth, setProviderHealth] = useState({});
  const [testingProvider, setTestingProvider] = useState(null);
  const [formConnectionHealth, setFormConnectionHealth] = useState({ status: 'unknown' });

  

  const nestedDialogOpen = processDialogOpen || Boolean(providerDialog);

  useEffect(() => {
    if (!nestedDialogOpen) return;
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      setProcessDialogOpen(false);
      setProviderDialog(null);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [nestedDialogOpen]);

  const loadData = useCallback(async () => {
    
    setLoading(true);
    try {
      const [statusRes, configRes, providersRes] = await Promise.all([
        apiFetch('/api/v1/admin/gateway/status'),
        apiFetch('/api/v1/admin/gateway/config'),
        apiFetch('/api/v1/admin/gateway/providers'),
      ]);
      const statusData = await statusRes.json();
      const configData = configRes.ok ? await configRes.json() : null;
      const providersData = providersRes.ok ? await providersRes.json() : null;
      setStatus(statusData);
      if (configData) {
        const { host, port } = splitBindAddr(configData.bind_addr || statusData.bindAddr);
        setProcessConfig({
          host,
          port,
          auto_start: configData.auto_start !== false,
          public_url: configData.public_url || configData.control_plane_public_url || '',
          upstream_url: configData.upstream_url || configData.gateway_upstream_url || '',
        });
        setEnvBindLocked(Boolean(configData.env_bind_locked));
      } else if (statusData.bindAddr) {
        const { host, port } = splitBindAddr(statusData.bindAddr);
        setProcessConfig((prev) => ({ ...prev, host, port }));
      }
      const providers = providersData?.data || [];
      setProviders(providers);
      const initialHealth = {};
      for (const p of providers) {
        if (p?.last_test && (p.last_test.status === 'ok' || p.last_test.status === 'error')) {
          initialHealth[p.name] = {
            status: p.last_test.status,
            message: p.last_test.message,
            latency_ms: p.last_test.latency_ms,
            tested_at: p.last_test.tested_at,
          };
        }
      }
      setProviderHealth((prev) => ({ ...prev, ...initialHealth }));
    } catch {
      showToast('error', 'Failed to load gateway settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshProviders = useCallback(async () => {
    setRefreshingProviders(true);
    try {
      const providersRes = await apiFetch('/api/v1/admin/gateway/providers');
      const providersData = providersRes.ok ? await providersRes.json() : null;
      setProviders(providersData?.data || []);
    } catch {
      // silent — keep current list on refresh failure
    } finally {
      setRefreshingProviders(false);
    }
  }, []);

  const filteredProviders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((p) => (p.name || '').toLowerCase().includes(q));
  }, [providers, searchQuery]);

  const runProviderTest = useCallback(async (name, { silent = false } = {}) => {
    if (!name) return null;
    setProviderHealth((prev) => ({
      ...prev,
      [name]: { status: 'testing' },
    }));
    setTestingProvider(name);
    try {
      const res = await apiFetch(`/api/v1/admin/gateway/providers/${encodeURIComponent(name)}/test`, {
        method: 'POST',
        
        body: '{}',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || data.message || data.error || t('gateway:error.verify_failed'));
      }
      const result = data.data || {};
      const next = {
        status: result.ok ? 'ok' : 'error',
        message: result.message,
        latency_ms: result.latency_ms,
        tested_at: Date.now(),
      };
      setProviderHealth((prev) => ({ ...prev, [name]: next }));
      if (!silent) {
        showToast(result.ok ? 'success' : 'error', result.message || (result.ok ? 'Provider available.' : 'Provider unavailable.'));
      }
      return next;
    } catch (err) {
      const next = { status: 'error', message: err.message, tested_at: Date.now() };
      setProviderHealth((prev) => ({ ...prev, [name]: next }));
      if (!silent) showToast('error', err.message);
      return next;
    } finally {
      setTestingProvider((current) => (current === name ? null : current));
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const openProcessDialog = () => {
    setProcessDraft({ ...processConfig });
    setProcessDialogOpen(true);
  };

  const openAddProviderDialog = async () => {
    try {
      const statusRes = await apiFetch('/api/v1/admin/gateway/status');
      const statusData = await statusRes.json();
      setStatus(statusData);
    } catch {
      /* keep current status */
    }
    setProviderDialog({
      mode: 'add',
      apiKeySaved: false,
      apiKeyMasked: '',
      apiKeyRevealed: false,
      apiKeyDirty: false,
      apiKeyFull: null,
      form: { ...EMPTY_PROVIDER },
    });
    setFormConnectionHealth({ status: 'unknown' });
  };

  const openEditProviderDialog = (provider) => {
    setFormConnectionHealth(providerHealth[provider.name] || { status: 'unknown' });
    setProviderDialog({
      mode: 'edit',
      apiKeySaved: Boolean(provider.has_api_key),
      apiKeyMasked: provider.api_key_masked || '',
      apiKeyRevealed: false,
      apiKeyDirty: false,
      apiKeyFull: null,
      form: {
        name: provider.name,
        base_url: provider.base_url || '',
        api_key: '',
        default_model: provider.default_model || '',
        models: modelsToText(provider.models),
      },
    });
  };

  const updateProviderForm = (patch) => {
    setProviderDialog((prev) => (prev ? { ...prev, form: { ...prev.form, ...patch } } : prev));
  };

  const handleApiKeyChange = (nextValue) => {
    setProviderDialog((prev) => {
      if (!prev) return prev;
      const replacingSaved = usesSavedApiKey(prev);
      return {
        ...prev,
        apiKeyDirty: true,
        apiKeyRevealed: true,
        apiKeyMasked: replacingSaved ? '' : prev.apiKeyMasked,
        apiKeyFull: nextValue,
        form: { ...prev.form, api_key: nextValue },
      };
    });
  };

  const handleToggleApiKeyReveal = async () => {
    if (!providerDialog) return;
    if (providerDialog.apiKeyRevealed) {
      setProviderDialog((prev) => (prev ? { ...prev, apiKeyRevealed: false } : prev));
      return;
    }
    if (usesSavedApiKey(providerDialog) && !providerDialog.apiKeyFull) {
      try {
        const name = providerDialog.form.name.trim();
        const res = await apiFetch(`/api/v1/admin/gateway/providers/${encodeURIComponent(name)}/api-key`);
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || t('gateway:error.load_key_failed'));
        }
        const apiKey = data.data?.api_key || '';
        setProviderDialog((prev) => (prev ? {
          ...prev,
          apiKeyRevealed: true,
          apiKeyFull: apiKey,
          form: { ...prev.form, api_key: apiKey },
        } : prev));
      } catch (err) {
        showToast('error', err.message);
      }
      return;
    }
    setProviderDialog((prev) => (prev ? { ...prev, apiKeyRevealed: true } : prev));
  };

  const resolveApiKeyForAction = async () => {
    if (!providerDialog) return '';
    const direct = getEffectiveApiKey(providerDialog);
    if (direct) return direct;
    if (!usesSavedApiKey(providerDialog)) return '';
    const name = providerDialog.form.name.trim();
    const key = await fetchSavedApiKey(name);
    setProviderDialog((prev) => (prev ? { ...prev, apiKeyFull: key } : prev));
    return key;
  };

  const handleTestConnection = async () => {
    if (!providerDialog) return;
    const { form, mode } = providerDialog;
    if (!form.base_url.trim()) {
      showToast('error', 'Base URL is required.');
      return;
    }
    const testModel = resolveFormTestModel(form);
    if (!testModel) {
      showToast('error', 'Default model is required to verify provider.');
      return;
    }
    setTestingConnection(true);
    setFormConnectionHealth({ status: 'testing' });
    try {
      const apiKey = await resolveApiKeyForAction();
      if (!apiKey) {
        setFormConnectionHealth({ status: 'unknown' });
        showToast('error', 'API Key is required to verify provider.');
        return;
      }
      const res = await apiFetch('/api/v1/admin/gateway/providers/test', {
        method: 'POST',
        
        body: JSON.stringify({
          base_url: form.base_url.trim(),
          api_key: apiKey,
          default_model: form.default_model.trim(),
          models: textToModels(form.models),
          model: testModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || t('gateway:error.verify_failed'));
      }
      const result = data.data || {};
      const testedAt = Date.now();
      const next = {
        status: result.ok ? 'ok' : 'error',
        message: result.message,
        latency_ms: result.latency_ms,
        tested_at: testedAt,
      };
      setFormConnectionHealth(next);
      if (mode === 'edit') {
        setProviderHealth((prev) => ({ ...prev, [form.name.trim()]: next }));
      }
      showToast(
        result.ok ? 'success' : 'error',
        result.message || (result.ok ? 'Provider available.' : 'Provider unavailable.'),
      );
    } catch (err) {
      setFormConnectionHealth({ status: 'error', message: err.message, tested_at: Date.now() });
      if (mode === 'edit') {
        setProviderHealth((prev) => ({ ...prev, [form.name.trim()]: { status: 'error', message: err.message, tested_at: Date.now() } }));
      }
      showToast('error', err.message);
    } finally {
      setTestingConnection(false);
    }
  };

  const handleFetchModels = async () => {
    if (!providerDialog) return;
    const { form } = providerDialog;
    if (!form.base_url.trim()) {
      showToast('error', 'Base URL is required.');
      return;
    }
    if (!hasApiKeyForActions(providerDialog)) {
      showToast('error', 'API Key is required to fetch models. Enter it above or fill the list manually.');
      return;
    }
    setFetchingModels(true);
    try {
      const apiKey = await resolveApiKeyForAction();
      if (!apiKey) {
        showToast('error', 'API Key is required to fetch models. Enter it above or fill the list manually.');
        return;
      }
      const res = await apiFetch('/api/v1/admin/gateway/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({
          base_url: form.base_url.trim(),
          api_key: apiKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || t('gateway:error.fetch_models_failed'));
      }
      const models = data.data?.models || [];
      const patch = { models: models.join('\n') };
      if (!form.default_model.trim() && models.length > 0) {
        patch.default_model = models[0];
      }
      updateProviderForm(patch);
      showToast('success', t('gateway:toast.models_fetched', { count: models.length }));
    } catch (err) {
      showToast('error', `${err.message} You can enter models manually.`);
    } finally {
      setFetchingModels(false);
    }
  };

  const upsertProvider = async (body, { isEdit, name, apiKeyDirty }) => {
    const models = textToModels(body.models);
    const payload = {
      name: body.name.trim(),
      base_url: body.base_url.trim(),
      default_model: body.default_model.trim() || models[0] || undefined,
      models: models.length > 0 ? models : undefined,
      service_id: 'default',
    };
    if (apiKeyDirty && body.api_key.trim() && !body.api_key.includes('*')) {
        payload.api_key = body.api_key.trim();
    }

    if (isEdit) {
      if (!payload.api_key) delete payload.api_key;
      delete payload.name;
      delete payload.service_id;
      const res = await apiFetch(`/api/v1/admin/gateway/providers/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        const msg = data.error?.message || data.error || 'Failed to update provider';
        throw new Error(typeof msg === 'string' ? msg : 'Failed to update provider');
      }
      return;
    }

    if (!payload.api_key) {
      throw new Error('API Key is required for new providers.');
    }
    payload.api_key = body.api_key.trim();
    const res = await apiFetch('/api/v1/admin/gateway/providers', {
      method: 'POST',
      
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      const msg = data.error?.message || data.error || 'Failed to save provider';
      throw new Error(typeof msg === 'string' ? msg : 'Failed to save provider');
    }
  };

  const handleSaveProvider = async (e) => {
    e.preventDefault();
    if (!providerDialog) return;
    const { form, mode } = providerDialog;
    const name = form.name.trim();
    if (!name || !form.base_url.trim()) {
      showToast('error', 'Name and Base URL are required.');
      return;
    }
    setSaving(true);
    try {
      await upsertProvider(form, {
        isEdit: mode === 'edit',
        name,
        apiKeyDirty: Boolean(providerDialog.apiKeyDirty),
      });
      setProviderDialog(null);
      await loadData();
      showToast('success', mode === 'edit' ? 'Provider updated.' : 'Provider saved.');
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveProcess = async (e) => {
    e.preventDefault();
    if (!processDraft) return;
    const host = processDraft.host.trim();
    const port = Number.parseInt(processDraft.port, 10);
    if (!host || !Number.isFinite(port) || port < 1 || port > 65535) {
      showToast('error', 'Enter a valid host and port.');
      return;
    }
    setProcessSaving(true);
    try {
      const payload = {
        auto_start: processDraft.auto_start,
        public_url: processDraft.public_url?.trim() || '',
        upstream_url: processDraft.upstream_url?.trim() || '',
      };
      if (!envBindLocked) {
        payload.bind_addr = `${host}:${port}`;
        payload.restart = Boolean(status?.running);
      }
      const res = await apiFetch('/api/v1/admin/gateway/config', {
        method: 'PATCH',
        
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || t('gateway:error.save_settings_failed'));
      }
      setStatus(data);
      if (data.bind_addr) {
        const { host: savedHost, port: savedPort } = splitBindAddr(data.bind_addr);
        setProcessConfig({
          host: savedHost,
          port: savedPort,
          auto_start: data.auto_start !== false,
          public_url: data.public_url || data.control_plane_public_url || '',
          upstream_url: data.upstream_url || data.gateway_upstream_url || '',
        });
      } else {
        setProcessConfig((prev) => ({
          ...prev,
          auto_start: data.auto_start !== false,
        }));
      }
      setProcessDialogOpen(false);
      setProcessDraft(null);
      showToast('success', status?.running ? 'Process settings saved and gateway restarted.' : 'Process settings saved.');
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setProcessSaving(false);
    }
  };

  const runProcessAction = async (action) => {
    setProcessAction(action);
    try {
      const res = await apiFetch(`/api/v1/admin/gateway/${action}`, {
        method: 'POST',
        
        body: action === 'start' ? JSON.stringify({ force: false }) : undefined,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || data.lastError || `Failed to ${action} gateway.`);
      }
      setStatus(data);
      showToast('success', action === 'start' ? 'Gateway started.' : action === 'stop' ? 'Gateway stopped.' : 'Gateway restarted.');
    } catch (err) {
      showToast('error', err.message);
      await loadData();
    } finally {
      setProcessAction(null);
    }
  };

  const handleDelete = async (name) => {
    setDeleting(name);
    try {
      const res = await apiFetch(`/api/v1/admin/gateway/providers/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        const msg = data.error?.message || data.error || 'Failed to delete provider';
        throw new Error(typeof msg === 'string' ? msg : 'Failed to delete provider');
      }
      if (providerDialog?.form?.name === name) setProviderDialog(null);
      await loadData();
      showToast('success', 'Provider removed.');
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setDeleting(null);
    }
  };

  if (loading) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  const agentBaseUrl = status?.llm_proxy_url || status?.baseUrl || `http://${processConfig.host === '0.0.0.0' ? '127.0.0.1' : processConfig.host}:${processConfig.port}/api/v1/llm`;

  return (
    <>
      <div className="space-y-5">
        <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-zinc-600">
                <span className={status?.running ? 'text-green-700 font-medium' : 'text-red-600 font-medium'}>
                  {status?.running ? 'Running' : 'Stopped'}
                </span>
                {' · '}
                <span className="font-mono text-zinc-500">
                  {processConfig.host}:{processConfig.port}
                </span>
              </p>
              <p className="text-xs text-zinc-500 mt-1">
                {t('gateway:agent_proxy_desc')}{' '}
                <span className="font-mono">{agentBaseUrl}</span>
              </p>
              {status?.gateway_upstream_url && (
                <p className="text-xs text-zinc-500 mt-1">
                  Upstream UniGateway:{' '}
                  <span className="font-mono">{status.gateway_upstream_url}</span>
                </p>
              )}
              {status?.lastError && !status?.running && (
                <p className="text-xs text-red-600 mt-1">{status.lastError}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={openProcessDialog}
                className={consoleIconButtonClass}
                title="Configure gateway"
                aria-label="Configure gateway"
              >
                <Settings2 className="w-4 h-4" />
              </button>
              <button
                type="button"
                disabled={status?.running || processAction === 'start'}
                onClick={() => runProcessAction('start')}
                className={consoleIconButtonClass}
                title={processAction === 'start' ? 'Starting…' : 'Start gateway'}
                aria-label={processAction === 'start' ? 'Starting gateway' : 'Start gateway'}
              >
                {processAction === 'start' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
              </button>
              <button
                type="button"
                disabled={!status?.running || processAction === 'stop'}
                onClick={() => runProcessAction('stop')}
                className={consoleIconButtonClass}
                title={processAction === 'stop' ? 'Stopping…' : 'Stop gateway'}
                aria-label={processAction === 'stop' ? 'Stopping gateway' : 'Stop gateway'}
              >
                {processAction === 'stop' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
              </button>
              <button
                type="button"
                disabled={!status?.running || processAction === 'restart'}
                onClick={() => runProcessAction('restart')}
                className={consoleIconButtonClass}
                title={processAction === 'restart' ? 'Restarting…' : 'Restart gateway'}
                aria-label={processAction === 'restart' ? 'Restarting gateway' : 'Restart gateway'}
              >
                {processAction === 'restart' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RotateCw className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between gap-3 mb-5">
            <span className="text-xs text-zinc-500 shrink-0">
              {providers.length} providers
            </span>
            <div className="flex items-center gap-2">
              <div className="relative w-64 shrink-0">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search providers…"
                  className="w-full pl-8"
                />
              </div>
              <button
                type="button"
                onClick={refreshProviders}
                disabled={refreshingProviders}
                className={consoleIconButtonClass}
                title="Refresh"
              >
                {refreshingProviders ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </button>
              <Button type="button" size="md" onClick={openAddProviderDialog}>
                <Plus className="w-4 h-4" />
                Add Provider
              </Button>
            </div>
          </div>
          {filteredProviders.length === 0 ? (
            <p className="text-sm text-zinc-500">
              {providers.length === 0 ? 'No providers yet.' : 'No providers match your search.'}
            </p>
          ) : (
            <div className={consoleTableShellClass}>
              <table className="w-full table-fixed border-collapse text-left text-sm">
                <colgroup>
                  <col className="w-1/5" />
                  <col className="w-1/5" />
                  <col className="w-1/5" />
                  <col className="w-1/5" />
                  <col className="w-48" />
                </colgroup>
                <thead>
                  <tr className={consoleTableHeadRowClass}>
                    <th className={consoleTableHeadCellClass}>Name</th>
                    <th className={consoleTableHeadCellClass}>Endpoint</th>
                    <th className={consoleTableHeadCellClass}>Models</th>
                    <th className={consoleTableHeadCellClass}>Status</th>
                    <th className={`${consoleTableHeadCellClass}`}>Actions</th>
                  </tr>
                </thead>
                <tbody className={consoleTableBodyDivideClass}>
                  {filteredProviders.map((p) => {
                    const models = Array.isArray(p.models) ? p.models.filter(Boolean) : [];
                    const max = 2;
                    return (
                  <tr key={p.name} className={consoleTableBodyRowClass}>
                    <td className={`${consoleTableBodyCellClass} min-w-0`}>
                      <div
                        className="font-medium text-zinc-900 truncate"
                        title={p.name}
                      >
                        {p.name}
                      </div>
                    </td>
                    <td className={`${consoleTableBodyCellClass} min-w-0`}>
                      {p.base_url ? (
                        <span className="block truncate font-mono text-xs text-zinc-600" title={p.base_url}>
                          {p.base_url}
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-400">—</span>
                      )}
                    </td>
                    <td className={`${consoleTableBodyCellClass} min-w-0`}>
                      {models.length === 0 ? (
                        <span className="text-xs text-zinc-400">No models</span>
                      ) : models.length <= max ? (
                        <div className="flex flex-wrap gap-1">
                          {models.map((m, i) => (
                            <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-zinc-100 text-zinc-700">{m}</span>
                          ))}
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {models.slice(0, max).map((m, i) => (
                            <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-zinc-100 text-zinc-700">{m}</span>
                          ))}
                          <span className="text-xs text-zinc-400" title={models.slice(max).join(', ')}>
                            +{models.length - max} more
                          </span>
                        </div>
                      )}
                    </td>
                    <td className={`${consoleTableBodyCellClass} align-middle`}>
                      <ProviderStatusBadge health={providerHealth[p.name]} />
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <RowActionsMenu
                        label={`Actions for ${p.name}`}
                        items={[
                          {
                            icon: Activity,
                            label: 'Test connection',
                            onClick: () => runProviderTest(p.name),
                            busy: testingProvider === p.name || providerHealth[p.name]?.status === 'testing',
                            busyLabel: 'Verifying…',
                          },
                          { icon: Pencil, label: 'Edit', onClick: () => openEditProviderDialog(p) },
                          { separator: true },
                          {
                            icon: Trash2,
                            label: 'Remove',
                            danger: true,
                            onClick: () => handleDelete(p.name),
                            busy: deleting === p.name,
                            busyLabel: 'Removing…',
                          },
                        ]}
                      />
                    </td>
                  </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {processDialogOpen && processDraft && (
        <ConsoleDialogShell
          onClose={() => {
            setProcessDialogOpen(false);
            setProcessDraft(null);
          }}
          backdropClassName={NESTED_DIALOG_BACKDROP}
          shellClassName={NESTED_DIALOG_SHELL}
          panelClassName={consoleStructuredDialogPanelClass}
        >
          <ConsoleStructuredDialogHeader title="Gateway" />
          <ConsoleStructuredDialogBody>
            <form id="gateway-process-form" onSubmit={handleSaveProcess} className="space-y-4">
              <div className="space-y-2">
                <FormLabel htmlFor="gateway-upstream-url">External UniGateway URL</FormLabel>
                <Input
                  id="gateway-upstream-url"
                  value={processDraft.upstream_url || ''}
                  onChange={(e) => setProcessDraft((prev) => ({ ...prev, upstream_url: e.target.value }))}
                  placeholder="http://unigateway.internal:8741"
                  className="h-9 min-h-9 py-1.5 font-mono"
                />
                <p className="text-xs text-zinc-500">Leave empty to use the embedded local UniGateway process.</p>
              </div>
              <label className="flex items-center gap-2 text-sm text-zinc-600">
                <input
                  type="checkbox"
                  checked={processDraft.auto_start}
                  onChange={(e) => setProcessDraft((prev) => ({ ...prev, auto_start: e.target.checked }))}
                  className="rounded border-zinc-300"
                />
                Start automatically when the server boots
              </label>
            </form>
          </ConsoleStructuredDialogBody>
          <ConsoleStructuredDialogFooter>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setProcessDialogOpen(false);
                setProcessDraft(null);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" form="gateway-process-form" disabled={processSaving} size="sm">
              {processSaving ? 'Saving…' : 'Save'}
            </Button>
          </ConsoleStructuredDialogFooter>
        </ConsoleDialogShell>
      )}

      {providerDialog && (
        <ConsoleDialogShell
          onClose={() => setProviderDialog(null)}
          backdropClassName={NESTED_DIALOG_BACKDROP}
          shellClassName={NESTED_DIALOG_SHELL}
          panelClassName={consoleStructuredDialogPanelClass}
        >
          <ConsoleStructuredDialogHeader
            title={providerDialog.mode === 'edit' ? providerDialog.form.name : 'Add provider'}
            subtitle="Upstream LLM account for UniGateway routing."
          />
          <ConsoleStructuredDialogBody className="scrollbar-hover">
            <form id="gateway-provider-form" onSubmit={handleSaveProvider}>
              <ProviderFormFields
                form={providerDialog.form}
                onChange={updateProviderForm}
                isEdit={providerDialog.mode === 'edit'}
                apiKeyMasked={providerDialog.apiKeyMasked}
                apiKeyRevealed={providerDialog.apiKeyRevealed}
                apiKeyCanToggle={hasApiKeyForActions(providerDialog)}
                onApiKeyChange={handleApiKeyChange}
                onToggleApiKeyReveal={handleToggleApiKeyReveal}
                hasApiKey={hasApiKeyForActions(providerDialog)}
                onFetchModels={handleFetchModels}
                fetchingModels={fetchingModels}
                onTestConnection={handleTestConnection}
                testingConnection={testingConnection}
                connectionHealth={
                  providerDialog.mode === 'edit' && usesSavedApiKey(providerDialog)
                    ? providerHealth[providerDialog.form.name.trim()] || formConnectionHealth
                    : formConnectionHealth
                }
              />
            </form>
          </ConsoleStructuredDialogBody>
          <ConsoleStructuredDialogFooter>
            <Button type="button" variant="secondary" size="sm" onClick={() => setProviderDialog(null)}>
              Cancel
            </Button>
            <Button type="submit" form="gateway-provider-form" disabled={saving} size="sm">
              {saving ? 'Saving…' : providerDialog.mode === 'edit' ? 'Update' : 'Add'}
            </Button>
          </ConsoleStructuredDialogFooter>
        </ConsoleDialogShell>
      )}
    </>
  );
}
