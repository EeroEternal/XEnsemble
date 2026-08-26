import { Loader2, Check, GitBranch, Rocket, AlertCircle, ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/utils';
import {
  textPlaceholder,
  textPrimary,
  accentGreen,
  accentGreenBg,
  borderHairline,
  consoleButtonFocusClass,
} from '../lib/consoleTokens';
import { buttonClass } from '../lib/buttonStyles';

const DEFAULT_STEPS = [
  { id: 'import', labelKey: 'sessions:creation.import_repository', icon: GitBranch },
  { id: 'session', labelKey: 'sessions:creation.start_session', icon: Rocket },
];

// 通用两阶段步骤进度条。steps 可自定义（label 直接文案，或 labelKey 走 i18n）；
// currentStep = 当前步骤 id；error 非空时当前步骤显示错误并可 onDismiss。
export default function CreationProgress({ currentStep, error, onDismiss, steps = DEFAULT_STEPS }) {
  const { t } = useTranslation();
  const hasError = Boolean(error);
  const stepStatus = (stepId) => {
    const idx = steps.findIndex((s) => s.id === stepId);
    const currentIdx = steps.findIndex((s) => s.id === currentStep);
    if (hasError && idx === currentIdx) return 'error';
    if (idx < currentIdx) return 'done';
    if (idx === currentIdx) return 'active';
    return 'pending';
  };

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="flex flex-col items-stretch w-full max-w-xs">
        {steps.map((step, idx) => {
          const status = stepStatus(step.id);
          const Icon = step.icon;
          const showConnector = idx < steps.length - 1;
          const connectorStatus = stepStatus(steps[idx].id);
          const label = step.label ?? t(step.labelKey);
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
                    <AlertCircle className="h-4 w-4 text-red-500" strokeWidth={2} />
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
                    {label}
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
      {hasError && (
        <div className="flex flex-col items-center gap-3 mt-2">
          <p className="text-sm text-red-600 max-w-xs text-center">{error}</p>
          <button
            type="button"
            onClick={onDismiss}
            className={`${buttonClass('secondary', 'sm')} ${consoleButtonFocusClass}`}
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
            {t('sessions:action.back_to_workspaces')}
          </button>
        </div>
      )}
    </div>
  );
}
