import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

import Button from './Button';
import StatusBadge from './StatusBadge';
import {
  ConsoleDialogShell,
  ConsoleStructuredDialogBody,
  ConsoleStructuredDialogFooter,
  ConsoleStructuredDialogHeader,
} from './ConsoleDialog';
import {
  consoleDialogLgClass,
  consoleSectionLabelClass,
} from '../lib/consoleTokens';
import { formatDuration, getBuildState } from '../lib/imageBuildStates';
import { cn } from '../lib/utils';
import { apiFetch } from '../lib/api';
import { useTranslation } from 'react-i18next';

function formatTime(ts) {
  if (!ts) return '\u2014';
  return new Date(ts).toLocaleString();
}

function stateBadge(state) {
  const entry = getBuildState(state);
  return (
    <StatusBadge tone={entry.tone} icon={entry.icon} spinning={entry.spinning} label={entry.label} />
  );
}

export default function BuildLogDialog({ image, onClose }) {
  const { t } = useTranslation();
  const [logs, setLogs] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadLog = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/v1/custom-images/${image.id}/log`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('images:error.load_build_log_failed'));
      setLogs(data.logs || '');
      setTruncated(Boolean(data.truncated));
      setAvailable(Boolean(data.available));
      setError(null);
    } catch (err) {
      setError(err.message || t('images:error.load_build_log_failed'));
    } finally {
      setLoading(false);
    }
  }, [image.id]);

  useEffect(() => { loadLog(); }, [loadLog]);

  useEffect(() => {
    if (image.status !== 'queued' && image.status !== 'building') return;
    const timer = setInterval(loadLog, 5000);
    return () => clearInterval(timer);
  }, [image.status, loadLog]);

  const build = image.latest_build;
  const durationMs = build?.started_at && build?.finished_at
    ? new Date(build.finished_at) - new Date(build.started_at)
    : null;

  return (
    <ConsoleDialogShell onClose={onClose}>
      <div className={cn(consoleDialogLgClass, 'flex max-h-[90vh] flex-col')}>
        <ConsoleStructuredDialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-bold text-lg text-zinc-900">{image.name}</h3>
              <p className="mt-0.5 truncate font-mono text-xs text-zinc-500">{image.id}</p>
            </div>
            {stateBadge(image.status)}
          </div>
        </ConsoleStructuredDialogHeader>

        <ConsoleStructuredDialogBody>
          {image.status === 'failed' && image.latest_build?.failure_reason && (
            <div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="min-w-0 whitespace-pre-wrap break-words">{image.latest_build.failure_reason}</div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-4">
            <div className="min-w-0">
              <p className={consoleSectionLabelClass}>{t('images:field.started', { defaultValue: 'Started' })}</p>
              <p className="mt-0.5 truncate text-sm text-zinc-700">{formatTime(build?.started_at)}</p>
            </div>
            <div className="min-w-0">
              <p className={consoleSectionLabelClass}>{t('images:field.finished', { defaultValue: 'Finished' })}</p>
              <p className="mt-0.5 truncate text-sm text-zinc-700">{formatTime(build?.finished_at)}</p>
            </div>
            <div className="min-w-0">
              <p className={consoleSectionLabelClass}>{t('images:field.duration', { defaultValue: 'Duration' })}</p>
              <p className="mt-0.5 truncate text-sm text-zinc-700">{formatDuration(durationMs)}</p>
            </div>
          </div>

          <div>
            <p className={consoleSectionLabelClass}>{t('images:build_log')}</p>
            <div className="mt-1.5 max-h-[45vh] overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 console-scroll-hidden">
              {loading ? (
                <p className="flex items-center gap-2 text-xs text-zinc-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('images:loading_log', { defaultValue: 'Loading log…' })}
                </p>
              ) : error ? (
                <p className="text-xs text-red-400">{error}</p>
              ) : !available ? (
                <p className="text-xs text-zinc-400">{t('images:build_not_started', { defaultValue: 'Build has not started yet.' })}</p>
              ) : !logs ? (
                <p className="text-xs text-zinc-400">{t('images:no_log_output', { defaultValue: 'No log output yet.' })}</p>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-zinc-200">
                  {logs}
                </pre>
              )}
            </div>
            {truncated && (
              <p className="mt-1 text-xs text-zinc-400">{t('images:log_truncated', { defaultValue: 'Log truncated — showing the latest portion.' })}</p>
            )}
          </div>
        </ConsoleStructuredDialogBody>

        <ConsoleStructuredDialogFooter>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t('common:action.close')}
          </Button>
        </ConsoleStructuredDialogFooter>
      </div>
    </ConsoleDialogShell>
  );
}
