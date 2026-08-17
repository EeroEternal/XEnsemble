import { useEffect, useState, useCallback } from 'react';
import { ConsoleDialogShell } from './ConsoleDialog';
import { buttonClass } from '../lib/buttonStyles';
import { consoleButtonFocusClass, textPrimary, textSecondary } from '../lib/consoleTokens';

let openConfirmFn = null;

export function confirm(options) {
  if (!openConfirmFn) {
    return window.confirm(typeof options === 'string' ? options : options?.message || '');
  }
  return openConfirmFn(options);
}

export default function ConfirmDialog() {
  const [state, setState] = useState(null);

  const open = useCallback((options) => {
    const opts = typeof options === 'string' ? { message: options } : options;
    return new Promise((resolve) => {
      setState({
        title: opts.title || 'Confirm',
        message: opts.message || '',
        confirmLabel: opts.confirmLabel || 'Confirm',
        cancelLabel: opts.cancelLabel || 'Cancel',
        variant: opts.variant || 'primary',
        resolve,
      });
    });
  }, []);

  useEffect(() => {
    openConfirmFn = open;
    return () => { openConfirmFn = null; };
  }, [open]);

  const handleConfirm = useCallback(() => {
    setState((prev) => { prev?.resolve?.(true); return null; });
  }, []);

  const handleCancel = useCallback(() => {
    setState((prev) => { prev?.resolve?.(false); return null; });
  }, []);

  useEffect(() => {
    if (!state) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') handleCancel();
      if (e.key === 'Enter') handleConfirm();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [state, handleConfirm, handleCancel]);

  if (!state) return null;

  return (
    <ConsoleDialogShell onClose={handleCancel} panelClassName="w-96" fitContent>
      <div className="px-5 pt-5 pb-2">
        <h3 className={`text-sm font-semibold ${textPrimary}`}>{state.title}</h3>
      </div>
      <div className="px-5 pb-5">
        <p className={`text-sm ${textSecondary} leading-relaxed whitespace-pre-wrap`}>{state.message}</p>
      </div>
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-zinc-200">
        <button
          onClick={handleCancel}
          className={`${buttonClass('secondary', 'sm')} ${consoleButtonFocusClass}`}
        >
          {state.cancelLabel}
        </button>
        <button
          onClick={handleConfirm}
          className={`${buttonClass(state.variant, 'sm')} ${consoleButtonFocusClass}`}
        >
          {state.confirmLabel}
        </button>
      </div>
    </ConsoleDialogShell>
  );
}
