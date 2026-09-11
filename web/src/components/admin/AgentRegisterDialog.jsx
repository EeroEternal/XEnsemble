import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import Button from '../Button';
import Input, { FormLabel } from '../Input';
import {
  ConsoleDialogShell,
  ConsoleStructuredDialogHeader,
  ConsoleStructuredDialogBody,
  ConsoleStructuredDialogFooter,
} from '../ConsoleDialog';
import { useToast } from '../Toast';
import { consoleDialogMdClass } from '../../lib/consoleTokens';
import { apiFetch } from '../../lib/api';

const EMPTY_AGENT = { id: '', name: '', cmd: '', args: '[]', env_required: '[]' };

function parseJsonSafe(value) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return { ok: false, error: 'Must be a JSON array' };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }
}

export default function AgentRegisterDialog({ open, onClose, onRegistered }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [newAgent, setNewAgent] = useState(EMPTY_AGENT);
  const [saving, setSaving] = useState(false);

  const argsValidation = useMemo(() => parseJsonSafe(newAgent.args), [newAgent.args]);
  const envValidation = useMemo(() => parseJsonSafe(newAgent.env_required), [newAgent.env_required]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!argsValidation.ok || !envValidation.ok) {
      showToast('error', t('agents:error.register_json_invalid'));
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/v1/agents', {
        method: 'POST',
        body: JSON.stringify({
          ...newAgent,
          args: argsValidation.value,
          env_required: envValidation.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showToast('success', t('agents:register_dialog.registered_toast'));
      setNewAgent(EMPTY_AGENT);
      onClose();
      onRegistered?.();
    } catch (err) {
      showToast('error', err.message || t('agents:error.register_failed'));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <ConsoleDialogShell onClose={onClose} panelClassName={consoleDialogMdClass}>
      <ConsoleStructuredDialogHeader title={t('agents:register_dialog.title')} />
      <ConsoleStructuredDialogBody>
        <form id="agent-register-form" onSubmit={handleSubmit} className="space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
              {t('agents:register_dialog.identity')}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FormLabel htmlFor="agent-id" className="mb-1.5">{t('agents:register_dialog.id')}</FormLabel>
                <Input
                  id="agent-id"
                  required
                  autoFocus
                  value={newAgent.id}
                  onChange={(e) => setNewAgent({ ...newAgent, id: e.target.value })}
                  placeholder="kimi-code"
                />
              </div>
              <div>
                <FormLabel htmlFor="agent-name" className="mb-1.5">{t('agents:register_dialog.display_name')}</FormLabel>
                <Input
                  id="agent-name"
                  required
                  value={newAgent.name}
                  onChange={(e) => setNewAgent({ ...newAgent, name: e.target.value })}
                  placeholder="Kimi Code"
                />
              </div>
            </div>
          </div>

          <div className="border-t border-zinc-100 pt-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
              {t('agents:register_dialog.execution')}
            </p>
            <div className="space-y-3">
              <div>
                <FormLabel htmlFor="agent-cmd" className="mb-1.5">{t('agents:register_dialog.command')}</FormLabel>
                <Input
                  id="agent-cmd"
                  required
                  value={newAgent.cmd}
                  onChange={(e) => setNewAgent({ ...newAgent, cmd: e.target.value })}
                  placeholder="npx"
                  className="font-mono"
                />
              </div>
              <div>
                <FormLabel htmlFor="agent-args" className="mb-1.5">{t('agents:register_dialog.arguments_json')}</FormLabel>
                <Input
                  id="agent-args"
                  required
                  value={newAgent.args}
                  onChange={(e) => setNewAgent({ ...newAgent, args: e.target.value })}
                  placeholder='["-y","kimi-code@latest"]'
                  className={`font-mono ${!argsValidation.ok ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''}`}
                />
                {!argsValidation.ok && (
                  <p className="mt-1 text-xs text-red-600">{argsValidation.error}</p>
                )}
              </div>
              <div>
                <FormLabel htmlFor="agent-env" className="mb-1.5">{t('agents:register_dialog.required_env_json')}</FormLabel>
                <Input
                  id="agent-env"
                  required
                  value={newAgent.env_required}
                  onChange={(e) => setNewAgent({ ...newAgent, env_required: e.target.value })}
                  placeholder='["KIMI_API_KEY"]'
                  className={`font-mono ${!envValidation.ok ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''}`}
                />
                {!envValidation.ok && (
                  <p className="mt-1 text-xs text-red-600">{envValidation.error}</p>
                )}
                <p className="mt-1 text-xs text-zinc-400">
                  Configure API keys on this page after registration.
                </p>
              </div>
            </div>
          </div>
        </form>
      </ConsoleStructuredDialogBody>
      <ConsoleStructuredDialogFooter>
        <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={saving}>
          {t('agents:register_dialog.cancel')}
        </Button>
        <Button
          type="submit"
          form="agent-register-form"
          size="sm"
          disabled={saving || !argsValidation.ok || !envValidation.ok}
        >
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('agents:register_dialog.saving')}
            </>
          ) : (
            t('agents:register_dialog.save')
          )}
        </Button>
      </ConsoleStructuredDialogFooter>
    </ConsoleDialogShell>
  );
}
