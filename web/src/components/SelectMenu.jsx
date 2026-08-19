import { useState, useRef, useEffect, useId, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  consoleMenuDropdownZClass,
  consoleSectionLabelClass,
  consoleToolbarInputClass,
  consoleDropdownPanelClass,
} from '../lib/consoleTokens';

function OptionRow({ opt, isSelected, onPick }) {
  return (
    <li role="presentation">
      <button
        type="button"
        role="option"
        aria-selected={isSelected}
        onClick={() => onPick(opt.value)}
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
}

function SectionLabel({ children }) {
  return (
    <li role="presentation" className="px-3 pt-2 pb-1">
      <span className={consoleSectionLabelClass}>{children}</span>
    </li>
  );
}

export default function SelectMenu({
  value,
  onChange,
  options = [],
  placeholder = 'Select…',
  disabled = false,
  className = '',
  searchable = false,
  searchPlaceholder = 'Search…',
  recentValues = [],
  maxHeight = 240,
}) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState(null);
  const [query, setQuery] = useState('');
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const searchRef = useRef(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value);

  const updateMenuRect = () => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dialog = el.closest('[role="dialog"]');
    let bottomBoundary = window.innerHeight;
    if (dialog) {
      bottomBoundary = dialog.getBoundingClientRect().bottom;
    }
    const availableHeight = bottomBoundary - rect.bottom - 8;
    setMenuRect({
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(80, Math.min(availableHeight, maxHeight)),
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
    if (!open) {
      setQuery('');
      return;
    }
    if (searchable) {
      const t = window.setTimeout(() => searchRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [open, searchable]);

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

  const pick = (next) => {
    onChange(next);
    setOpen(false);
  };

  const normalizedQuery = query.trim().toLowerCase();

  const filteredOptions = useMemo(() => {
    if (!normalizedQuery) return options;
    return options.filter((opt) => opt.label.toLowerCase().includes(normalizedQuery));
  }, [options, normalizedQuery]);

  const { recentOptions, otherOptions } = useMemo(() => {
    if (!searchable || normalizedQuery || !recentValues.length) {
      return { recentOptions: [], otherOptions: filteredOptions };
    }
    const recentSet = new Set(recentValues);
    const byValue = new Map(filteredOptions.map((opt) => [opt.value, opt]));
    const recent = recentValues
      .map((id) => byValue.get(id))
      .filter(Boolean);
    const other = filteredOptions.filter((opt) => !recentSet.has(opt.value));
    return { recentOptions: recent, otherOptions: other };
  }, [searchable, normalizedQuery, recentValues, filteredOptions]);

  const showSections =
    searchable && !normalizedQuery && recentOptions.length > 0 && otherOptions.length > 0;

  const renderOptions = () => {
    if (filteredOptions.length === 0) {
      return (
        <li role="presentation" className="px-3 py-3 text-sm text-zinc-400 text-center">
          No matches
        </li>
      );
    }

    if (showSections) {
      return (
        <>
          <SectionLabel>Recently used</SectionLabel>
          {recentOptions.map((opt) => (
            <OptionRow
              key={`recent-${opt.value}`}
              opt={opt}
              isSelected={opt.value === value}
              onPick={pick}
            />
          ))}
          <SectionLabel>All agents</SectionLabel>
          {otherOptions.map((opt) => (
            <OptionRow
              key={opt.value}
              opt={opt}
              isSelected={opt.value === value}
              onPick={pick}
            />
          ))}
        </>
      );
    }

    return filteredOptions.map((opt) => (
      <OptionRow
        key={opt.value}
        opt={opt}
        isSelected={opt.value === value}
        onPick={pick}
      />
    ));
  };

  const list =
    open && options.length > 0 && menuRect ? (
      <div
        ref={listRef}
        style={{
          position: 'fixed',
          top: menuRect.top,
          left: menuRect.left,
          width: menuRect.width,
        }}
        className={`${consoleMenuDropdownZClass} ${consoleDropdownPanelClass} shadow-md overflow-hidden`}
      >
        <ul
          id={listId}
          role="listbox"
          className="overflow-auto py-1"
          style={{ maxHeight: menuRect?.maxHeight ?? maxHeight }}
        >
          {renderOptions()}
        </ul>
      </div>
    ) : null;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      {open && searchable ? (
        <div
          className={cn(
            consoleToolbarInputClass,
            'relative w-full flex items-center',
          )}
        >
          <Search className="absolute left-2.5 w-3.5 h-3.5 text-zinc-400 pointer-events-none" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full bg-transparent pl-8 pr-8 text-sm text-zinc-700 placeholder:text-zinc-400 outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <button
            type="button"
            onClick={() => { setOpen(false); setQuery(''); }}
            aria-label="Close"
            className="absolute right-2.5 w-4 h-4 flex items-center justify-center text-zinc-400 hover:text-zinc-600"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled || options.length === 0}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            consoleToolbarInputClass,
            'relative w-full text-left pr-9 hover:bg-zinc-50 disabled:opacity-50 disabled:cursor-not-allowed',
          )}
        >
          <span className={selected ? 'text-zinc-900' : 'text-zinc-400'}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronDown
            className={`absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 pointer-events-none transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      )}
      {list && createPortal(list, document.body)}
    </div>
  );
}
