import { useState, useCallback } from 'react';
import i18next from 'i18next';

export function useSaveFile({ projectId, writeFile, onSaved, showToast }) {
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);

  const save = useCallback(async (path, content) => {
    setSaving(true);
    setConflict(null);
    try {
      await writeFile(projectId, path, content);
      showToast?.('success', i18next.t('common:label.saved'));
      onSaved?.(path, content);
      return true;
    } catch (err) {
      if (err.status === 409) {
        setConflict({ path, content });
        showToast?.('error', i18next.t('workspace:error.conflict'));
      } else {
        showToast?.('error', err.message || i18next.t('workspace:error.save_failed'));
      }
      return false;
    } finally {
      setSaving(false);
    }
  }, [projectId, writeFile, onSaved, showToast]);

  const resolveConflict = useCallback((action) => {
    if (action === 'overwrite') {
      setConflict(null);
      return save(conflict.path, conflict.content);
    }
    setConflict(null);
    return null;
  }, [conflict, save]);

  return { save, saving, conflict, resolveConflict };
}