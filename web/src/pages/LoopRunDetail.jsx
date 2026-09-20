import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CheckCircle, Clock, Loader2 } from 'lucide-react';

import Button from '../components/Button';
import StatusBadge from '../components/StatusBadge';
import TrajectoryViewer from '../components/trajectory/TrajectoryViewer';
import { consoleButtonFocusClass, textPlaceholder } from '../lib/consoleTokens';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import { listLoopTasks, listLoopTaskRuns, reviewLoopTaskRun } from '../lib/loopTasksApi';
import { useToast } from '../components/Toast';

const RUN_STATUS_TONE = {
  running: 'info',
  awaiting_review: 'warning',
  succeeded: 'success',
  failed: 'danger',
  timeout: 'danger',
};

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * LoopTask run 详情全页（轨迹是重内容 → 独立路由 + 可分享 URL，业界标准）。
 * 路由：/loop-tasks/:taskId/runs/:runId
 */
export default function LoopRunDetail({ className = '', 'aria-hidden': ariaHidden }) {
  const { taskId, runId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [task, setTask] = useState(null);
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  // 复核收口后刷新 run 状态（徽章从 awaiting_review 翻转到终态）
  const refreshRun = () => {
    listLoopTaskRuns(taskId)
      .then((runs) => { setRun(runs.find((x) => x.id === runId) || null); })
      .catch(() => {});
  };

  const handleReview = async (approved) => {
    setReviewing(true);
    try {
      await reviewLoopTaskRun(runId, approved);
      showToast('success', t(approved ? 'loopTasks:toast.approved' : 'loopTasks:toast.rejected'));
      refreshRun();
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setReviewing(false);
    }
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([listLoopTasks(), listLoopTaskRuns(taskId)])
      .then(([tasks, runs]) => {
        if (!active) return;
        setTask(tasks.find((x) => x.id === taskId) || null);
        const found = runs.find((x) => x.id === runId) || null;
        setRun(found);
        setNotFound(!found);
      })
      .catch(() => { if (active) setNotFound(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [taskId, runId]);

  const running = run?.status === 'running';
  const dur = run ? fmtDuration((run.finishedAt ?? (running ? Date.now() : NaN)) - run.startedAt) : null;

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className}`} aria-hidden={ariaHidden}>
      {/* 页头：返回 + 任务名 + run 状态/时长 */}
      <div className="shrink-0 flex items-center gap-3 border-b border-zinc-200 bg-surface px-4 py-2.5">
        <button
          type="button"
          onClick={() => navigate('/loop-tasks')}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 ${consoleButtonFocusClass}`}
          title={t('loopTasks:run_detail.back_to_tasks')}
        >
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.75} />
          {t('loopTasks:nav')}
        </button>
        <div className="min-w-0 flex items-center gap-2.5">
          <h2 className="truncate text-sm font-semibold text-zinc-900">{task?.title || runId}</h2>
          {run && (
            <StatusBadge
              tone={RUN_STATUS_TONE[run.status] || 'neutral'}
              spinning={running}
              label={t(`loopTasks:run.status_${run.status}`, { defaultValue: run.status })}
            />
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-4 text-xs text-zinc-500 tabular-nums">
          {run?.status === 'awaiting_review' && (
            <span className="flex items-center gap-1.5">
              <Button variant="primary" size="sm" disabled={reviewing}
                onClick={() => handleReview(true)}>
                {reviewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                {t('loopTasks:run.approve')}
              </Button>
              <Button variant="secondary" size="sm" disabled={reviewing}
                onClick={() => handleReview(false)}>
                {t('loopTasks:run.reject')}
              </Button>
            </span>
          )}
          {run?.startedAt && <span>{formatRelativeTime(run.startedAt)}</span>}
          {dur && (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {dur}
            </span>
          )}
        </div>
      </div>
      {/* 失败原因（若有） */}
      {run?.error && (
        <p className="shrink-0 border-b border-zinc-200 bg-red-50/60 px-4 py-2 text-xs text-red-700 break-words whitespace-pre-wrap font-mono">
          {run.error}
        </p>
      )}
      {/* 全宽轨迹 */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : notFound || !run ? (
        <p className={`flex flex-1 items-center justify-center text-sm ${textPlaceholder}`}>
          {t('loopTasks:run_detail.not_found')}
        </p>
      ) : run.sessionId ? (
        <TrajectoryViewer key={run.sessionId} sessionId={run.sessionId} live={running} />
      ) : (
        <p className={`flex flex-1 items-center justify-center text-sm ${textPlaceholder}`}>
          {t('loopTasks:run_detail.no_session')}
        </p>
      )}
    </div>
  );
}
