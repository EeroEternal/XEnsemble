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
    <div className="flex flex-col items-center w-full max-w-xs">
      {STEPS.map((step, idx) => {
        const status = stepStatus(step.id);
        const Icon = step.icon;
        const showConnector = idx < STEPS.length - 1;
        const connectorStatus = stepStatus(STEPS[idx].id);
        return (
          <div key={step.id} className="flex flex-col items-stretch w-full">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                  status === 'done' && cn(accentGreenBg, 'border-emerald-300'),
                  status === 'active' && 'bg-zinc-100 border-zinc-400',
                  status === 'error' && 'bg-red-50 border-red-300',
                  status === 'pending' && 'bg-zinc-50 border-zinc-200',
                )}
              >
                {status === 'done' ? (
                  <Check className="h-4 w-4 text-emerald-600" strokeWidth={2.5} />
                ) : status === 'active' ? (
                  <Loader2 className="h-4 w-4 text-zinc-600 animate-spin" strokeWidth={2} />
                ) : status === 'error' ? (
                  <span className="text-red-500 text-sm font-bold">!</span>
                ) : (
                  <span className={cn('text-sm font-semibold', textPlaceholder)}>{idx + 1}</span>
                )}
              </div>
              <div className="flex items-center gap-2 min-w-0">
                <Icon className={cn('h-4 w-4 shrink-0', status === 'pending' ? textPlaceholder : status === 'done' ? accentGreen : status === 'active' ? textPrimary : 'text-red-500')} strokeWidth={1.75} />
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
            </div>
            {showConnector && (
              <div className="flex justify-start">
                <div className="w-9 flex justify-center">
                  <div
                    className={cn(
                      'w-0.5 h-8 transition-colors rounded-full',
                      connectorStatus === 'done' ? 'bg-emerald-300' : cn(borderHairline, 'bg-zinc-200'),
                    )}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
