import i18next from 'i18next';
import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';

export const BUILD_STATES = {
  queued: { icon: Clock, tone: 'warning' },
  building: { icon: Loader2, tone: 'info', spinning: true },
  ready: { icon: CheckCircle2, tone: 'success' },
  failed: { icon: XCircle, tone: 'danger' },
};

const STATE_LABELS = {
  queued: () => i18next.t('images:status.queued'),
  building: () => i18next.t('images:status.building'),
  ready: () => i18next.t('images:status.ready', { defaultValue: 'Ready' }),
  failed: () => i18next.t('images:status.failed'),
};

export function getBuildState(state) {
  const entry = BUILD_STATES[state];
  if (!entry) return { label: state || '\u2014', icon: null, tone: 'neutral' };
  return { ...entry, label: STATE_LABELS[state] ? STATE_LABELS[state]() : state };
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '\u2014';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
