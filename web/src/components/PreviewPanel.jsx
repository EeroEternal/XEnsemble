import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  AppWindow,
  Loader2,
  RefreshCw,
  Rocket,
  Square,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useToast } from './Toast';

const STATUS_STYLES = {
  pending: 'bg-[#E8EAED] text-[#5F6368]',
  building: 'bg-[#FEF3C7] text-[#B45309]',
  running: 'bg-[#E8F5E9] text-[#4A7C59]',
  failed: 'bg-[#FDECEA] text-[#C06C5D]',
  stopped: 'bg-[#E8EAED] text-[#9AA0A6]',
  expired: 'bg-[#E8EAED] text-[#9AA0A6]',
};

function pickActiveDeployment(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const running = list.find((d) => d.status === 'running');
  if (running) return running;
  const building = list.find((d) => d.status === 'building' || d.status === 'pending');
  if (building) return building;
  return list[0];
}

function formatTtl(expiresAt) {
  if (!expiresAt) return '';
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'Expired';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
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

export function usePreview(projectId, token) {
  const { showToast } = useToast();
  const lastFailedToastRef = useRef(null);
  const [deployment, setDeployment] = useState(null);
  const [loading, setLoading] = useState(false);
  const previewWindowRef = useRef(null);
  const hasActiveDeployment = deployment && (deployment.status === 'running' || deployment.status === 'building' || deployment.status === 'pending');

  useEffect(() => {
    lastFailedToastRef.current = null;
    closePreviewWindow(previewWindowRef);
  }, [projectId]);

  useEffect(() => () => closePreviewWindow(previewWindowRef), []);

  const loadDeployments = useCallback(async () => {
    if (!projectId || !token) return;
    try {
      const res = await apiFetch(
        `/api/v1/deployments?project_id=${encodeURIComponent(projectId)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load preview');
      setDeployment((prev) => {
        const next = pickActiveDeployment(data);
        if (prev && next && prev.id === next.id && prev.status === next.status && prev.public_url === next.public_url) return prev;
        return next;
      });
    } catch (e) {
      // Polling errors stay silent; action failures toast in their handlers.
    }
  }, [projectId, token]);

  // Initial fetch on mount / project change
  useEffect(() => {
    if (!projectId || !token) return;
    loadDeployments();
  }, [loadDeployments, projectId, token]);

  // Only poll when there's an active deployment (running/building/pending)
  useEffect(() => {
    if (!hasActiveDeployment) return undefined;
    const id = setInterval(loadDeployments, 4000);
    return () => clearInterval(id);
  }, [loadDeployments, hasActiveDeployment]);

  const deployPreview = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/preview`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Preview deploy failed');
      setDeployment(data);
      if (data.status === 'running' && data.public_url) {
        const url = data.preview_token
          ? `${data.public_url}${data.public_url.includes('?') ? '&' : '?'}preview_token=${encodeURIComponent(data.preview_token)}`
          : null;
        if (url && !openPreviewWindow(url, previewWindowRef)) {
          showToast('error', 'Preview is running. Allow pop-ups to open the preview window.');
        }
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
      if (!res.ok) throw new Error(data.error || 'Stop failed');
      setDeployment(data);
      closePreviewWindow(previewWindowRef);
    } catch (e) {
      showToast('error', e.message);
    } finally {
      setLoading(false);
    }
  };

  const restartPreview = async () => {
    if (!deployment?.id) return;
    setLoading(true);
    try {
      const res = await apiFetch(
        `/api/v1/deployments/${encodeURIComponent(deployment.id)}/start`,
        { method: 'POST' },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.deployment?.last_error_message || 'Restart failed');
      const next = data.deployment || data;
      setDeployment(next);
      if (next.status === 'running' && next.public_url) {
        const url = next.preview_token
          ? `${next.public_url}${next.public_url.includes('?') ? '&' : '?'}preview_token=${encodeURIComponent(next.preview_token)}`
          : null;
        if (url && !openPreviewWindow(url, previewWindowRef)) {
          showToast('error', 'Preview restarted. Allow pop-ups to open the preview window.');
        }
      }
    } catch (e) {
      showToast('error', e.message);
      await loadDeployments();
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
    if (!res.ok) throw new Error(data.error || 'Failed to issue preview token');
    if (!data.preview_token || !deployment.public_url) return null;
    return `${deployment.public_url}${deployment.public_url.includes('?') ? '&' : '?'}preview_token=${encodeURIComponent(data.preview_token)}`;
  }, [deployment?.id, deployment?.public_url, previewUrl]);

  const openPreview = async () => {
    try {
      const url = await resolveEmbedUrl();
      if (!url) return;
      if (!openPreviewWindow(url, previewWindowRef)) {
        showToast('error', 'Allow pop-ups to open the preview window.');
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
    loadDeployments,
    deployPreview,
    stopPreview,
    restartPreview,
    openPreview,
    resolveEmbedUrl,
  };
}

const ICON_BTN =
  'rounded-md p-1.5 text-[#5F6368] hover:bg-[#E8EAED] hover:text-[#202124] disabled:opacity-50';

export function PreviewStatus({ deployment, status }) {
  if (!deployment) return null;
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span
        className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${STATUS_STYLES[status] || STATUS_STYLES.stopped}`}
      >
        {status}
      </span>
      {deployment.expires_at && status === 'running' && (
        <span className="text-[10px] text-[#9AA0A6] font-mono hidden xl:inline">
          TTL {formatTtl(deployment.expires_at)}
        </span>
      )}
    </div>
  );
}

export function PreviewControlGroup(props) {
  const { deployment } = props;
  return (
    <div className="flex items-center gap-0.5 shrink-0">
      <PreviewStatus {...props} />
      {deployment && <div className="h-3.5 w-px bg-[#E8EAED] mx-0.5 shrink-0" aria-hidden />}
      <PreviewActions {...props} />
    </div>
  );
}

export function PreviewActions({
  status,
  isBusy,
  previewUrl,
  openPreview,
  deployPreview,
  stopPreview,
  restartPreview,
  onAnalyze,
}) {
  if (status === 'running') {
    return (
      <>
        {previewUrl && (
          <button
            type="button"
            title="Open preview window"
            onClick={openPreview}
            className={ICON_BTN}
          >
            <AppWindow className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          title="Restart preview"
          disabled={isBusy}
          onClick={restartPreview}
          className={ICON_BTN}
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          title="Stop preview"
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
    <button
      type="button"
      disabled={isBusy}
      onClick={onAnalyze || deployPreview}
      title="Deploy preview"
      className={ICON_BTN}
    >
      {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
    </button>
  );
}