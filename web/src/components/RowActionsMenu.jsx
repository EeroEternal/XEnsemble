import { useEffect, useRef, useState } from 'react';
import { Loader2, MoreHorizontal } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  consoleIconButtonClass,
  consoleMenuDropdownZClass,
} from '../lib/consoleTokens';

const DROPDOWN_MIN_SPACE = 260;

export default function RowActionsMenu({ label = 'Actions', items, className }) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
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

  const handleToggle = () => {
    if (!open && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      setDropUp(window.innerHeight - rect.bottom < DROPDOWN_MIN_SPACE);
    }
    setOpen((v) => !v);
  };

  const visible = items.filter((item) => item && item.visible !== false);

  return (
    <div ref={rootRef} className={cn('relative flex justify-end', className)}>
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className={cn(consoleIconButtonClass, open && 'bg-zinc-100 text-zinc-900')}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            'absolute right-0 w-52 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg shadow-zinc-200/50',
            consoleMenuDropdownZClass,
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          {visible.map((item, i) => (
            item.separator ? (
              <div key={i} className="my-1 border-t border-zinc-100" role="separator" />
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); item.onClick?.(); }}
                disabled={item.disabled || item.busy}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-sm disabled:opacity-40 disabled:pointer-events-none',
                  item.danger
                    ? 'text-red-600 hover:bg-red-50 hover:text-red-700'
                    : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900',
                )}
              >
                {item.icon ? <item.icon className="h-4 w-4 shrink-0" /> : null}
                <span className="flex-1 truncate text-left">
                  {item.busy ? item.busyLabel || item.label : item.label}
                </span>
                {item.busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
              </button>
            )
          ))}
        </div>
      )}
    </div>
  );
}
