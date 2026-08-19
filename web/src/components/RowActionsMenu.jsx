import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, MoreHorizontal } from 'lucide-react';
import { cn } from '../lib/utils';
import { consoleMenuDropdownZClass } from '../lib/consoleTokens';

const DROPDOWN_MIN_SPACE = 260;
const DROPDOWN_GAP = 4;

export default function RowActionsMenu({ label = 'Actions', items, className }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const rootRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      const target = e.target;
      const insideRoot = rootRef.current && rootRef.current.contains(target);
      const insideMenu = menuRef.current && menuRef.current.contains(target);
      if (!insideRoot && !insideMenu) {
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

  useEffect(() => {
    if (!open) return undefined;
    const onScroll = () => setOpen(false);
    const onResize = () => setOpen(false);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const handleToggle = () => {
    if (!open && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setPos({
        top: rect.bottom,
        bottom: rect.top,
        left: rect.left,
        right: rect.right,
        dropUp: spaceBelow < DROPDOWN_MIN_SPACE,
      });
    }
    setOpen((v) => !v);
  };

  const visible = items.filter((item) => item && item.visible !== false);

  const menuHorizontalStyle = pos ? (() => {
    const viewportRight = window.innerWidth;
    const distFromRight = viewportRight - pos.right;
    if (distFromRight >= 208) return { right: distFromRight };
    if (viewportRight - pos.left >= 208) return { left: pos.left };
    return { right: 8 };
  })() : {};

  return (
    <>
      <div ref={rootRef} className={cn('relative flex', className)}>
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={label}
          className={cn('inline-flex items-center justify-center rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40 disabled:pointer-events-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0', open && 'bg-zinc-100 text-zinc-900')}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{
            position: 'fixed',
            ...menuHorizontalStyle,
            ...(pos.dropUp
              ? { bottom: window.innerHeight - pos.bottom + DROPDOWN_GAP }
              : { top: pos.top + DROPDOWN_GAP }),
          }}
          className={cn(
            'w-52 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg shadow-zinc-200/50',
            consoleMenuDropdownZClass,
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
        </div>,
        document.body,
      )}
    </>
  );
}
