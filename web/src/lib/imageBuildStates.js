import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';

export const BUILD_STATES = {
  queued: { label: 'Queued', icon: Clock, tone: 'warning' },
  building: { label: 'Building…', icon: Loader2, tone: 'info', spinning: true },
  ready: { label: 'Ready', icon: CheckCircle2, tone: 'success' },
  failed: { label: 'Failed', icon: XCircle, tone: 'danger' },
};

export function getBuildState(state) {
  return BUILD_STATES[state] || { label: state || '\u2014', icon: null, tone: 'neutral' };
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
