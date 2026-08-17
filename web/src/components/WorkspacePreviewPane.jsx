import { useEffect, useState } from 'react';
import { Loader2, Monitor } from 'lucide-react';
import { usePreview, PreviewActions, PreviewStatus } from './PreviewPanel';
import { consoleButtonFocusClass } from '@/lib/consoleTokens';
import { buttonClass } from '@/lib/buttonStyles';

/** Deployed app preview (start/stop + embed). */
export default function WorkspacePreviewPane({ projectId }) {
  const preview = usePreview(projectId, true);
  const { status, previewUrl, isBusy, deployPreview, resolveEmbedUrl } = preview;
  const [embedUrl, setEmbedUrl] = useState(null);
  const [embedLoading, setEmbedLoading] = useState(false);
  const [embedError, setEmbedError] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (status !== 'running' || !previewUrl) {
      setEmbedUrl(null);
      setEmbedError('');
      return undefined;
    }
    setEmbedLoading(true);
    setEmbedError('');
    resolveEmbedUrl()
      .then((url) => {
        if (!cancelled) setEmbedUrl(url);
      })
      .catch((err) => {
        if (!cancelled) {
          setEmbedUrl(null);
          setEmbedError(err.message || 'Failed to load preview');
        }
      })
      .finally(() => {
        if (!cancelled) setEmbedLoading(false);
      });
    return () => { cancelled = true; };
  }, [status, previewUrl, resolveEmbedUrl]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workspace-preview-pane">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-1.5 shrink-0">
        <div className="flex min-w-0 items-center gap-2">
          <Monitor className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <span className="truncate text-xs text-zinc-500 font-mono">
            {previewUrl || 'Preview'}
          </span>
          <PreviewStatus deployment={preview.deployment} status={status} />
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <PreviewActions {...preview} />
        </div>
      </div>

      <div className="flex-1 min-h-0 bg-zinc-100">
        {embedLoading || isBusy ? (
          <div className="flex h-full items-center justify-center gap-2 text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">{isBusy ? 'Deploying preview…' : 'Loading…'}</span>
          </div>
        ) : embedUrl ? (
          <iframe
            title="Preview"
            src={embedUrl}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-400 px-6 text-center">
            <Monitor className="h-10 w-10" />
            <p className="text-sm">{embedError || 'Deploy a Preview to view your app here'}</p>
            {status !== 'running' && (
              <button
                type="button"
                disabled={isBusy}
                onClick={deployPreview}
                className={`${buttonClass('primary', 'sm')} ${consoleButtonFocusClass}`}
              >
                {isBusy ? 'Deploying…' : 'Deploy Preview'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
