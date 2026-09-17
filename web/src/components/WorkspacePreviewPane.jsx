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
  RotateCw,
} from 'lucide-react';
import { usePreview } from './PreviewPanel';
import { consoleButtonFocusClass } from '@/lib/consoleTokens';
import { useToast } from './Toast';
import { useTranslation } from 'react-i18next';
import i18next from 'i18next';

function formatTtl(expiresAt) {
  if (!expiresAt) return '';
  const ms = expiresAt - Date.now();
  if (ms <= 0) return i18next.t('deploy:preview.expired');
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0
    ? i18next.t('deploy:preview.hours_minutes', { h, m })
    : i18next.t('deploy:preview.minutes', { m });
}

/** Deployed app preview (start/stop + embed). mode='preview' 时详情文案用预览词汇。 */
export default function WorkspacePreviewPane({ projectId, sessionId, deployInfo, mode = 'deploy', onRestartPreview }) {
  const { t } = useTranslation();
  // pollWhenIdle：部署/预览刚完成时持续重试拉取部署记录，直到拿到 running 记录才
  // 渲染 iframe（首次请求失败 → 旧实现永久空白，只能手动刷新）。keepRunningOnEmpty：
  // 运行中偶发轮询空结果不抹成占位符。iframe 不做"成功即渲染"——首帧请求打进未就绪
  // 的预览链路会 Bad Request（实测），轮询确认的时序与"刷新后正常"一致。
  const preview = usePreview(projectId, true, sessionId, {
    pollWhenIdle: true,
    keepRunningOnEmpty: true,
  });
  const { status, previewUrl, isBusy, resolveEmbedUrl, openPreview } = preview;
  const { showToast } = useToast();
  const [embedUrl, setEmbedUrl] = useState(null);
  const [embedLoading, setEmbedLoading] = useState(false);
  const [embedError, setEmbedError] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);
  // live 模式刷新：full reload（iframe 重新加载）即可看到最新源码内容
  const [frameKey, setFrameKey] = useState(0);

  const deployment = preview.deployment;
  // live 模式 UI（LIVE 徽章 + 刷新按钮）暂时下线：实时预览能力仍在开发中，先不在
  // 前端暴露（部署侧 live 逻辑保留不受影响）。恢复时删除下一行的强制 false 即可。
  const LIVE_UI_ENABLED = false;
  const isLive = LIVE_UI_ENABLED && deployment?.mode === 'live';

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
          setEmbedError(err.message || t('deploy:error.load_preview_failed'));
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
      showToast('success', t('deploy:preview.copied'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('error', t('deploy:preview.copy_failed'));
    }
  };

  const elapsedMs = deployInfo?.elapsedMs;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workspace-preview-pane">
      {status === 'running' && (
        <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-1.5 shrink-0">
          <Monitor className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <span className="truncate text-xs text-zinc-500 font-mono">
            {previewUrl}
          </span>
          {isLive && (
            <span className="shrink-0 text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
              {t('deploy:preview.live')}
            </span>
          )}
          {isLive && (
            <button
              type="button"
              onClick={() => setFrameKey((k) => k + 1)}
              className={`ml-1 flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900 shrink-0 ${consoleButtonFocusClass}`}
              title={t('deploy:preview.refresh')}
            >
              <RotateCw className="w-3 h-3" />
              {t('deploy:preview.refresh')}
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className={`ml-auto flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900 shrink-0 ${consoleButtonFocusClass}`}
            title={showDetails ? t('deploy:preview.hide_details') : t('deploy:preview.show_details')}
          >
            {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {t(mode === 'preview' ? 'deploy:preview.details_preview' : 'deploy:preview.details')}
          </button>
          {onRestartPreview && (
            <button
              type="button"
              onClick={onRestartPreview}
              // 蓝描边 = 轻量操作（与顶栏「快速预览」蓝色实心同族、次一档）：改代码后
              // 重启预览是预览流程的高频动作，放标题栏最右侧触手可及，不必先停再开。
              className="ml-1 flex items-center gap-1 h-6 px-2 text-[11px] font-medium rounded-md border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-300 dark:hover:bg-blue-500/25 disabled:opacity-50 disabled:pointer-events-none shrink-0"
              title={t('deploy:preview.refresh_dev_hint')}
            >
              <RotateCw className="w-3 h-3" />
              {t('deploy:preview.refresh_dev')}
            </button>
          )}
        </div>
      )}

      {showDetails && (
        <div className="shrink-0 border-b border-zinc-200 bg-zinc-50 px-4 py-3 space-y-2 text-xs">
          <div className="flex items-center gap-2">
            {status === 'running' ? (
              <>
                <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                <span className="font-medium text-zinc-900">{t('deploy:preview.running')}</span>
              </>
            ) : (
              <>
                <XCircle className="w-4 h-4 text-red-500 shrink-0" />
                <span className="font-medium text-zinc-900">{t('deploy:preview.not_running')}</span>
              </>
            )}
          </div>
          {previewUrl && (
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 shrink-0">{t('deploy:preview.url')}</span>
              <span className="font-mono text-zinc-800 truncate flex-1 min-w-0">{previewUrl}</span>
              <button
                type="button"
                onClick={copyUrl}
                className={`p-1 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200 shrink-0 ${consoleButtonFocusClass}`}
                title={t('deploy:preview.copy_url')}
              >
                {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
              <button
                type="button"
                onClick={openPreview}
                className={`p-1 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200 shrink-0 ${consoleButtonFocusClass}`}
                title={t('deploy:preview.open_new_window')}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            {deployment?.expires_at && status === 'running' && (
              <div>
                <span className="text-zinc-500">{t('deploy:preview.ttl')}：</span>
                <span className="text-zinc-800">{formatTtl(deployment.expires_at)}</span>
              </div>
            )}
            {elapsedMs != null && (
              <div>
                <span className="text-zinc-500">{t(mode === 'preview' ? 'deploy:preview.elapsed_preview' : 'deploy:preview.elapsed')}：</span>
                <span className="text-zinc-800">{t('deploy:preview.seconds', { s: (elapsedMs / 1000).toFixed(1) })}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 bg-zinc-100">
        {embedLoading || isBusy || preview.idlePolling ? (
          <div className="flex h-full items-center justify-center gap-2 text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">{isBusy ? t('deploy:preview.deploying') : t('deploy:preview.loading')}</span>
          </div>
        ) : embedUrl ? (
          <iframe
            key={frameKey}
            title={t('workspace:tabs.preview')}
            src={embedUrl}
            className="h-full w-full border-0 bg-surface"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-400 px-6 text-center">
            <Monitor className="h-10 w-10" />
            {/* 空态文案按模式区分：预览 tab 说「预览启动后在此查看应用」，部署 tab 说
                「部署预览后在此查看应用」——此前预览 tab 也显示部署用词，误导用户。 */}
            <p className="text-sm">{embedError || preview.pollError || t(mode === 'preview' ? 'deploy:preview.empty_preview_tab' : 'deploy:preview.empty')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
