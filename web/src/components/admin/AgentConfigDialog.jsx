import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../Button';
import Input from '../Input';
import SelectMenu from '../SelectMenu';
import MultiSelectMenu from '../MultiSelectMenu';
import { ConsoleDialogShell } from '../ConsoleDialog';
import { useToast } from '../Toast';
import {
  consoleDialogAdminFormPanelClass,
  consoleSectionLabelClass,
} from '../../lib/consoleTokens';
import { apiFetch } from '../../lib/api';

function SectionDivider({ children }) {
  return <div className="border-t border-zinc-100 pt-4">{children}</div>;
}

function SectionLabel({ children }) {
  return <p className={`${consoleSectionLabelClass} mb-2`}>{children}</p>;
}

function normalizeModels(model) {
  if (Array.isArray(model)) return model.map((m) => String(m || '').trim()).filter(Boolean);
  if (model) return [String(model).trim()];
  return [];
}

export default function AgentConfigDialog({ agent, gatewayProviders, onClose, onSaved }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [authDraft, setAuthDraft] = useState({ provider: '', model: [] });
  const [savingKeys, setSavingKeys] = useState(false);
  const [gatewayPreview, setGatewayPreview] = useState(null);
  const [gatewayPreviewLoading, setGatewayPreviewLoading] = useState(false);
  const [vmResources, setVmResources] = useState({ disk_size_gb: '', cpus: '', memory_mib: '' });

  useEffect(() => {
    if (!agent) return;
    setVmResources({ disk_size_gb: '', cpus: '', memory_mib: '' });
    apiFetch(`/api/v1/admin/agents/${agent.id}/vm-resources`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.vm_resources) {
          setVmResources({
            disk_size_gb: data.vm_resources.disk_size_gb != null ? String(data.vm_resources.disk_size_gb) : '',
            cpus: data.vm_resources.cpus != null ? String(data.vm_resources.cpus) : '',
            memory_mib: data.vm_resources.memory_mib != null ? String(data.vm_resources.memory_mib) : '',
          });
        }
      })
      .catch(() => {});
    setAuthDraft({
      provider: agent.gateway_config?.provider || '',
      model: normalizeModels(agent.gateway_config?.model),
    });
  }, [agent]);

  const fetchGatewayPreview = useCallback(async (agentId, models) => {
    setGatewayPreviewLoading(true);
    try {
      const params = new URLSearchParams();
      const firstModel = Array.isArray(models) ? (models[0] || '') : models;
      if (firstModel?.trim()) params.set('model', firstModel.trim());
      params.set('llm_auth_mode', 'gateway');
      const qs = params.toString();
      const res = await apiFetch(`/api/v1/admin/agents/${agentId}/gateway-spawn-preview${qs ? `?${qs}` : ''}`);
      const data = await res.json();
      setGatewayPreview(res.ok ? data : null);
    } catch {
      setGatewayPreview(null);
    } finally {
      setGatewayPreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!agent) {
      setGatewayPreview(null);
      return undefined;
    }
    fetchGatewayPreview(agent.id, authDraft.model);
    return undefined;
  }, [agent, authDraft.model, fetchGatewayPreview]);

  useEffect(() => {
    if (gatewayProviders.length === 0) return;
    setAuthDraft((d) => {
      if (!d.provider) {
        return { ...d, provider: gatewayProviders[0].name };
      }
      return d;
    });
  }, [gatewayProviders]);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!agent) return;
    if (!authDraft.provider?.trim()) {
      showToast('error', 'Select a provider.');
      return;
    }
    if (authDraft.model.length === 0) {
      showToast('error', 'Select at least one model.');
      return;
    }
    setSavingKeys(true);
    try {
      const res = await apiFetch(`/api/v1/admin/gateway/agent-configs/${agent.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          llm_auth_mode: 'gateway',
          provider: authDraft.provider || undefined,
          model: authDraft.model,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (data.warning) {
        showToast('warning', data.warning, { durationMs: 12000 });
      } else {
        showToast('success', t('agents:config_dialog.saved_toast'));
      }
      const diskGb = vmResources.disk_size_gb.trim();
      const cpus = vmResources.cpus.trim();
      const memMb = vmResources.memory_mib.trim();
      if (diskGb || cpus || memMb) {
        try {
          const body = {};
          if (diskGb) body.disk_size_gb = Number(diskGb);
          if (cpus) body.cpus = Number(cpus);
          if (memMb) body.memory_mib = Number(memMb);
          const vrRes = await apiFetch(`/api/v1/admin/agents/${agent.id}/vm-resources`, {
            method: 'PUT',
            body: JSON.stringify(body),
          });
          const vrData = await vrRes.json();
          if (!vrRes.ok) throw new Error(vrData.error);
        } catch (err) {
          showToast('error', 'VM resources saved, but: ' + (err.message || 'failed'));
        }
      }
      onClose();
      onSaved?.();
    } catch (err) {
      showToast('error', err.message || 'Failed to save configuration.');
    } finally {
      setSavingKeys(false);
    }
  };

  const canSave = agent && authDraft.model.length > 0;

  const providerOptions = useMemo(
    () => gatewayProviders.map((p) => ({ value: p.name, label: p.name })),
    [gatewayProviders],
  );

  const modelOptions = useMemo(() => {
    const selected = gatewayProviders.find((p) => p.name === authDraft.provider);
    const models = selected?.models?.length
      ? selected.models
      : gatewayProviders.flatMap((p) => p.models || []);
    const unique = [...new Set(models.filter(Boolean))];
    return unique.map((m) => ({ value: m, label: m }));
  }, [gatewayProviders, authDraft.provider]);

  if (!agent) return null;

  return (
    <ConsoleDialogShell
      fitContent
      onClose={onClose}
      panelClassName={`${consoleDialogAdminFormPanelClass} p-6`}
    >
      <h2 className="font-bold text-lg text-zinc-900 mb-1">
        {t('agents:config_dialog.title', { name: agent.name })}
      </h2>
      <p className="text-sm text-zinc-500 mb-4">
        {t('agents:config_dialog.gateway_desc')}
      </p>
      <form onSubmit={handleSave} className="space-y-4">
        {/* Section: Gateway config */}
        <SectionDivider>
          <div className="space-y-3">
            <SectionLabel>{t('gateway:title', { defaultValue: 'Gateway' })}</SectionLabel>
            <div>
              <label className={`block mb-1 ${consoleSectionLabelClass}`}>Provider</label>
              <SelectMenu
                value={authDraft.provider}
                onChange={(v) => setAuthDraft((d) => ({ ...d, provider: v, model: [] }))}
                options={providerOptions}
                placeholder={t('agents:config.any_provider', { defaultValue: 'Any provider' })}
              />
            </div>
            <div>
              <label className={`block mb-1 ${consoleSectionLabelClass}`}>Model</label>
              <MultiSelectMenu
                value={authDraft.model}
                onChange={(vals) => setAuthDraft((d) => ({ ...d, model: vals }))}
                options={modelOptions}
                placeholder={modelOptions.length ? 'Select models...' : 'Add models in Settings - Gateway'}
                disabled={modelOptions.length === 0}
              />
            </div>
            {gatewayPreviewLoading && !gatewayPreview && (
              <p className="text-sm text-zinc-500">Loading defaults...</p>
            )}
            {!gatewayPreviewLoading && gatewayPreview && !gatewayPreview.gateway_running && (
              <p className="text-sm text-amber-700">
                UniGateway is not running. Start it under Settings - Gateway.
              </p>
            )}
          </div>
        </SectionDivider>

        {/* Section: VM Resources */}
        <SectionDivider>
          <div className="space-y-3">
            <SectionLabel>VM Resources</SectionLabel>
            <p className="text-xs text-zinc-400">
              CPU / memory / disk limits for the sandbox VM. Leave empty to use system defaults.
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Disk (GB)</label>
                <Input
                  type="number"
                  min="1"
                  value={vmResources.disk_size_gb}
                  onChange={(ev) => setVmResources((d) => ({ ...d, disk_size_gb: ev.target.value }))}
                  className="h-9 py-1.5"
                  placeholder={t('common:placeholder.default', { defaultValue: 'Default' })}
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">CPUs</label>
                <Input
                  type="number"
                  min="1"
                  value={vmResources.cpus}
                  onChange={(ev) => setVmResources((d) => ({ ...d, cpus: ev.target.value }))}
                  className="h-9 py-1.5"
                  placeholder={t('common:placeholder.default', { defaultValue: 'Default' })}
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Memory (MB)</label>
                <Input
                  type="number"
                  min="1"
                  value={vmResources.memory_mib}
                  onChange={(ev) => setVmResources((d) => ({ ...d, memory_mib: ev.target.value }))}
                  className="h-9 py-1.5"
                  placeholder={t('common:placeholder.default', { defaultValue: 'Default' })}
                />
              </div>
            </div>
          </div>
        </SectionDivider>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            {t('agents:config_dialog.cancel')}
          </Button>
          <Button type="submit" size="md" disabled={savingKeys || !canSave}>
            {savingKeys ? t('agents:config_dialog.saving') : t('agents:config_dialog.save')}
          </Button>
        </div>
      </form>
    </ConsoleDialogShell>
  );
}
