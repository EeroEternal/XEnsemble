import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Copy, Check, X } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * SessionReportPanel — 会话过程报告面板（TrajectoryViewer 右侧滑入层）。
 *
 * 三块内容：LLM 提示词改进建议（before → after 对照，可复制 after）、
 * 规则层过程指标与检测问题（evidence seq 可点击跳转对应轨迹条目）、
 * Agent 观察（环境类问题，弱化灰字）。
 * LLM 未配置（engine='rules'）时建议区显示配置引导。
 */

// 问题码 → severity 色板（与 TrajectoryViewer KIND_STYLES 同一套语义色约定）
const SEV_DOT = {
  critical: 'bg-red-500 dark:bg-red-400',
  warn: 'bg-amber-500 dark:bg-amber-400',
  info: 'bg-sky-500 dark:bg-sky-400',
};

const METRIC_KEYS = [
  ['turnCount', 'report_metric_turns'],
  ['userTurnCount', 'report_metric_user_turns'],
  ['toolCallCount', 'report_metric_tool_calls'],
  ['errorCallCount', 'report_metric_errors'],
  ['snapshotCount', 'report_metric_compactions'],
  ['corrections', 'report_metric_corrections'],
];

function SuggestionCard({ suggestion, copied, onCopy }) {
  const { t } = useTranslation('sessions');
  return (
    <div className={cn('rounded-md border p-3 space-y-2', 'border-zinc-200 bg-zinc-50')}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-semibold text-zinc-900">{suggestion.title}</span>
        <button
          type="button"
          onClick={onCopy}
          title={copied ? t('trajectory.report_copied') : t('trajectory.report_copy')}
          className={cn(
            'inline-flex items-center gap-1 shrink-0 text-[11px] px-1.5 h-5 rounded border',
            'border-zinc-300 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900',
            'font-mono',
          )}
        >
          {copied ? <Check className="w-3 h-3" strokeWidth={2} /> : <Copy className="w-3 h-3" strokeWidth={1.75} />}
        </button>
      </div>
      {suggestion.problem && <p className="text-[11px] leading-relaxed text-zinc-600">{suggestion.problem}</p>}
      <div className="grid gap-1.5">
        <div className="rounded border border-zinc-200 bg-surface px-2 py-1.5">
          <span className="text-[10px] uppercase tracking-wider text-zinc-400">before</span>
          <p className="text-[11.5px] leading-relaxed text-zinc-500 whitespace-pre-wrap break-words line-through decoration-zinc-300">{suggestion.before}</p>
        </div>
        <div className="rounded border border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/30 dark:bg-emerald-500/10 px-2 py-1.5">
          <span className="text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">after</span>
          <p className="text-[11.5px] leading-relaxed text-zinc-800 whitespace-pre-wrap break-words">{suggestion.after}</p>
        </div>
      </div>
    </div>
  );
}

export default function SessionReportPanel({ report, onClose, onJumpToSeq, onCopyAfter, copiedAfter }) {
  const { t } = useTranslation('sessions');
  const advice = report?.advice || null;
  const issues = useMemo(() => (Array.isArray(report?.issues) ? report.issues : []), [report]);
  const metrics = report?.metrics || {};

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部 */}
      <div className={cn('shrink-0 h-10 px-4 flex items-center gap-2 border-b', 'border-zinc-200')}>
        <Sparkles className="w-3.5 h-3.5 text-violet-500 dark:text-violet-400" strokeWidth={1.75} />
        <span className="text-xs font-semibold text-zinc-900">{t('trajectory.report_title')}</span>
        {report?.engine === 'rules+llm' && (
          <span className="inline-flex h-4 px-1.5 items-center rounded-full border border-violet-200 bg-violet-100 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/15 dark:text-violet-300 text-[10px] font-medium">
            LLM
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          title={t('trajectory.report_close')}
          className={cn('inline-flex items-center justify-center w-6 h-6 rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900')}
        >
          <X className="w-3.5 h-3.5" strokeWidth={1.75} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
        {/* 总体评价 */}
        {advice?.overall && (
          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">{t('trajectory.report_overall')}</h4>
            <p className="text-[12px] leading-relaxed text-zinc-800">{advice.overall}</p>
          </section>
        )}

        {/* 提示词改进建议 */}
        <section className="space-y-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{t('trajectory.report_suggestions')}</h4>
          {advice
            ? (advice.promptSuggestions.length > 0
                ? advice.promptSuggestions.map((s, i) => (
                    <SuggestionCard key={i} suggestion={s} copied={copiedAfter === s} onCopy={() => onCopyAfter?.(s)} />
                ))
                : <p className="text-[11px] text-zinc-500">{t('trajectory.report_advice_empty')}</p>)
            : <p className="text-[11px] text-zinc-500">{t('trajectory.report_llm_hint')}</p>}
        </section>

        {/* 过程指标 */}
        <section>
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">{t('trajectory.report_metrics')}</h4>
          <div className="grid grid-cols-3 gap-1.5">
            {METRIC_KEYS.map(([key, label]) => (
              <div key={key} className="rounded-md border border-zinc-200 bg-surface px-2 py-1.5">
                <div className="text-base font-mono font-medium text-zinc-900 leading-tight">{metrics[key] ?? 0}</div>
                <div className="text-[10px] text-zinc-500 leading-tight">{t(`trajectory.${label}`)}</div>
              </div>
            ))}
          </div>
        </section>

        {/* 检测到的问题 */}
        <section className="space-y-1.5">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{t('trajectory.report_issues')}</h4>
          {issues.length === 0 && <p className="text-[11px] text-zinc-500">{t('trajectory.report_no_issues')}</p>}
          {issues.map((issue, i) => (
            <div key={i} className="rounded-md border border-zinc-200 bg-surface px-2.5 py-2 space-y-1">
              <div className="flex items-center gap-1.5">
                <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', SEV_DOT[issue.severity] || SEV_DOT.info)} />
                <span className="font-mono text-[11px] text-zinc-800">{issue.code}</span>
                <span className="text-[10px] text-zinc-400">×{issue.count}</span>
              </div>
              {(issue.evidence || []).map((ev, j) => (
                <button
                  key={j}
                  type="button"
                  onClick={() => ev.seq != null && onJumpToSeq?.(ev.seq)}
                  className="block w-full text-left text-[11px] text-zinc-500 hover:text-zinc-800 break-words"
                >
                  {ev.seq != null && <span className="font-mono text-zinc-400 mr-1">#{ev.seq}</span>}
                  {ev.excerpt}
                </button>
              ))}
            </div>
          ))}
        </section>

        {/* Agent 观察 */}
        {advice?.agentNotes?.length > 0 && (
          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">{t('trajectory.report_agent_notes')}</h4>
            <ul className="space-y-1">
              {advice.agentNotes.map((n, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-zinc-500 flex gap-1.5">
                  <span className="text-zinc-300 shrink-0">·</span>
                  <span className="break-words">{n}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
