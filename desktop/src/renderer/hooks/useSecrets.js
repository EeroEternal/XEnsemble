import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast';
import { apiFetch } from '../lib/api.ts';

export function useSecrets() {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const [secrets, setSecrets] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    return apiFetch('/api/v1/secrets')
      .then((res) => res.json())
      .then((data) => {
        if (data && typeof data === 'object' && !data.error) {
          setSecrets(data);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveSecrets = async (payload, { successMessage = t('settings:toast.saved_successfully', { defaultValue: 'Saved successfully.' }) } = {}) => {
    setSaving(true);
    try {
      const res = await apiFetch('/api/v1/secrets', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.secrets) setSecrets(data.secrets);
        else await load();
        showToast('success', successMessage);
        return true;
      }
      showToast('error', t('settings:toast.save_failed'));
      return false;
    } catch (err) {
      showToast('error', err.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return {
    secrets,
    setSecrets,
    loading,
    saving,
    saveSecrets,
    reload: load,
  };
}
