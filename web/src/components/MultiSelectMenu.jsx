import { useState, useRef, useEffect, useId, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { consoleMenuDropdownZClass, consoleSectionLabelClass, consoleToolbarInputClass, consoleDropdownPanelClass } from '../lib/consoleTokens';
import { useTranslation } from 'react-i18next';

function formatSummary(options, value, placeholder) {
  if (!value.length) return placeholder;
  const labels = options.filter((o) => value.includes(o.value)).map((o) => o.label);
  if (labels.length <= 2) return labels.join(', ');
  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`;
}

function SelectAllControl({ checked, label, onToggle, disabled }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked ? 'true' : 'false'}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'flex items-center gap-1.5 shrink-0',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      )}
    >
      <span
        className={cn(
          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors',
          checked
            ? 'border-zinc-900 bg-zinc-900 text-zinc-50'
            : 'border-zinc-300 bg-surface',
        )}
      >
        {checked && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
      </span>
      <span className="text-xs text-zinc-600 select-none">{label}</span>
    </button>
  );
}

export default function MultiSelectMenu({
  value = [],
  onChange,
  options = [],
  placeholder,
  disabled = false,
  className = '',
  label,
  showSelectAll = false,
  selectAllLabel,
}) {
  const { t } = useTranslation();
  const effectivePlaceholder = placeholder || t('common:select.placeholder');
  const effectiveSelectAllLabel = selectAllLabel || t('common:select.select_all');
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState(null);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const listId = useId();
  const selected = useMemo(() => new Set(value), [value]);
  const allSelected = options.length > 0 && value.length === options.length;
  const selectAllActive = showSelectAll && allSelected;
  const hasSelectAll = showSelectAll && options.length > 0;
  const dropdownDisabled = disabled || options.length === 0 || selectAllActive;
  const summary = selectAllActive ? effectivePlaceholder : formatSummary(options, value, effectivePlaceholder);

  const updateMenuRect = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenuRect({
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      setMenuRect(null);
      return;
    }
    updateMenuRect();
    window.addEventListener('resize', updateMenuRect);
    window.addEventListener('scroll', updateMenuRect, true);
    return () => {
      window.removeEventListener('resize', updateMenuRect);
      window.removeEventListener('scroll', updateMenuRect, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (rootRef.current?.contains(e.target)) return;
      if (listRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const toggle = (optValue) => {
    const next = new Set(selected);
    if (next.has(optValue)) next.delete(optValue);
    else next.add(optValue);
    onChange([...next]);
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      onChange([]);
    } else {
      onChange(options.map((o) => o.value));
      setOpen(false);
    }
  };

  const list =
    open && !selectAllActive && options.length > 0 && menuRect ? (
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-multiselectable="true"
        style={{
          position: 'fixed',
          top: menuRect.top,
          left: menuRect.left,
          width: menuRect.width,
        }}
        className={`${consoleMenuDropdownZClass} ${consoleDropdownPanelClass} max-h-60 overflow-auto py-1 shadow-md`}
      >
        {options.map((opt) => {
          const isSelected = selected.has(opt.value);
          return (
            <li key={opt.value} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => toggle(opt.value)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                  isSelected
                    ? 'bg-zinc-100 text-zinc-900'
                    : 'text-zinc-700 hover:bg-zinc-50'
                }`}
              >
                <span className="w-4 shrink-0 flex items-center justify-center">
                  {isSelected && <Check className="w-3.5 h-3.5 text-zinc-900" strokeWidth={2.5} />}
                </span>
                <span className="truncate">{opt.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    ) : null;

  return (
    <div ref={rootRef} className={className}>
      {(label || hasSelectAll) && (
        <div className="mb-1 flex items-center justify-between gap-2">
          {label ? <span className={consoleSectionLabelClass}>{label}</span> : <span />}
          {hasSelectAll && (
            <SelectAllControl
              checked={allSelected}
              label={effectiveSelectAllLabel}
              onToggle={toggleSelectAll}
              disabled={disabled}
            />
          )}
        </div>
      )}
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          disabled={dropdownDisabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            consoleToolbarInputClass,
            'relative w-full pr-9 text-left disabled:cursor-not-allowed',
            selectAllActive
              ? 'bg-zinc-100 text-zinc-400 border-zinc-200 cursor-not-allowed'
              : 'hover:bg-zinc-50 disabled:opacity-50',
          )}
        >
          <span className={cn('truncate block', selectAllActive || !value.length ? 'text-zinc-400' : 'text-zinc-900')}>
            {summary}
          </span>
          <ChevronDown
            className={`absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none transition-transform ${
              selectAllActive ? 'text-zinc-300' : 'text-zinc-400'
            } ${open ? 'rotate-180' : ''}`}
          />
        </button>
        {list && createPortal(list, document.body)}
      </div>
    </div>
  );
}
