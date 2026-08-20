import { useEffect, useState } from 'react';
import {
  Loader2,
  Monitor,
  ChevronDown,
  ChevronUp,
  Copy,
  CheckCircle2,
  XCircle,
  ExternalLink,
} from 'lucide-react';
import { usePreview } from './PreviewPanel';
import { consoleButtonFocusClass } from '@/lib/consoleTokens';
import { useToast } from './Toast';

function formatTtl(expiresAt) {
  if (!expiresAt) return '';
  const ms = expiresAt - Date.now();
  if (ms <= 0) return '已过期';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
}

/** Deployed app preview (start/stop + embed). */
export default function WorkspacePreviewPane({ projectId, deployInfo }) {
  const preview = usePreview(projectId, true);
  const { status, previewUrl, isBusy, resolveEmbedUrl, openPreview } = preview;
  const { showToast } = useToast();
  const [embedUrl, setEmbedUrl] = useState(null);
  const [embedLoading, setEmbedLoading] = useState(false);
  const [embedError, setEmbedError] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);

  const deployment = preview.deployment;

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

  const copyUrl = async () => {
    const url = previewUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      showToast('success', '访问地址已复制');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('error', '复制失败，请手动复制');
    }
  };

  const stepsCount = deployInfo?.plan?.steps?.length;
  const elapsedMs = deployInfo?.elapsedMs;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workspace-preview-pane">
      {status === 'running' && (
        <div className="flex items-center gap-2 border-b border-[#E8EAED] px-3 py-1.5 shrink-0">
          <Monitor className="h-3.5 w-3.5 shrink-0 text-[#5F6368]" />
          <span className="truncate text-xs text-[#5F6368] font-mono">
            {previewUrl}
          </span>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className={`ml-auto flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900 shrink-0 ${consoleButtonFocusClass}`}
            title={showDetails ? '收起部署详情' : '查看部署详情'}
          >
            {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            部署详情
          </button>
        </div>
      )}

      {showDetails && (
        <div className="shrink-0 border-b border-[#E8EAED] bg-[#FAFBFC] px-4 py-3 space-y-2 text-xs">
          <div className="flex items-center gap-2">
            {status === 'running' ? (
              <>
                <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                <span className="font-medium text-zinc-900">你的应用正在运行</span>
              </>
            ) : (
              <>
                <XCircle className="w-4 h-4 text-red-500 shrink-0" />
                <span className="font-medium text-zinc-900">应用未运行</span>
              </>
            )}
          </div>
          {previewUrl && (
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 shrink-0">访问地址</span>
              <span className="font-mono text-zinc-800 truncate flex-1 min-w-0">{previewUrl}</span>
              <button
                type="button"
                onClick={copyUrl}
                className={`p-1 rounded text-zinc-400 hover:text-zinc-700 hover:bg-[#E8EAED] shrink-0 ${consoleButtonFocusClass}`}
                title="复制访问地址"
              >
                {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
              <button
                type="button"
                onClick={openPreview}
                className={`p-1 rounded text-zinc-400 hover:text-zinc-700 hover:bg-[#E8EAED] shrink-0 ${consoleButtonFocusClass}`}
                title="在新窗口打开"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            {deployment?.expires_at && status === 'running' && (
              <div>
                <span className="text-zinc-500">剩余可用时间：</span>
                <span className="text-zinc-800">{formatTtl(deployment.expires_at)}</span>
              </div>
            )}
            {elapsedMs != null && (
              <div>
                <span className="text-zinc-500">本次部署用时：</span>
                <span className="text-zinc-800">{(elapsedMs / 1000).toFixed(1)} 秒</span>
              </div>
            )}
            {stepsCount != null && (
              <div>
                <span className="text-zinc-500">自动完成步骤：</span>
                <span className="text-zinc-800">{stepsCount} 步</span>
              </div>
            )}
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            AI 已自动分析你的项目，并帮你准备好运行环境、安装依赖、启动应用并通过了检查。你可以直接在下方预览，也可以点击按钮在浏览器中打开。
          </p>
        </div>
      )}

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
          </div>
        )}
      </div>
    </div>
  );
}
