import { useState, useEffect } from 'react';
import Button from '../Button';
import Input from '../Input';
import { ConsoleDialogShell } from '../ConsoleDialog';
import { useToast } from '../Toast';
import {
  consoleDialogAdminFormPanelClass,
  consoleSectionLabelClass,
} from '../../lib/consoleTheme';
import { apiFetch } from '../../lib/api';
import { useTranslation } from 'react-i18next';

export default function AgentEditDialog({ agent, onClose, onSaved }) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const [editDraft, setEditDraft] = useState({ cmd: '', args: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (agent) {
      setEditDraft({ cmd: agent.cmd, args: agent.args.join(' ') });
    }
  }, [agent]);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!agent) return;
    const cmd = editDraft.cmd.trim();
    if (!cmd) {
      showToast('error', t('agents:toast.command_required', { defaultValue: 'Command is required.' }));
      return;
    }
    const args = editDraft.args.trim() ? editDraft.args.trim().split(/\s+/) : [];
    setSaving(true);
    try {
      const res = await apiFetch(`/api/v1/agents/${agent.id}`, {
        method: 'PUT',
        body: JSON.stringify({ cmd, args }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showToast('success', t('agents:toast.executable_updated', { defaultValue: 'Executable updated.' }));
      onClose();
      onSaved?.();
    } catch (err) {
      showToast('error', err.message || t('agents:toast.update_executable_failed', { defaultValue: 'Failed to update executable.' }));
    } finally {
      setSaving(false);
    }
  };

  if (!agent) return null;

  return (
    <ConsoleDialogShell
      fitContent
      onClose={onClose}
      panelClassName={`${consoleDialogAdminFormPanelClass} p-6`}
    >
      <h2 className="font-bold text-lg text-zinc-900 mb-1">{t('agents:dialog.executable_title', { name: agent.name, defaultValue: 'Executable - {{name}}' })}</h2>
      <p className="text-sm text-zinc-500 mb-4">
        {t('agents:dialog.executable_hint', { defaultValue: 'Command and arguments used when launching this agent.' })}
      </p>
      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <label className={`block mb-1 ${consoleSectionLabelClass}`}>{t('agents:field.cmd')}</label>
          <Input
            required
            value={editDraft.cmd}
            onChange={(e) => setEditDraft({ ...editDraft, cmd: e.target.value })}
            className="h-9 py-1.5 font-mono"
            placeholder="claude"
          />
        </div>
        <div>
          <label className={`block mb-1 ${consoleSectionLabelClass}`}>{t('agents:field.args')}</label>
          <Input
            value={editDraft.args}
            onChange={(e) => setEditDraft({ ...editDraft, args: e.target.value })}
            className="h-9 py-1.5 font-mono"
            placeholder="--not-interactive"
          />
          <p className="mt-1 text-xs text-zinc-400">{t('agents:dialog.args_hint', { defaultValue: 'Space-separated. Leave empty if none.' })}</p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            {t('common:action.cancel')}
          </Button>
          <Button type="submit" size="md" disabled={saving}>
            {saving ? t('common:state.loading') : t('common:action.save')}
          </Button>
        </div>
      </form>
    </ConsoleDialogShell>
  );
}
