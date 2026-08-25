import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast';
import { apiFetch } from '../lib/api.ts';

export function usePlatformSecrets() {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const [hints, setHints] = useState({});
  const [draft, setDraft] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    return apiFetch('/api/v1/admin/agent-secrets')
      .then((res) => res.json())
      .then((data) => {
        if (data && typeof data === 'object' && !data.error) {
          setHints(data);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveSecrets = async (payload, { successMessage = t('settings:toast.platform_settings_saved', { defaultValue: 'Platform settings saved.' }) } = {}) => {
    setSaving(true);
    try {
      const res = await apiFetch('/api/v1/admin/agent-secrets', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('settings:toast.save_failed'));
      if (data.secrets) setHints(data.secrets);
      else await load();
      showToast('success', successMessage);
      return true;
    } catch (err) {
      showToast('error', err.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return {
    hints,
    draft,
    setDraft,
    loading,
    saving,
    saveSecrets,
    reload: load,
  };
}
