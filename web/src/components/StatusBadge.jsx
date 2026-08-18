import { Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  consoleStatusBadgeClass,
  consoleStatusIconSlotClass,
} from '../lib/consoleTokens';

export const STATUS_TONES = {
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  danger: 'bg-red-50 text-red-700 border-red-200',
  info: 'bg-blue-50 text-blue-700 border-blue-200',
  neutral: 'bg-zinc-100 text-zinc-600 border-zinc-200',
};

export default function StatusBadge({ tone = 'neutral', icon: Icon, spinning = false, label, title, className }) {
  return (
    <span
      title={title}
      className={cn(
        consoleStatusBadgeClass,
        'rounded border px-1.5 py-0.5',
        STATUS_TONES[tone] || STATUS_TONES.neutral,
        className,
      )}
    >
      <span className={consoleStatusIconSlotClass} aria-hidden>
        {spinning ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : Icon ? (
          <Icon className="h-3 w-3" />
        ) : null}
      </span>
      <span>{label}</span>
      <span className={consoleStatusIconSlotClass} aria-hidden />
    </span>
  );
}