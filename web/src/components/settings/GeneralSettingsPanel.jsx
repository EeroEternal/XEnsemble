import { useState, useEffect, useContext } from 'react';
import { AuthContext } from '../../App';
import Button from '../Button';
import Input from '../Input';
import SelectMenu from '../SelectMenu';
import { useToast } from '../Toast';
import { consoleSectionLabelClass, consoleCardClass } from '../../lib/consoleTokens';

import { apiFetch } from '../../lib/api';

export default function GeneralSettingsPanel() {
  const { user } = useContext(AuthContext);
  const { showToast } = useToast();
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const isAdmin = user?.role === 'admin';

  

  useEffect(() => {
    if (!isAdmin) return;
    apiFetch('/api/v1/admin/platform-settings')
      .then((res) => res.json())
      .then((data) => setSettings(data));
  }, [isAdmin]);

  const quota = settings?.default_user_quota || {};

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiFetch('/api/v1/admin/platform-settings', {
        method: 'PUT',
        
        body: JSON.stringify({
          registration_mode: settings.registration_mode,
          default_user_quota: {
            max_projects: Number(quota.max_projects),
            max_sessions: Number(quota.max_sessions),
            max_previews: Number(quota.max_previews),
            max_runtimes: Number(quota.max_runtimes ?? 1),
            resource_tier: quota.resource_tier,
          },
          session_ttl_hours: Number(settings.session_ttl_hours),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSettings(data);
      showToast('success', 'Settings saved.');
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setSaving(false);
    }
  };

  if (isAdmin) {
    if (!settings) {
      return <p className="text-sm text-zinc-500">Loading…</p>;
    }

    return (
      <form onSubmit={handleSave} className="h-full flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto console-scroll-hidden">
          <div className={`${consoleCardClass} p-6`}>
            <div className="mb-3"><h3 className={consoleSectionLabelClass}>Registration</h3></div>
            <div className="mb-6">
              <label className="block mb-1 text-xs text-zinc-500">Registration mode</label>
              <SelectMenu
                value={settings.registration_mode}
                onChange={(v) => setSettings({ ...settings, registration_mode: v })}
                options={[
                  { value: 'open', label: 'Open' },
                  { value: 'approval', label: 'Approval required' },
                  { value: 'admin_only', label: 'Admin only' },
                  { value: 'invite_only', label: 'Invite only' },
                ]}
              />
            </div>

            <div className="border-t border-zinc-100 my-4" />

            <div className="mb-3"><h3 className={consoleSectionLabelClass}>Default user quota</h3></div>
            <div className="grid grid-cols-2 gap-3 mb-6">
              <div>
                <label className="text-xs text-zinc-500">Workspaces</label>
                <Input
                  type="number"
                  min={0}
                  value={quota.max_projects ?? 5}
                  onChange={(e) => setSettings({
                    ...settings,
                    default_user_quota: { ...quota, max_projects: e.target.value },
                  })}
                  className="h-8 py-1"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-500">Sessions</label>
                <Input
                  type="number"
                  min={0}
                  value={quota.max_sessions ?? 2}
                  onChange={(e) => setSettings({
                    ...settings,
                    default_user_quota: { ...quota, max_sessions: e.target.value },
                  })}
                  className="h-8 py-1"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-500">Previews</label>
                <Input
                  type="number"
                  min={0}
                  value={quota.max_previews ?? 1}
                  onChange={(e) => setSettings({
                    ...settings,
                    default_user_quota: { ...quota, max_previews: e.target.value },
                  })}
                  className="h-8 py-1"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-500">Tier</label>
                <SelectMenu
                  value={quota.resource_tier ?? 'basic'}
                  onChange={(v) => setSettings({
                    ...settings,
                    default_user_quota: { ...quota, resource_tier: v },
                  })}
                  options={[
                    { value: 'basic', label: 'Basic' },
                    { value: 'pro', label: 'Pro' },
                    { value: 'enterprise', label: 'Enterprise' },
                  ]}
                />
              </div>
            </div>

            <div className="border-t border-zinc-100 my-4" />

            <div className="mb-3"><h3 className={consoleSectionLabelClass}>Session</h3></div>
            <div>
              <label className="block mb-1 text-xs text-zinc-500">Session TTL (hours)</label>
              <Input
                type="number"
                min={1}
                value={settings.session_ttl_hours ?? 24}
                onChange={(e) => setSettings({ ...settings, session_ttl_hours: e.target.value })}
                className="h-8 py-1 w-32"
              />
            </div>

            <div className="pt-6 flex justify-start">
              <Button type="submit" size="md" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-3" />
  );
}
