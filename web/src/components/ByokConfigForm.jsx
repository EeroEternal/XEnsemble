import { useState, useEffect, useCallback, useRef } from 'react';
import { HelpCircle, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { apiFetch } from '../lib/api';
import {
  consoleInputClass,
  consoleButtonFocusClass,
  textPrimary,
  textPlaceholder,
  textSecondary,
  borderHairline,
  bgCanvas,
} from '../lib/consoleTokens';

export default function ByokConfigForm({ agentId, loading, onSave }) {
  const [fields, setFields] = useState([]);
  const [description, setDescription] = useState('');
  const [values, setValues] = useState({});
  const [valuesLoading, setValuesLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const firstInputRef = useRef(null);

  useEffect(() => {
    if (!agentId) return;
    setValuesLoading(true);
    setError(null);
    setDescription('');
    Promise.all([
      apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}/byok-fields`).then((r) => r.json()),
      apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}/byok-config`).then((r) => r.json()),
    ]).then(([fieldsRes, configRes]) => {
      const fieldList = Array.isArray(fieldsRes) ? fieldsRes : (fieldsRes.fields || []);
      setFields(fieldList);
      if (fieldsRes?.description) setDescription(fieldsRes.description);
      const savedValues = {};
      const config = configRes || {};
      for (const f of fieldList) {
        if (f.key in config && config[f.key]) {
          savedValues[f.key] = config[f.key];
        } else if (f.defaultValue) {
          savedValues[f.key] = String(f.defaultValue);
        } else {
          savedValues[f.key] = '';
        }
      }
      setValues(savedValues);
    }).catch(() => {
      setError('Failed to load configuration fields.');
    }).finally(() => {
      setValuesLoading(false);
    });
  }, [agentId]);

  useEffect(() => {
    if (!valuesLoading && firstInputRef.current) {
      firstInputRef.current.focus();
    }
  }, [valuesLoading]);

  const handleChange = useCallback((key, value) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = async () => {
    setError(null);
    for (const f of fields) {
      if (f.required && !(values[f.key] || '').trim()) {
        setError(`${f.label} is required.`);
        return;
      }
    }
    setSaving(true);
    try {
      const res = await apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}/byok-config`, {
        method: 'PUT',
        body: JSON.stringify({ values }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save configuration');
      onSave?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (valuesLoading || loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (fields.length === 0) {
    return (
      <p className={cn('text-sm py-4 text-center', textPlaceholder)}>
        This agent does not require BYOK configuration.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {description && (
        <p className={cn('text-xs rounded-md bg-zinc-100 px-3 py-2', textSecondary)}>
          {description}
        </p>
      )}
      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
      )}
      {fields.map((f, idx) => {
        const isSecret = f.type === 'secret';
        const isNumber = f.type === 'number';
        return (
          <div key={f.key}>
            <div className="flex items-center gap-1.5 mb-1">
              <label className={cn('text-xs font-medium', textPrimary)}>
                {f.label}
                {f.required && <span className="text-red-600 ml-0.5">*</span>}
              </label>
              <span className="group relative inline-flex">
                <HelpCircle className={cn('h-3 w-3 cursor-help', textPlaceholder)} />
                <span className={cn(
                  'absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5',
                  'hidden group-hover:block z-10',
                  'px-2 py-1 text-[11px] rounded whitespace-nowrap',
                  'bg-black text-white',
                  'pointer-events-none',
                )}>
                  {f.tooltip}
                </span>
              </span>
            </div>
            <input
              ref={idx === 0 ? firstInputRef : undefined}
              type={isSecret ? 'password' : 'text'}
              value={values[f.key] || ''}
              onChange={(e) => handleChange(f.key, e.target.value)}
              placeholder={f.defaultValue ? String(f.defaultValue) : `Enter ${f.label}`}
              className={cn(consoleInputClass, consoleButtonFocusClass)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        );
      })}
      <div className="flex justify-end pt-1">
        <button
          type="button"
          disabled={saving}
          onClick={handleSave}
          className={cn(
            'h-9 px-4 flex items-center justify-center gap-2',
            'bg-black text-white rounded-md text-sm font-medium',
            'hover:bg-zinc-700 disabled:opacity-50',
            consoleButtonFocusClass,
          )}
        >
          {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : 'Save'}
        </button>
      </div>
    </div>
  );
}
