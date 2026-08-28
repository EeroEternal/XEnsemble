import { useState, useRef, useEffect } from 'react';
import { CircleUser, LogOut, Settings2 } from 'lucide-react';

export default function UserMenu({ username, onLogout, onOpenSettings }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
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

  const handleLogout = () => {
    setOpen(false);
    onLogout();
  };

  const handleSettings = () => {
    setOpen(false);
    onOpenSettings?.();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account menu"
        className={`flex items-center justify-center w-8 h-8 rounded-full transition-colors ${
          open ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
        }`}
      >
        <CircleUser className="w-5 h-5" strokeWidth={1.75} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 w-48 rounded-lg border border-zinc-200 bg-surface py-1 shadow-lg shadow-zinc-200/50 z-50"
        >
          <div className="px-3 py-2 border-b border-zinc-100">
            <p className="text-xs text-zinc-400">Signed in as</p>
            <p className="text-sm font-medium text-zinc-900 truncate">{username}</p>
          </div>
          {onOpenSettings && (
            <button
              type="button"
              role="menuitem"
              onClick={handleSettings}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
            >
              <Settings2 className="w-4 h-4 shrink-0" />
              Settings
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={handleLogout}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
