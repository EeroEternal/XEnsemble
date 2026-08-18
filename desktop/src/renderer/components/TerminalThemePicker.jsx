import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Palette, Search } from 'lucide-react';
import { useTerminalTheme } from '../hooks/useTerminalTheme.jsx';
import { useToast } from './Toast';
import { consoleDropdownPanelClass, consoleMenuDropdownZClass } from '../lib/consoleTheme';

const MENU_MIN_WIDTH = 288;

function ThemeSwatch({ preset, size = 'sm' }) {
  const { xterm } = preset;
  const dim = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  return (
    <span
      className={`${dim} shrink-0 rounded border border-white/15`}
      style={{ backgroundColor: xterm.background }}
      aria-hidden
    >
      <span className="flex h-full w-full items-center justify-center gap-px font-mono text-[6px] leading-none">
        <span style={{ color: xterm.red }}>·</span>
        <span style={{ color: xterm.green }}>·</span>
        <span style={{ color: xterm.blue }}>·</span>
      </span>
    </span>
  );
}

export default function TerminalThemePicker({ variant = 'toolbar' }) {
  const { themeId, catalog, setThemeId } = useTerminalTheme();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuRect, setMenuRect] = useState(null);
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const searchRef = useRef(null);

  const active = useMemo(
    () => catalog.find((entry) => entry.id === themeId) ?? catalog[0],
    [catalog, themeId],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (entry) =>
        entry.label.toLowerCase().includes(q) || entry.id.toLowerCase().includes(q),
    );
  }, [catalog, query]);

  const updateMenuRect = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.max(MENU_MIN_WIDTH, rect.width);
    setMenuRect({
      left: Math.max(8, rect.right - width),
      top: rect.bottom + 6,
      width,
    });
  }, []);

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
  }, [open, updateMenuRect]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e) => {
      if (rootRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const pickTheme = (nextId) => {
    setThemeId(nextId, {
      onAppearanceChange: (prevAppearance, nextAppearance) => {
        if (prevAppearance !== nextAppearance) {
          showToast('error', 'Switching light/dark theme requires a new session for the agent input bar to fully sync.');
        }
      },
    });
    setOpen(false);
  };

  const isToolbar = variant === 'toolbar';

  const menu = open && menuRect ? (
    <div
      ref={menuRef}
      role="listbox"
      aria-label="Terminal themes"
      style={{
        position: 'fixed',
        left: menuRect.left,
        top: menuRect.top,
        width: menuRect.width,
      }}
      className={`${consoleMenuDropdownZClass} ${consoleDropdownPanelClass} overflow-hidden shadow-lg`}
    >
      <div className="border-b border-[#E8EAED] p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#9AA0A6]" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search themes…"
            className="h-8 w-full rounded-md border border-[#DADCE0] bg-white pl-8 pr-2 text-xs text-[#202124] placeholder:text-[#9AA0A6] focus:border-[#5B8DB8] focus:outline-none focus:ring-1 focus:ring-[#5B8DB8]"
          />
        </div>
      </div>
      <ul className="max-h-64 overflow-y-auto py-1 pr-0.5">
        {filtered.length === 0 ? (
          <li className="px-3 py-2 text-xs text-[#9AA0A6]">No themes match</li>
        ) : (
          filtered.map((entry) => {
            const selected = entry.id === themeId;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => pickTheme(entry.id)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
                    selected
                      ? 'bg-[#E8F0FE] text-[#202124]'
                      : 'text-[#5F6368] hover:bg-[#F4F5F6] hover:text-[#202124]'
                  }`}
                >
                  <ThemeSwatch preset={entry} />
                  <span className="min-w-0 flex-1 whitespace-nowrap">{entry.label}</span>
                  {selected ? <Check className="ml-1 h-3.5 w-3.5 shrink-0 text-[#5B8DB8]" /> : null}
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={active?.label ? `Terminal theme: ${active.label}` : 'Terminal theme'}
        className={
          isToolbar
            ? `flex min-w-[8.5rem] max-w-[13rem] items-center gap-1.5 rounded-md border border-[#E8EAED] bg-white px-2.5 py-1 text-xs font-mono text-[#5F6368] transition-colors hover:bg-[#E8EAED] hover:text-[#202124] ${open ? 'bg-[#E8EAED] text-[#202124]' : ''}`
            : 'flex min-w-[8.5rem] max-w-[13rem] items-center gap-1.5 rounded-md border border-white/10 bg-black/25 px-2.5 py-1 text-xs text-white/85 backdrop-blur-sm transition-colors hover:bg-black/40'
        }
      >
        <Palette className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
        <span className="truncate font-medium">{active?.label ?? 'Theme'}</span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 opacity-70 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
