import { Loader2, Check, GitBranch, Rocket } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  textPlaceholder,
  textPrimary,
  accentGreen,
  accentGreenBg,
  borderHairline,
} from '../lib/consoleTokens';

const STEPS = [
  { id: 'import', label: 'Import repository', icon: GitBranch },
  { id: 'session', label: 'Start session', icon: Rocket },
];

export default function CreationProgress({ currentStep, hasError }) {
  const stepStatus = (stepId) => {
    const idx = STEPS.findIndex((s) => s.id === stepId);
    const currentIdx = STEPS.findIndex((s) => s.id === currentStep);
    if (hasError && idx === currentIdx) return 'error';
    if (idx < currentIdx) return 'done';
    if (idx === currentIdx) return 'active';
    return 'pending';
  };

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="flex flex-col gap-3 w-full max-w-xs">
        {STEPS.map((step, idx) => {
          const status = stepStatus(step.id);
          const Icon = step.icon;
          return (
            <div key={step.id} className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors',
                    status === 'done' && cn(accentGreenBg, 'border-transparent'),
                    status === 'active' && 'bg-zinc-100 border-zinc-300',
                    status === 'error' && 'bg-red-50 border-red-200',
                    status === 'pending' && 'bg-zinc-50 border-zinc-200',
                  )}
                >
                  {status === 'done' ? (
                    <Check className="h-4 w-4 text-emerald-600" strokeWidth={2.5} />
                  ) : status === 'active' ? (
                    <Loader2 className="h-4 w-4 text-zinc-500 animate-spin" strokeWidth={2} />
                  ) : status === 'error' ? (
                    <span className="text-red-500 text-sm font-medium">!</span>
                  ) : (
                    <Icon className={cn('h-4 w-4', textPlaceholder)} strokeWidth={1.75} />
                  )}
                </div>
                <span
                  className={cn(
                    'text-sm font-medium transition-colors',
                    status === 'done' && accentGreen,
                    status === 'active' && textPrimary,
                    status === 'error' && 'text-red-600',
                    status === 'pending' && textPlaceholder,
                  )}
                >
                  {step.label}
                </span>
              </div>
              {idx < STEPS.length - 1 && (
                <div className="ml-4 h-5 w-px">
                  <div
                    className={cn(
                      'h-full w-px transition-colors',
                      status === 'done' ? 'bg-emerald-300' : borderHairline,
                    )}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
