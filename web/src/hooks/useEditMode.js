import { useState, useCallback, useRef } from 'react';

/**
 * Reusable edit/display mode toggle for settings panels.
 *
 * Maintains a draft snapshot that is cloned on enterEdit and discarded on
 * cancelEdit, so Cancel always reverts to the last-saved server values.
 *
 * Usage:
 *   const { isEditing, draft, setDraft, saving, enterEdit, cancelEdit, save }
 *     = useEditMode({ onSave: async (draft) => { ... } });
 */
export function useEditMode({ onSave }) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  // Keep a ref to the source data so enterEdit always clones the latest
  // server value, even if the closure was created in a prior render.
  const sourceRef = useRef(null);
  const setSource = useCallback((data) => {
    sourceRef.current = data;
  }, []);

  const enterEdit = useCallback((source) => {
    const data = source ?? sourceRef.current;
    if (!data) return;
    setDraft(structuredClone(data));
    setIsEditing(true);
  }, []);

  const cancelEdit = useCallback(() => {
    setDraft(null);
    setIsEditing(false);
  }, []);

  const save = useCallback(async () => {
    if (!onSave) {
      setIsEditing(false);
      setDraft(null);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      setDraft(null);
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  }, [draft, onSave]);

  return {
    isEditing,
    draft,
    setDraft,
    saving,
    setSource,
    enterEdit,
    cancelEdit,
    save,
  };
}
