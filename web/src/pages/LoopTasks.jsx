import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Plus, Pencil, Play, Pause, Trash2, Loader2, RefreshCw, History as HistoryIcon, CheckCircle, Clock,
  Target, Activity, FileText, MoonStar,
} from 'lucide-react';

import Button from '../components/Button';
import Input, { FormLabel, Textarea } from '../components/Input';
import PageHeader from '../components/PageHeader';
import RowActionsMenu from '../components/RowActionsMenu';
import SelectMenu from '../components/SelectMenu';
import StatusBadge from '../components/StatusBadge';
import { ConsoleDialogShell, ConsoleStructuredDialogHeader, ConsoleStructuredDialogBody, ConsoleStructuredDialogFooter } from '../components/ConsoleDialog';
import { confirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import {
  consoleAdminPageClass,
  consoleAdminTableScrollClass,
  consoleAdminTableShellClass,
  consoleButtonFocusClass,
  consoleIconButtonClass,
  consoleSectionLabelClass,
  consoleStructuredDialogPanelClass,
  consoleTableBodyCellClass,
  consoleTableHeadCellClass,
  consoleTableHeadRowClass,
} from '../lib/consoleTokens';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import { apiFetch } from '../lib/api';
import { parseAtLocal, formatAtLocal } from '../lib/dateTimeFormat';
import { TIMEZONES } from '../lib/timezones';
import { loadTimezonePref } from '../lib/timezonePref';
import DateTimeField from '../components/DateTimeField';
import {
  listLoopTasks, createLoopTask, updateLoopTask, deleteLoopTask, runLoopTaskNow, listLoopTaskRuns, previewSchedule, TASK_RUN_AGENTS,
} from '../lib/loopTasksApi';

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

const TASK_STATUS_META = {
  active: { tone: 'success', icon: Play },
  paused: { tone: 'neutral', icon: Pause },
  completed: { tone: 'neutral', icon: CheckCircle },
};

const RUN_STATUS_META = {
  running: { tone: 'info', spinning: true },
  succeeded: { tone: 'success' },
  failed: { tone: 'danger' },
  timeout: { tone: 'danger' },
};

// 执行时长（ms → "45s" / "1m 32s" / "1h 05m"），业界运行历史（Actions/Vercel）的通用格式
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

function fmtClock(ts) {
  if (!Number.isFinite(ts)) return null;
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const emptyForm = {
  title: '', projectId: '', prompt: '',
  agentId: '', autoApprove: true,
  // GLM/Coze 风格调度预设：自然预设优先，cron 折叠为"自定义"。
  // daily/weekly/weekdays 在前端生成标准 5 段 cron，后端仍只认 cron/every/at。
  // weekdays（工作日）附带 holidayAware：按中国法定日历调度（节假日跳过、调休补班照跑）。
  kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5], holidayAware: false,
  cron: '0 9 * * *', intervalValue: 30, intervalUnit: 'minutes', runAt: '',
  timezone: 'Asia/Shanghai',
};

const SCHEDULE_PRESETS = ['daily', 'weekly', 'weekdays', 'every', 'at', 'cron'];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 显示顺序：一..日（cron 0=周日）

// 任务模板（对齐 zCode 定时任务模板）：一键把 title/prompt/执行计划填进创建弹窗。
// 文案与 prompt 在 i18n（loopTasks:templates.<id>），此处只保留调度形状。
const TASK_TEMPLATES = [
  { id: 'standup', icon: Target, kind: 'weekdays', time: '09:00' },
  { id: 'risk_scan', icon: Activity, kind: 'daily', time: '10:00' },
  { id: 'release_notes', icon: FileText, kind: 'weekly', weekdays: [5], time: '16:00' },
  { id: 'nightly_cleanup', icon: MoonStar, kind: 'daily', time: '03:00' },
];

function timeToCronMMHH(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  if (!m) return null;
  const hh = Number(m[1]); const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return `${mm} ${hh}`;
}

function intervalToParts(ms) {
  if (ms % UNIT_MS.days === 0) return { intervalValue: ms / UNIT_MS.days, intervalUnit: 'days' };
  if (ms % UNIT_MS.hours === 0) return { intervalValue: ms / UNIT_MS.hours, intervalUnit: 'hours' };
  return { intervalValue: Math.round(ms / UNIT_MS.minutes), intervalUnit: 'minutes' };
}

/** 表单 → 调度 payload。不完整/非法返回 { errKey }，合法返回 { schedule }。 */
function buildSchedule(form) {
  if (form.kind === 'daily' || form.kind === 'weekdays' || form.kind === 'weekly') {
    const mmhh = timeToCronMMHH(form.time);
    if (!mmhh) return { errKey: 'time_invalid' };
    let dow = '*';
    if (form.kind === 'weekdays') dow = '1-5';
    else if (form.kind === 'weekly') {
      const days = [...new Set(form.weekdays || [])].sort((a, b) => a - b);
      if (days.length === 0) return { errKey: 'weekday_required' };
      dow = days.join(',');
    }
    return { schedule: { kind: 'cron', cronExpr: `${mmhh} * * ${dow}` } };
  }
  if (form.kind === 'every') {
    const intervalMs = Math.round(Number(form.intervalValue) * UNIT_MS[form.intervalUnit]);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return { errKey: 'interval_invalid' };
    return { schedule: { kind: 'every', intervalMs } };
  }
  if (form.kind === 'at') {
    if (!form.runAt.trim()) return { errKey: 'required' };
    const ms = parseAtLocal(form.runAt); // NaN = 格式错误
    if (!Number.isFinite(ms)) return { errKey: 'datetime_format' };
    return { schedule: { kind: 'at', runAt: ms } };
  }
  const expr = form.cron.trim();
  if (!expr) return { errKey: 'cron_invalid' };
  return { schedule: { kind: 'cron', cronExpr: expr } };
}

/** 服务端任务 → 表单调度字段（反向解析：cron 预设还原为 daily/weekly/weekdays） */
function scheduleToForm(task) {
  const kind = task.scheduleKind || 'cron';
  if (kind === 'every' && task.intervalMs) {
    return { kind: 'every', ...intervalToParts(task.intervalMs), cron: task.cronExpr };
  }
  if (kind === 'at') {
    return { kind: 'at', runAt: task.nextRunAt ? formatAtLocal(task.nextRunAt) : '', cron: task.cronExpr };
  }
  const m = String(task.cronExpr || '').trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\S+)$/);
  if (m) {
    const time = `${String(Number(m[2])).padStart(2, '0')}:${String(Number(m[1])).padStart(2, '0')}`;
    const dow = m[3];
    if (dow === '*') return { kind: 'daily', time, cron: task.cronExpr };
    if (dow === '1-5') return { kind: 'weekdays', time, cron: task.cronExpr };
    if (/^\d+(,\d+)*$/.test(dow)) {
      return { kind: 'weekly', time, weekdays: dow.split(',').map(Number), cron: task.cronExpr };
    }
  }
  return { kind: 'cron', cronExpr: task.cronExpr };
}

export default function LoopTasks({ className = '', 'aria-hidden': ariaHidden }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [tasks, setTasks] = useState([]);
  const [projects, setProjects] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [dialogMode, setDialogMode] = useState(null); // 'create' | 'edit'
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(null); // { id, action } 行内操作进行中

  const [runsOpenFor, setRunsOpenFor] = useState(null); // task 对象
  const [runs, setRuns] = useState([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [selectedRun, setSelectedRun] = useState(null);

  const fetchProjects = useCallback(() => {
    apiFetch('/api/v1/projects')
      .then((res) => res.json())
      .then((data) => setProjects(Array.isArray(data) ? data : (data?.projects || [])))
      .catch(() => {});
  }, []);

  const fetchAgents = useCallback(() => {
    apiFetch('/api/v1/agents')
      .then((res) => res.json())
      .then((data) => setAgents(Array.isArray(data) ? data : (data?.agents || [])))
      .catch(() => {});
  }, []);

  const fetchTasks = useCallback(({ silent = false } = {}) => {
    if (!silent) setRefreshing(true);
    return listLoopTasks()
      .then(setTasks)
      .catch(() => {})
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, []);

  useEffect(() => {
    void fetchTasks();
    fetchProjects();
    fetchAgents();
  }, [fetchTasks, fetchProjects, fetchAgents]);

  const projectName = useCallback((id) => projects.find((p) => p.id === id)?.name || id, [projects]);

  const openCreate = () => {
    setForm({ ...emptyForm, timezone: loadTimezonePref() });
    setEditing(null);
    setDialogMode('create');
  };

  // 从模板创建：预填 title/prompt/执行计划，工作空间与 Agent 仍由用户选择
  const openTemplate = (tpl) => {
    setForm({
      ...emptyForm,
      title: t(`loopTasks:templates.${tpl.id}.title`),
      prompt: t(`loopTasks:templates.${tpl.id}.prompt`),
      kind: tpl.kind,
      time: tpl.time,
      weekdays: tpl.weekdays ? [...tpl.weekdays] : [...emptyForm.weekdays],
      timezone: loadTimezonePref(),
    });
    setEditing(null);
    setDialogMode('create');
  };

  const openEdit = (task) => {
    setEditing(task);
    setForm({
      ...emptyForm,
      title: task.title,
      projectId: task.projectId,
      prompt: task.prompt,
      agentId: task.agentId || '',
      autoApprove: task.autoApprove !== false,
      ...scheduleToForm(task),
      timezone: TIMEZONES.includes(task.timezone) ? task.timezone : 'UTC',
    });
    setDialogMode('edit');
  };

  const closeDialog = () => { setDialogMode(null); setEditing(null); };

  const save = async () => {
    if (!form.title.trim() || !form.prompt.trim() || !form.projectId) {
      showToast('error', t('loopTasks:error.required'));
      return;
    }
    if (!form.agentId) {
      showToast('error', t('loopTasks:error.agent_required'));
      return;
    }
    const { schedule, errKey } = buildSchedule(form);
    if (!schedule) { showToast('error', t(`loopTasks:error.${errKey}`)); return; }
    setSaving(true);
    try {
      // 工作日预设携带法定日历感知；其他预设一律关闭
      const holidayAware = form.kind === 'weekdays' ? true : false;
      if (dialogMode === 'create') {
        await createLoopTask({
          title: form.title.trim(),
          prompt: form.prompt.trim(),
          projectId: form.projectId,
          agentId: form.agentId,
          autoApprove: form.autoApprove,
          holidayAware,
          schedule,
          timezone: form.timezone,
        });
        showToast('success', t('loopTasks:toast.created'));
      } else {
        await updateLoopTask(editing.id, {
          title: form.title.trim(),
          prompt: form.prompt.trim(),
          agentId: form.agentId,
          autoApprove: form.autoApprove,
          holidayAware,
          ...schedule,
          timezone: form.timezone,
        });
        showToast('success', t('loopTasks:toast.updated'));
      }
      closeDialog();
      fetchTasks({ silent: true });
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setSaving(false);
    }
  };

  const act = async (fn, okMsg) => {
    try {
      await fn();
      if (okMsg) showToast('success', okMsg);
      fetchTasks({ silent: true });
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setBusy(null);
    }
  };

  const togglePause = (task) => {
    setBusy({ id: task.id, action: 'pause' });
    act(
      () => updateLoopTask(task.id, { status: task.status === 'active' ? 'paused' : 'active' }),
      t('loopTasks:toast.updated'),
    );
  };

  const runNow = (task) => {
    setBusy({ id: task.id, action: 'run' });
    act(() => runLoopTaskNow(task.id), t('loopTasks:toast.run_started'));
  };

  const handleDelete = async (task) => {
    const ok = await confirm({
      title: t('common:dialog.confirm_delete', { name: task.title, defaultValue: `Delete "${task.title}"?` }),
      message: t('common:dialog.cannot_undo', { defaultValue: 'This action cannot be undone.' }),
      confirmLabel: t('common:action.delete'),
      cancelLabel: t('common:action.cancel'),
      variant: 'danger',
    });
    if (!ok) return;
    setBusy({ id: task.id, action: 'delete' });
    await act(() => deleteLoopTask(task.id), t('loopTasks:toast.deleted'));
  };

  // 执行历史：打开时拉取；有 running run 时 5s 轮询（runsRef 避免闭包过期）
  const runsRef = useRef([]);
  const fetchRuns = useCallback((taskId) => {
    listLoopTaskRuns(taskId)
      .then((list) => {
        runsRef.current = list;
        setRuns(list);
        setSelectedRun((prev) => (prev ? (list.find((r) => r.id === prev.id) || list[0] || null) : (list[0] || null)));
      })
      .catch(() => {})
      .finally(() => setRunsLoading(false));
  }, []);

  useEffect(() => {
    if (!runsOpenFor) return undefined;
    setRunsLoading(true);
    fetchRuns(runsOpenFor.id);
    const timer = setInterval(() => {
      if (runsRef.current.some((r) => r.status === 'running')) fetchRuns(runsOpenFor.id);
    }, 5000);
    return () => clearInterval(timer);
  }, [runsOpenFor, fetchRuns]);

  const workspaceOptions = useMemo(() => projects.map((p) => ({ value: p.id, label: p.name })), [projects]);
  const agentOptions = useMemo(() => agents
    .filter((a) => TASK_RUN_AGENTS.includes(a.id))
    .map((a) => ({ value: a.id, label: a.name })), [agents]);
  const schedulePresets = useMemo(() => SCHEDULE_PRESETS.map((v) => ({ value: v, label: t(`loopTasks:kind.${v}`) })), [t]);
  const weekdayLabels = useMemo(() => WEEKDAY_ORDER.map((dow) => ({ dow, label: t(`loopTasks:weekday.${dow}`) })), [t]);
  const unitOptions = useMemo(() => [
    { value: 'minutes', label: t('loopTasks:unit.minutes') },
    { value: 'hours', label: t('loopTasks:unit.hours') },
    { value: 'days', label: t('loopTasks:unit.days') },
  ], [t]);

  // Schedule 实时预览：输入变更防抖 300ms → 服务端返回人类可读描述或行内错误
  const [cronHint, setCronHint] = useState(null);
  useEffect(() => {
    if (!dialogMode) { setCronHint(null); return undefined; }
    const { schedule, errKey } = buildSchedule(form);
    if (!schedule) {
      setCronHint(errKey === 'datetime_format' ? { error: t('loopTasks:error.datetime_format') } : null);
      return undefined;
    }
    const timer = setTimeout(() => {
      previewSchedule({ ...schedule, timezone: form.timezone })
        .then(setCronHint)
        .catch(() => setCronHint(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [form, dialogMode, t]);

  return (
    <div className={`${consoleAdminPageClass} px-4 sm:px-6 lg:px-8 py-6 ${className}`} aria-hidden={ariaHidden}>
      <PageHeader title={t('loopTasks:title')} />

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-zinc-500 shrink-0">{t('loopTasks:count', { count: tasks.length })}</span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => fetchTasks()} disabled={refreshing} className={consoleIconButtonClass} title={t('common:action.refresh')}>
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
          <Button type="button" onClick={openCreate} size="md" className="shrink-0">
            <Plus className="w-4 h-4" />
            {t('loopTasks:new_task')}
          </Button>
        </div>
      </div>

      {/* 任务模板：一键套用预设（对齐 zCode 定时任务模板） */}
      <div>
        <p className={`${consoleSectionLabelClass} mb-2`}>{t('loopTasks:templates.label')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TASK_TEMPLATES.map((tpl) => {
            const Icon = tpl.icon;
            return (
              <button
                key={tpl.id}
                type="button"
                onClick={() => openTemplate(tpl)}
                className={`bg-white border border-zinc-200 rounded-lg shadow-sm p-4 text-left transition-colors hover:border-zinc-300 hover:shadow ${consoleButtonFocusClass}`}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                  <Icon className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                  <span className="truncate">{t(`loopTasks:templates.${tpl.id}.title`)}</span>
                </span>
                <span className="mt-1.5 block text-xs leading-relaxed text-zinc-500 line-clamp-2">
                  {t(`loopTasks:templates.${tpl.id}.desc`)}
                </span>
                <span className="mt-2 block text-xs text-zinc-400">
                  {t(`loopTasks:templates.${tpl.id}.schedule`)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={consoleAdminTableShellClass}>
        <div className={consoleAdminTableScrollClass}>
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <colgroup>
              <col className="w-[18%]" />
              <col className="w-[12%]" />
              <col className="w-[11%]" />
              <col className="w-[13%]" />
              <col className="w-[11%]" />
              <col className="w-[11%]" />
              <col className="w-[11%]" />
              <col className="w-28" />
              <col className="w-14" />
            </colgroup>
            <thead className="sticky top-0 z-10 console-table-head-sticky">
              <tr className={consoleTableHeadRowClass}>
                <th className={consoleTableHeadCellClass}>{t('loopTasks:field.title')}</th>
                <th className={consoleTableHeadCellClass}>{t('loopTasks:field.workspace')}</th>
                <th className={consoleTableHeadCellClass}>{t('loopTasks:field.agent')}</th>
                <th className={consoleTableHeadCellClass}>{t('loopTasks:field.schedule')}</th>
                <th className={consoleTableHeadCellClass}>{t('common:table.status', { defaultValue: 'Status' })}</th>
                <th className={consoleTableHeadCellClass}>{t('loopTasks:run.last_run')}</th>
                <th className={consoleTableHeadCellClass}>{t('loopTasks:run.next_run')}</th>
                <th className={consoleTableHeadCellClass}>{t('loopTasks:run.history')}</th>
                <th className={consoleTableHeadCellClass}>{t('common:table.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {loading ? (
                <tr><td colSpan={8} className={`${consoleTableBodyCellClass} text-zinc-400`}>{t('common:state.loading')}</td></tr>
              ) : tasks.length === 0 ? (
                <tr><td colSpan={8} className={`${consoleTableBodyCellClass} text-center text-zinc-400`}>{t('loopTasks:empty')}</td></tr>
              ) : tasks.map((task) => {
                const meta = TASK_STATUS_META[task.status] || TASK_STATUS_META.paused;
                return (
                  <tr key={task.id} className="hover:bg-zinc-50/50">
                    <td className={consoleTableBodyCellClass}>
                      <div className="font-medium text-zinc-900 truncate" title={task.title}>{task.title}</div>
                      <div className="text-xs text-zinc-400 truncate" title={task.prompt}>{task.prompt}</div>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <span className="text-zinc-700 truncate block" title={projectName(task.projectId)}>{projectName(task.projectId)}</span>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <span className="text-zinc-700 truncate block" title={task.agentId}>
                        {agents.find((a) => a.id === task.agentId)?.name || task.agentId || '—'}
                      </span>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <span className="text-zinc-700 truncate block" title={task.cronExpr}>
                        {task.scheduleDescription || task.cronExpr}
                      </span>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <StatusBadge tone={meta.tone} icon={meta.icon} label={t(`loopTasks:status.${task.status}`, { defaultValue: task.status })} />
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <span className="text-xs text-zinc-500" title={task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : ''}>
                        {task.lastRunAt ? formatRelativeTime(task.lastRunAt) : t('loopTasks:run.never')}
                      </span>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      {task.status === 'active' && task.nextRunAt ? (
                        <span className="text-xs text-zinc-500" title={new Date(task.nextRunAt).toLocaleString()}>
                          {new Date(task.nextRunAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      ) : '—'}
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <button
                        type="button"
                        onClick={() => { setSelectedRun(null); setRuns([]); setRunsOpenFor(task); }}
                        className={consoleIconButtonClass}
                        title={t('loopTasks:run.history')}
                        aria-label={t('loopTasks:run.history')}
                      >
                        <HistoryIcon className="w-3.5 h-3.5" />
                      </button>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <RowActionsMenu
                        label={t('loopTasks:actions_for', { title: task.title, defaultValue: `Actions for ${task.title}` })}
                        items={[
                          { icon: Play, label: t('loopTasks:action.run_now'), onClick: () => runNow(task), busy: busy?.id === task.id && busy.action === 'run' },
                          { icon: task.status === 'active' ? Pause : Play, label: t(task.status === 'active' ? 'loopTasks:action.pause' : 'loopTasks:action.resume'), onClick: () => togglePause(task), busy: busy?.id === task.id && busy.action === 'pause' },
                          { icon: Pencil, label: t('loopTasks:action.edit'), onClick: () => openEdit(task) },
                          { separator: true },
                          { icon: Trash2, label: t('common:action.delete'), danger: true, onClick: () => handleDelete(task), busy: busy?.id === task.id && busy.action === 'delete' },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {dialogMode && (
        <ConsoleDialogShell onClose={closeDialog}>
          <div className={`${consoleStructuredDialogPanelClass} w-[480px] max-w-[calc(100vw-2rem)]`}>
            <ConsoleStructuredDialogHeader
              title={t(dialogMode === 'create' ? 'loopTasks:new_task' : 'loopTasks:action.edit')}
            />
            <ConsoleStructuredDialogBody>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <FormLabel htmlFor="loop-task-title">{t('loopTasks:field.title')}</FormLabel>
                  <Input
                    id="loop-task-title"
                    autoFocus
                    value={form.title}
                    onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                    placeholder={t('loopTasks:field.title_placeholder')}
                    maxLength={80}
                  />
                </div>
                <div className="space-y-1.5">
                  <FormLabel htmlFor="loop-task-workspace">{t('loopTasks:field.workspace')}</FormLabel>
                  <SelectMenu
                    value={form.projectId}
                    onChange={(v) => setForm((f) => ({ ...f, projectId: v }))}
                    options={workspaceOptions}
                    placeholder={t('loopTasks:field.workspace_placeholder')}
                    disabled={dialogMode === 'edit'}
                  />
                </div>
                <div className="space-y-1.5">
                  <FormLabel htmlFor="loop-task-agent">{t('loopTasks:field.agent')}</FormLabel>
                  <SelectMenu value={form.agentId} onChange={(v) => setForm((f) => ({ ...f, agentId: v }))}
                    options={agentOptions} placeholder={t('loopTasks:field.agent_placeholder')} />
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-xs text-zinc-500">{t('loopTasks:field.auto_approve')}</span>
                    <div className="w-36">
                      <SelectMenu value={form.autoApprove ? 'yes' : 'no'}
                        onChange={(v) => setForm((f) => ({ ...f, autoApprove: v === 'yes' }))}
                        options={[{ value: 'yes', label: t('loopTasks:auto_approve.yes') }, { value: 'no', label: t('loopTasks:auto_approve.no') }]} />
                    </div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <FormLabel htmlFor="loop-task-prompt">{t('loopTasks:field.prompt')}</FormLabel>
                  <Textarea
                    id="loop-task-prompt"
                    rows={6}
                    value={form.prompt}
                    onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
                    placeholder={t('loopTasks:field.prompt_placeholder')}
                  />
                  <p className="text-xs text-zinc-500">{t('loopTasks:field.prompt_help')}</p>
                </div>
                <div className="space-y-1.5">
                  <FormLabel htmlFor="loop-task-schedule">{t('loopTasks:field.schedule')}</FormLabel>
                  {/* GLM/Coze 式预设 pills：自然预设优先，cron 折叠为高级自定义 */}
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('loopTasks:field.schedule')}>
                    {schedulePresets.map((p) => (
                      <button key={p.value} type="button" onClick={() => setForm((f) => ({ ...f, kind: p.value, holidayAware: p.value === 'weekdays' }))}
                        aria-pressed={form.kind === p.value}
                        className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                          form.kind === p.value
                            ? 'border-zinc-900 bg-zinc-900 text-zinc-50'
                            : 'border-zinc-300 text-zinc-600 hover:border-zinc-400 hover:text-zinc-900'
                        }`}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                  {/* 固定高度变体区：min-h 取最高变体（weekly = 周几 chips 28 + 间距 8 + 时间 38 = 74），
                      切换预设时弹窗高度不变（DESIGN.md 页面稳定性原则） */}
                  <div className="min-h-[74px]">
                    {form.kind === 'weekly' && (
                      <div className="mb-2 flex flex-wrap gap-1">
                        {weekdayLabels.map(({ dow, label }) => {
                          const active = (form.weekdays || []).includes(dow);
                          return (
                            <button key={dow} type="button" aria-pressed={active}
                              onClick={() => setForm((f) => ({
                                ...f,
                                weekdays: active ? (f.weekdays || []).filter((d) => d !== dow) : [...(f.weekdays || []), dow],
                              }))}
                              className={`h-7 w-9 rounded-md border text-xs font-medium transition-colors ${
                                active ? 'border-zinc-900 bg-zinc-900 text-zinc-50' : 'border-zinc-300 text-zinc-500 hover:border-zinc-400 hover:text-zinc-900'
                              }`}>
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {(form.kind === 'daily' || form.kind === 'weekly' || form.kind === 'weekdays') && (
                      <Input id="loop-task-time" type="time" value={form.time}
                        onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))} className="h-[38px] w-36" />
                    )}
                    {form.kind === 'every' && (
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          type="number"
                          min="1"
                          value={form.intervalValue}
                          onChange={(e) => setForm((f) => ({ ...f, intervalValue: e.target.value }))}
                          className="h-[38px]"
                        />
                        <SelectMenu
                          value={form.intervalUnit}
                          onChange={(v) => setForm((f) => ({ ...f, intervalUnit: v }))}
                          options={unitOptions}
                        />
                      </div>
                    )}
                    {form.kind === 'at' && (
                      <DateTimeField
                        id="loop-task-at"
                        value={form.runAt}
                        onChange={(v) => setForm((f) => ({ ...f, runAt: v }))}
                        placeholder="YYYY-MM-DD HH:mm"
                      />
                    )}
                    {form.kind === 'cron' && (
                      <Input
                        id="loop-task-cron"
                        value={form.cron}
                        onChange={(e) => setForm((f) => ({ ...f, cron: e.target.value }))}
                        placeholder={t('loopTasks:field.cron_placeholder')}
                        className="font-mono h-[38px]"
                      />
                    )}
                  </div>
                  {/* 固定预留一行高度：描述/错误出现或消失时弹窗不抖动（DESIGN.md 页面稳定性） */}
                  <p className={`min-h-4 text-xs ${cronHint?.error ? 'text-red-700' : 'text-zinc-500'}`}>
                    {cronHint?.error || cronHint?.description || ''}
                  </p>
                </div>
                {/* 时区不暴露 UI：静默取用户全局偏好并随任务落库（改全局偏好不影响存量任务） */}
              </div>
            </ConsoleStructuredDialogBody>
            <ConsoleStructuredDialogFooter>
              <Button variant="secondary" size="sm" onClick={closeDialog} disabled={saving}>
                {t('common:action.cancel')}
              </Button>
              <Button size="sm" onClick={save} disabled={saving}>
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t(dialogMode === 'create' ? 'loopTasks:action.create' : 'common:action.save')}
              </Button>
            </ConsoleStructuredDialogFooter>
          </div>
        </ConsoleDialogShell>
      )}

      {runsOpenFor && (
        <ConsoleDialogShell onClose={() => setRunsOpenFor(null)}>
          <div className={`${consoleStructuredDialogPanelClass} w-[760px] max-w-[calc(100vw-2rem)]`}>
            <ConsoleStructuredDialogHeader
              title={`${t('loopTasks:run.history')} · ${runsOpenFor.title}`}
              subtitle={projectName(runsOpenFor.projectId)}
            />
            <ConsoleStructuredDialogBody>
              {runsLoading && runs.length === 0 ? (
                <p className="text-sm text-zinc-400 py-4 text-center">{t('common:state.loading')}</p>
              ) : runs.length === 0 ? (
                <p className="text-sm text-zinc-400 py-4 text-center">{t('loopTasks:run.no_runs')}</p>
              ) : (
                // 左右分栏（Actions/Vercel run 历史标准布局）：列表与详情各自独立滚动，
                // 点击任意记录详情常驻视口——纵向堆叠时点顶部记录看不到下方详情
                <div className="flex gap-3 h-[440px]">
                  {/* 左：run 列表 */}
                  <div className="w-60 shrink-0 overflow-y-auto console-scroll-hidden space-y-1 pr-1">
                    {runs.map((run) => {
                      const meta = RUN_STATUS_META[run.status] || RUN_STATUS_META.failed;
                      const dur = fmtDuration((run.finishedAt ?? (run.status === 'running' ? Date.now() : NaN)) - run.startedAt);
                      return (
                        <button
                          key={run.id}
                          type="button"
                          onClick={() => setSelectedRun(run)}
                          className={`w-full flex flex-col gap-1 rounded-md px-3 py-2 text-left transition-colors duration-150 hover:bg-zinc-100 ${selectedRun?.id === run.id ? 'bg-zinc-100' : ''}`}
                        >
                          <span className="flex items-center gap-2">
                            <StatusBadge
                              tone={meta.tone}
                              spinning={meta.spinning}
                              label={t(`loopTasks:run.status_${run.status}`, { defaultValue: run.status })}
                            />
                            <span className="flex-1 min-w-0 truncate text-xs text-zinc-600 text-right">
                              {run.startedAt ? formatRelativeTime(run.startedAt) : ''}
                            </span>
                          </span>
                          <span className="flex items-center gap-3 text-xs text-zinc-400 tabular-nums">
                            {dur && (
                              <span className="inline-flex items-center gap-1" title={t('loopTasks:run.duration')}>
                                <Clock className="h-3 w-3" />
                                {dur}
                              </span>
                            )}
                            {run.rounds != null && (
                              <span>{t('loopTasks:run.rounds', { count: run.rounds })}</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {/* 右：选中 run 的详情（轨迹是重内容 → 全页打开，业界标准） */}
                  <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
                    {selectedRun ? (
                      <div className="flex-1 min-h-0 overflow-y-auto console-scroll-hidden">
                        <div className="rounded-lg border border-zinc-200 bg-zinc-50/70 p-3">
                          {/* 摘要行：开始时刻 · 时长 · 轮次 —— Actions/Vercel run 详情的通用头部 */}
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500 mb-2 tabular-nums">
                            {selectedRun.startedAt && (
                              <span>
                                <span className="text-zinc-400">{t('loopTasks:run.started')} </span>
                                {fmtClock(selectedRun.startedAt)}
                              </span>
                            )}
                            {(() => {
                              const dur = fmtDuration((selectedRun.finishedAt ?? (selectedRun.status === 'running' ? Date.now() : NaN)) - selectedRun.startedAt);
                              return dur ? (
                                <span>
                                  <span className="text-zinc-400">{t('loopTasks:run.duration')} </span>
                                  {dur}
                                </span>
                              ) : null;
                            })()}
                            {selectedRun.rounds != null && (
                              <span>{t('loopTasks:run.rounds', { count: selectedRun.rounds })}</span>
                            )}
                            {selectedRun.sessionId && (
                              <button
                                type="button"
                                onClick={() => navigate(`/loop-tasks/${runsOpenFor.id}/runs/${selectedRun.id}`)}
                                className={`ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 hover:underline ${consoleButtonFocusClass}`}
                              >
                                {t('loopTasks:run.view_trajectory')}
                              </button>
                            )}
                          </div>
                          {selectedRun.result && (
                            <div className="mb-2">
                              <p className="text-xs font-semibold text-zinc-700 mb-1">{t('loopTasks:run.result')}</p>
                              <div className="max-h-40 overflow-y-auto console-scroll-hidden rounded-md border border-zinc-200 bg-white px-2.5 py-2">
                                <p className="text-xs text-zinc-700 whitespace-pre-wrap break-words">{selectedRun.result}</p>
                              </div>
                            </div>
                          )}
                          {selectedRun.error && (
                            <p className="text-xs text-red-700 mb-2 break-words whitespace-pre-wrap font-mono">
                              <span className="font-semibold">{t('loopTasks:run.error')}: </span>
                              {selectedRun.error}
                            </p>
                          )}
                          <div className="space-y-1">
                            {(selectedRun.logs || []).map((entry, i) => (
                              <div key={i} className="flex items-baseline gap-2 text-xs font-mono">
                                <span className="shrink-0 text-zinc-400 tabular-nums">{fmtClock(entry.ts) ?? `#${entry.round}`}</span>
                                <span className="shrink-0 text-zinc-700 font-semibold">{entry.action}</span>
                                <span className="min-w-0 flex-1 break-all text-zinc-500">{entry.summary}</span>
                              </div>
                            ))}
                            {(selectedRun.logs || []).length === 0 && !selectedRun.error && !selectedRun.result && (
                              <p className="text-xs text-zinc-400">{selectedRun.status === 'running' ? '…' : '—'}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="h-full flex items-center justify-center text-xs text-zinc-400">
                        {t('loopTasks:run.select_hint', { defaultValue: '← 选择一条执行记录查看详情' })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </ConsoleStructuredDialogBody>
            <ConsoleStructuredDialogFooter>
              <Button variant="secondary" size="sm" onClick={() => setRunsOpenFor(null)}>
                {t('common:action.close', { defaultValue: 'Close' })}
              </Button>
            </ConsoleStructuredDialogFooter>
          </div>
        </ConsoleDialogShell>
      )}
    </div>
  );
}
