import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../Button';
import Input from '../Input';
import { ConsoleDialogShell } from '../ConsoleDialog';
import { useToast } from '../Toast';
import {
  consoleDialogAdminFormPanelClass,
  consoleSectionLabelClass,
} from '../../lib/consoleTokens';
import { apiFetch } from '../../lib/api';

export default function AgentEditDialog({ agent, onClose, onSaved }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
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
      showToast('error', t('agents:error.command_required'));
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
      showToast('success', t('agents:toast.executable_updated'));
      onClose();
      onSaved?.();
    } catch (err) {
      showToast('error', err.message || t('agents:error.executable_update_failed'));
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
      <h2 className="font-bold text-lg text-zinc-900 mb-1">Executable - {agent.name}</h2>
      <p className="text-sm text-zinc-500 mb-4">
        Command and arguments used when launching this agent.
      </p>
      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <label className={`block mb-1 ${consoleSectionLabelClass}`}>Command</label>
          <Input
            required
            value={editDraft.cmd}
            onChange={(e) => setEditDraft({ ...editDraft, cmd: e.target.value })}
            className="h-9 py-1.5 font-mono"
            placeholder="claude"
          />
        </div>
        <div>
          <label className={`block mb-1 ${consoleSectionLabelClass}`}>Arguments</label>
          <Input
            value={editDraft.args}
            onChange={(e) => setEditDraft({ ...editDraft, args: e.target.value })}
            className="h-9 py-1.5 font-mono"
            placeholder="--not-interactive"
          />
          <p className="mt-1 text-xs text-zinc-400">Space-separated. Leave empty if none.</p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="md" disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </form>
    </ConsoleDialogShell>
  );
}
