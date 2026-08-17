import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Globe, RefreshCw } from 'lucide-react';
import { consoleButtonFocusClass, consoleInputClass } from '@/lib/consoleTokens';

function normalizeUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Simple in-panel browser with address bar. */
export default function WorkspaceBrowserPane() {
  const [input, setInput] = useState('https://');
  const [activeUrl, setActiveUrl] = useState('');
  const [frameKey, setFrameKey] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const navigate = () => {
    const url = normalizeUrl(input);
    if (!url || url === 'https://' || url === 'http://') return;
    setInput(url);
    setActiveUrl(url);
    setFrameKey((k) => k + 1);
  };

  const reload = () => {
    if (!activeUrl) return;
    setFrameKey((k) => k + 1);
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workspace-browser-pane">
      <div className="flex items-center gap-1.5 border-b border-zinc-200 px-2 py-1.5 shrink-0">
        <Globe className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        <input
          ref={inputRef}
          type="url"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              navigate();
            }
          }}
          placeholder="Enter URL…"
          className={`${consoleInputClass} h-7 min-h-7 py-1 text-xs font-mono flex-1 min-w-0`}
        />
        <button
          type="button"
          title="Go"
          onClick={navigate}
          className={`p-1.5 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Reload"
          onClick={reload}
          disabled={!activeUrl}
          className={`p-1.5 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 disabled:opacity-40 ${consoleButtonFocusClass}`}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 bg-zinc-100">
        {activeUrl ? (
          <iframe
            key={frameKey}
            title="Browser"
            src={activeUrl}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-400 px-6 text-center">
            <Globe className="h-10 w-10" />
            <p className="text-sm">Enter a URL and press Enter to open</p>
          </div>
        )}
      </div>
    </div>
  );
}
