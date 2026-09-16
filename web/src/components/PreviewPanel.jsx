import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  AppWindow,
  Loader2,
  Rocket,
  Square,
  Zap,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { withSessionId } from '../lib/sessionContext';
import { useToast } from './Toast';
import { useTranslation } from 'react-i18next';
import { formatQuotaExceeded } from '../lib/quotaLabels';

function pickActiveDeployment(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  // 1) 优先真正可用的预览（preview/dev running）——不被旧 building 残留顶掉。
  //    dev = 快速预览（kind='dev'），与 preview 同为可打开的 running 预览。
  const runningPreview = list.find((d) => (d.kind === 'preview' || d.kind === 'dev') && d.status === 'running');
  if (runningPreview) return runningPreview;
  // 2) 其次只认"较新的"进行中部署（building/pending，updated 10 分钟内）——
  //    太旧的视为残留（部署进程异常退出后 finally 未执行、记录卡 building），
  //    不选中，否则右上角会一直转圈/错位
  const recent = Date.now() - 10 * 60 * 1000;
  const active = list
    .filter((d) => (d.status === 'building' || d.status === 'pending') && d.updated_at >= recent)
    .sort((a, b) => b.updated_at - a.updated_at)[0];
  return active || null;
}

const PREVIEW_WINDOW_NAME = 'xensemble-preview';
const PREVIEW_WINDOW_FEATURES = 'noopener,noreferrer,width=1280,height=840,menubar=no,toolbar=no,location=yes,status=no';

function openPreviewWindow(url, winRef) {
  if (!url) return false;
  let win = winRef?.current;
  if (win && !win.closed) {
    try {
      win.location.href = url;
      win.focus();
      return true;
    } catch {
      winRef.current = null;
    }
  }
  win = window.open(url, PREVIEW_WINDOW_NAME, PREVIEW_WINDOW_FEATURES);
  if (!win) return false;
  if (winRef) winRef.current = win;
  win.focus();
  return true;
}

function closePreviewWindow(winRef) {
  const win = winRef?.current;
  if (win && !win.closed) win.close();
  if (winRef) winRef.current = null;
}

export function usePreview(projectId, token, sessionId, opts = {}) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const lastFailedToastRef = useRef(null);
  const [deployment, setDeployment] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pollError, setPollError] = useState('');
  const previewWindowRef = useRef(null);
  const hasActiveDeployment = deployment && (deployment.status === 'running' || deployment.status === 'building' || deployment.status === 'pending');

  // 切 project/session 时清空旧 deployment/loading，避免右上角残留旧 session 的"部署中"转圈
  useEffect(() => {
    lastFailedToastRef.current = null;
    closePreviewWindow(previewWindowRef);
    setDeployment(null);
    setPollError('');
    setLoading(false);
  }, [projectId, sessionId]);

  useEffect(() => () => closePreviewWindow(previewWindowRef), []);

  const loadDeployments = useCallback(async () => {
    if (!projectId || !token) return;
    try {
      const res = await apiFetch(
        withSessionId(`/api/v1/deployments?project_id=${encodeURIComponent(projectId)}`),
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('deploy:error.load_preview_failed'));
      setPollError('');
      setDeployment((prev) => {
        const list = Array.isArray(data) ? data : (data?.deployments || []);
        // 只关心当前 session 的 deployment：同 project 多 session 并发部署时，
        // 右上角状态不被其它 session 的 building 部署干扰
        const mine = sessionId ? list.filter((d) => d.session_id === sessionId) : list;
        const next = pickActiveDeployment(mine);
        if (prev && next && prev.id === next.id && prev.status === next.status && prev.public_url === next.public_url) return prev;
        // 预览 pane（keepRunningOnEmpty）：某次轮询偶发返回空（网络抖动/后端瞬时错误）
        // 时不把运行中的部署抹成空占位——等下次轮询纠正即可（真实 stopped/failed 终态仍会正常覆盖）。
        if (!next && prev && opts.keepRunningOnEmpty && prev.status === 'running' && prev.public_url) return prev;
        return next;
      });
    } catch (e) {
      // 轮询失败不再完全静默：pollError 会显示在预览 pane 的占位符里，便于定位
      // "tab 空白"的真实原因（右上角仍不弹 toast）。
      setPollError(e?.message || t('deploy:error.load_preview_failed'));
    }
  }, [projectId, sessionId, token, opts.keepRunningOnEmpty, t]);

  // Initial fetch on mount / project / session change
  useEffect(() => {
    if (!projectId || !token) return;
    loadDeployments();
  }, [loadDeployments, projectId, sessionId, token]);

  // Only poll when there's an active deployment (running/building/pending)
  useEffect(() => {
    if (!hasActiveDeployment) return undefined;
    const id = setInterval(loadDeployments, 4000);
    return () => clearInterval(id);
  }, [loadDeployments, hasActiveDeployment]);

  // pollWhenIdle（预览 pane）：部署/预览刚完成时，"首次 fetch 一锤子买卖"是空白 tab
  // 的根因——该次请求一旦失败/返回空，旧实现无任何重试（4s 轮询仅在已有活跃部署时
  // 启动），只能整页刷新。这里在尚无活跃部署期间持续重试（2.5s × 40 ≈ 100s），
  // 拿到部署记录即停（后续由上方 4s 轮询接管）。iframe 只在轮询真实拿到 running
  // 记录后才渲染——曾试验用 SSE result 直接种 iframe"成功即渲染"，结果首帧请求
  // 打进尚未就绪的预览链路（网关/隧道/聚合代理），用户看到 Bad Request；轮询确认
  // 的时序与"刷新后正常"的经验路径一致，可靠。
  const [idlePolling, setIdlePolling] = useState(false);
  useEffect(() => {
    if (hasActiveDeployment) {
      setIdlePolling(false);
      return undefined;
    }
    if (!opts.pollWhenIdle || !projectId || !token) return undefined;
    let tries = 0;
    setIdlePolling(true);
    const id = setInterval(() => {
      tries += 1;
      if (tries > 40) {
        clearInterval(id);
        setIdlePolling(false);
        return;
      }
      loadDeployments();
    }, 2500);
    return () => {
      clearInterval(id);
      setIdlePolling(false);
    };
  }, [hasActiveDeployment, opts.pollWhenIdle, projectId, token, loadDeployments]);

  const deployPreview = async () => {
    setLoading(true);
    try {
      // The server-side /preview endpoint now runs the two-stage auto-deploy
      // pipeline (stage A analyses, stage B builds+starts, verify probes
      // the listening port). On success the pipeline also writes a
      // `kind: 'preview'` row to the `deployments` table, so the panel
      // picks it up on its next poll, and the response carries
      // { public_url, preview_token, deploymentId } for instant window open.
      const res = await apiFetch(withSessionId(`/api/v1/projects/${encodeURIComponent(projectId)}/preview`), {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'quota_exceeded' || data.error === 'quota_exceeded') {
          throw new Error(formatQuotaExceeded(data.dimension || 'max_previews', data.current, data.limit));
        }
        throw new Error(data.error || t('deploy:error.preview_deploy_failed'));
      }
      if (data.public_url) {
        const url = data.preview_token
          ? `${data.public_url}${data.public_url.includes('?') ? '&' : '?'}preview_token=${encodeURIComponent(data.preview_token)}`
          : data.public_url;
        if (!openPreviewWindow(url, previewWindowRef)) {
          showToast('error', t('deploy:action.popups_preview_running'));
        }
        // Pull the latest deployment row so the status badge / stop button
        // are populated. The two-stage pipeline persists it asynchronously
        // after returning, so a single refresh is enough in the common case.
        loadDeployments();
      }
    } catch (e) {
      showToast('error', e.message);
    } finally {
      setLoading(false);
    }
  };

  const stopPreview = async () => {
    if (!deployment?.id) return;
    setLoading(true);
    try {
      const res = await apiFetch(
        `/api/v1/deployments/${encodeURIComponent(deployment.id)}/stop`,
        { method: 'POST' },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('deploy:error.stop_failed'));
      setDeployment(data);
      closePreviewWindow(previewWindowRef);
    } catch (e) {
      showToast('error', e.message);
    } finally {
      setLoading(false);
    }
  };

  const previewUrl = deployment?.public_url && deployment?.status === 'running' ? deployment.public_url : null;

  const status = deployment?.status || 'none';
  const isBusy = loading || status === 'building' || status === 'pending';

  useEffect(() => {
    if (status !== 'failed' || !deployment?.last_error_message) return;
    const key = `${deployment.id ?? 'none'}:${deployment.last_error_message}`;
    if (lastFailedToastRef.current === key) return;
    lastFailedToastRef.current = key;
    showToast('error', deployment.last_error_message);
  }, [deployment?.id, deployment?.last_error_message, showToast, status]);

  const resolveEmbedUrl = useCallback(async () => {
    if (!previewUrl || !deployment?.id) return null;
    const res = await apiFetch(
      `/api/v1/deployments/${encodeURIComponent(deployment.id)}/preview-token`,
      { method: 'POST' },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('deploy:error.preview_token_failed'));
    if (!data.preview_token || !deployment.public_url) return null;
    return `${deployment.public_url}${deployment.public_url.includes('?') ? '&' : '?'}preview_token=${encodeURIComponent(data.preview_token)}`;
  }, [deployment?.id, deployment?.public_url, previewUrl]);

  const openPreview = async () => {
    try {
      const url = await resolveEmbedUrl();
      if (!url) return;
      if (!openPreviewWindow(url, previewWindowRef)) {
        showToast('error', t('deploy:action.allow_popups'));
      }
    } catch (e) {
      showToast('error', e.message);
    }
  };

  return {
    deployment,
    status,
    loading,
    previewUrl,
    isBusy,
    pollError,
    idlePolling,
    loadDeployments,
    deployPreview,
    stopPreview,
    openPreview,
    resolveEmbedUrl,
  };
}

const ICON_BTN =
  'rounded-md p-1.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 disabled:opacity-50';

export function PreviewStatus({ deployStatus, status, runningMode }) {
  const { t } = useTranslation();
  // 部署流程状态：running（部署中/预览中，按运行模式区分文案）/ failed（失败）；
  // 成功(finished)后跟随 deployment 实际状态 —— 若已被停止则显示 stopped，避免残留
  // finished。aborted / idle 不显示。
  if (deployStatus === 'running') {
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${
          runningMode === 'quick' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'
        }`}>
          {t(runningMode === 'quick' ? 'deploy:status.deploying_preview' : 'deploy:status.deploying')}
        </span>
      </div>
    );
  }
  if (deployStatus === 'failed') {
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-red-50 text-red-600">
          {t('deploy:status.failed')}
        </span>
      </div>
    );
  }
  if (deployStatus !== 'finished') return null;
  const display = status === 'stopped' ? t('deploy:status.stopped') : t('deploy:status.finished');
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span
        className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${
          status === 'stopped' ? 'bg-zinc-100 text-zinc-500' : 'bg-emerald-50 text-emerald-600'
        }`}
      >
        {display}
      </span>
    </div>
  );
}

export function PreviewControlGroup({ deployStatus, runningMode, onCancelDeploy, ...props }) {
  const { deployment } = props;
  const status = deployment?.status || 'none';
  return (
    <div className="flex items-center gap-0.5 shrink-0">
      <PreviewStatus deployStatus={deployStatus} status={status} runningMode={runningMode} />
      {deployment && <div className="h-3.5 w-px bg-zinc-200 mx-0.5 shrink-0" aria-hidden />}
      <PreviewActions {...props} deployStatus={deployStatus} runningMode={runningMode} onCancelDeploy={onCancelDeploy} />
    </div>
  );
}

export function PreviewActions({
  deployStatus,
  runningMode,
  onCancelDeploy,
  status,
  isBusy,
  previewUrl,
  openPreview,
  deployPreview,
  stopPreview,
  onAnalyze,
  onQuickPreview,
}) {
  const { t } = useTranslation();
  // 运行中：顶栏停止按钮按运行模式区分文案与色系——预览（轻量蓝）vs 部署（黑色）。
  // runningMode 由 Sessions 传入（DeployPanel onDeployStatus 的第二参数），缺省按部署。
  if (deployStatus === 'running') {
    const isQuick = runningMode === 'quick';
    return (
      <button
        type="button"
        onClick={onCancelDeploy}
        title={isQuick
          ? t('deploy:action.stop_preview_short', { defaultValue: 'Stop preview' })
          : t('deploy:action.stop_deployment', { defaultValue: 'Stop deployment' })}
        className={isQuick
          ? 'inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium rounded-md border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus:ring-0'
          : 'inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium rounded-md bg-zinc-900 text-zinc-50 hover:bg-zinc-800 disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus:ring-0'}
      >
        <Square className="w-3.5 h-3.5" />
        {isQuick
          ? t('deploy:action.stop_preview_short', { defaultValue: 'Stop preview' })
          : t('deploy:action.stop_deploy', { defaultValue: 'Stop deploy' })}
      </button>
    );
  }
  if (status === 'running') {
    return (
      <>
        {previewUrl && (
          <button
            type="button"
            title={t('deploy:action.open_in_browser', { defaultValue: 'Open preview window' })}
            onClick={openPreview}
            className={ICON_BTN}
          >
            <AppWindow className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          title={t('deploy:action.stop_preview', { defaultValue: 'Stop this preview' })}
          disabled={isBusy}
          onClick={stopPreview}
          className={ICON_BTN}
        >
          <Square className="w-3.5 h-3.5" />
        </button>
      </>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {onQuickPreview && (
        <button
          type="button"
          disabled={isBusy}
          onClick={onQuickPreview}
          title={t('deploy:action.quick_preview', { defaultValue: 'Quick preview (dev server + mock API)' })}
          // 蓝色实心 = 轻量快速操作（秒级 dev server），与黑色「部署」（生产化构建）形成
          // 语义对比：越重越黑、越轻越亮。色弱用户还可依赖图标（闪电 vs 火箭）与文案区分。
          className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus:ring-0"
        >
          {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
          {t('deploy:action.quick', { defaultValue: 'Quick preview' })}
        </button>
      )}
      <button
        type="button"
        disabled={isBusy}
        onClick={onAnalyze || deployPreview}
        title={t('deploy:action.deploy_preview', { defaultValue: 'Deploy preview' })}
        className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium rounded-md bg-zinc-900 text-zinc-50 hover:bg-zinc-800 disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus:ring-0"
      >
        {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
        {t('deploy:action.deploy', { defaultValue: 'Deploy' })}
      </button>
    </div>
  );
}