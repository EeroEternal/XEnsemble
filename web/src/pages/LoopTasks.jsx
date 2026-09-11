import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus, Pencil, Play, Pause, Trash2, Loader2, RefreshCw, History as HistoryIcon, CheckCircle,
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
  consoleIconButtonClass,
  consoleStructuredDialogPanelClass,
  consoleTableBodyCellClass,
  consoleTableHeadCellClass,
  consoleTableHeadRowClass,
} from '../lib/consoleTokens';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import { apiFetch } from '../lib/api';
import { parseAtLocal, formatAtLocal } from '../lib/dateTimeFormat';
import DateTimeField from '../components/DateTimeField';
import {
  listLoopTasks, createLoopTask, updateLoopTask, deleteLoopTask, runLoopTaskNow, listLoopTaskRuns, previewSchedule,
} from '../lib/loopTasksApi';

// 与后端 routes/loopTasks.js 保持一致
const TIMEZONES = [
  'UTC', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul',
  'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles',
];

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

const emptyForm = {
  title: '', projectId: '', prompt: '',
  kind: 'cron', cron: '0 9 * * *', intervalValue: 30, intervalUnit: 'minutes', runAt: '',
  timezone: 'Asia/Shanghai',
};

function intervalToParts(ms) {
  if (ms % UNIT_MS.days === 0) return { intervalValue: ms / UNIT_MS.days, intervalUnit: 'days' };
  if (ms % UNIT_MS.hours === 0) return { intervalValue: ms / UNIT_MS.hours, intervalUnit: 'hours' };
  return { intervalValue: Math.round(ms / UNIT_MS.minutes), intervalUnit: 'minutes' };
}

/** 表单 → 调度 payload（kind 感知） */
function buildSchedule(form) {
  if (form.kind === 'every') {
    return { kind: 'every', intervalMs: Math.round(Number(form.intervalValue) * UNIT_MS[form.intervalUnit]) };
  }
  if (form.kind === 'at') {
    return { kind: 'at', runAt: parseAtLocal(form.runAt) }; // NaN = 格式错误
  }
  return { kind: 'cron', cronExpr: form.cron.trim() };
}

export default function LoopTasks({ className = '', 'aria-hidden': ariaHidden }) {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [tasks, setTasks] = useState([]);
  const [projects, setProjects] = useState([]);
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
  }, [fetchTasks, fetchProjects]);

  const projectName = useCallback((id) => projects.find((p) => p.id === id)?.name || id, [projects]);

  const openCreate = () => {
    setForm(emptyForm);
    setEditing(null);
    setDialogMode('create');
  };

  const openEdit = (task) => {
    setEditing(task);
    const kind = task.scheduleKind || 'cron';
    setForm({
      title: task.title,
      projectId: task.projectId,
      prompt: task.prompt,
      kind,
      cron: task.cronExpr,
      ...(kind === 'every' && task.intervalMs ? intervalToParts(task.intervalMs) : { intervalValue: 30, intervalUnit: 'minutes' }),
      runAt: kind === 'at' && task.nextRunAt ? formatAtLocal(task.nextRunAt) : '',
      timezone: TIMEZONES.includes(task.timezone) ? task.timezone : 'UTC',
    });
    setDialogMode('edit');
  };

  const closeDialog = () => { setDialogMode(null); setEditing(null); };

  const save = async () => {
    const schedule = buildSchedule(form);
    if (!form.title.trim() || !form.prompt.trim() || !form.projectId) {
      showToast('error', t('loopTasks:error.required'));
      return;
    }
    if (schedule.kind === 'cron' && !schedule.cronExpr) {
      showToast('error', t('loopTasks:error.cron_invalid'));
      return;
    }
    if (schedule.kind === 'every' && (!Number.isFinite(schedule.intervalMs) || schedule.intervalMs <= 0)) {
      showToast('error', t('loopTasks:error.cron_invalid'));
      return;
    }
    if (schedule.kind === 'at' && !form.runAt.trim()) {
      showToast('error', t('loopTasks:error.required'));
      return;
    }
    if (schedule.kind === 'at' && !Number.isFinite(schedule.runAt)) {
      showToast('error', t('loopTasks:error.datetime_format'));
      return;
    }
    setSaving(true);
    try {
      if (dialogMode === 'create') {
        await createLoopTask({
          title: form.title.trim(),
          prompt: form.prompt.trim(),
          projectId: form.projectId,
          schedule,
          timezone: form.timezone,
        });
        showToast('success', t('loopTasks:toast.created'));
      } else {
        await updateLoopTask(editing.id, {
          title: form.title.trim(),
          prompt: form.prompt.trim(),
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

  const timezoneOptions = useMemo(() => TIMEZONES.map((tz) => ({ value: tz, label: tz })), []);
  const workspaceOptions = useMemo(() => projects.map((p) => ({ value: p.id, label: p.name })), [projects]);
  const kindOptions = useMemo(() => [
    { value: 'cron', label: t('loopTasks:kind.cron') },
    { value: 'every', label: t('loopTasks:kind.every') },
    { value: 'at', label: t('loopTasks:kind.at') },
  ], [t]);
  const unitOptions = useMemo(() => [
    { value: 'minutes', label: t('loopTasks:unit.minutes') },
    { value: 'hours', label: t('loopTasks:unit.hours') },
    { value: 'days', label: t('loopTasks:unit.days') },
  ], [t]);

  // Schedule 实时预览：输入变更防抖 300ms → 服务端返回人类可读描述或行内错误
  const [cronHint, setCronHint] = useState(null);
  useEffect(() => {
    if (!dialogMode) { setCronHint(null); return undefined; }
    let payload = null;
    if (form.kind === 'cron' && form.cron.trim()) {
      payload = { kind: 'cron', cronExpr: form.cron.trim(), timezone: form.timezone };
    } else if (form.kind === 'every' && Number(form.intervalValue) > 0) {
      payload = { kind: 'every', intervalMs: Math.round(Number(form.intervalValue) * UNIT_MS[form.intervalUnit]), timezone: form.timezone };
    } else if (form.kind === 'at') {
      if (!form.runAt.trim()) { setCronHint(null); return undefined; }
      const ms = parseAtLocal(form.runAt);
      if (!Number.isFinite(ms)) {
        setCronHint({ error: t('loopTasks:error.datetime_format') }); // 本地格式校验，免请求
        return undefined;
      }
      payload = { kind: 'at', runAt: ms, timezone: form.timezone };
    }
    if (!payload) { setCronHint(null); return undefined; }
    const timer = setTimeout(() => {
      previewSchedule(payload)
        .then((data) => setCronHint(data))
        .catch(() => setCronHint(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [form.kind, form.cron, form.intervalValue, form.intervalUnit, form.runAt, form.timezone, dialogMode, t]);

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

      <div className={consoleAdminTableShellClass}>
        <div className={consoleAdminTableScrollClass}>
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <colgroup>
              <col className="w-[22%]" />
              <col className="w-[16%]" />
              <col className="w-[14%]" />
              <col className="w-[12%]" />
              <col className="w-[12%]" />
              <col className="w-[12%]" />
              <col className="w-28" />
              <col className="w-14" />
            </colgroup>
            <thead>
              <tr className={consoleTableHeadRowClass}>
                <th className={consoleTableHeadCellClass}>{t('loopTasks:field.title')}</th>
                <th className={consoleTableHeadCellClass}>{t('loopTasks:field.workspace')}</th>
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
                  <FormLabel htmlFor="loop-task-prompt">{t('loopTasks:field.prompt')}</FormLabel>
                  <Textarea
                    id="loop-task-prompt"
                    rows={6}
                    value={form.prompt}
                    onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
                    placeholder={t('loopTasks:field.prompt_placeholder')}
                  />
                </div>
                <div className="space-y-1.5">
                  <FormLabel htmlFor="loop-task-schedule">{t('loopTasks:field.schedule')}</FormLabel>
                  <SelectMenu
                    value={form.kind}
                    onChange={(v) => setForm((f) => ({ ...f, kind: v }))}
                    options={kindOptions}
                  />
                  {form.kind === 'cron' && (
                    <Input
                      id="loop-task-cron"
                      value={form.cron}
                      onChange={(e) => setForm((f) => ({ ...f, cron: e.target.value }))}
                      placeholder={t('loopTasks:field.cron_placeholder')}
                      className="font-mono h-[38px]"
                    />
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
                  {/* 固定预留一行高度：描述/错误出现或消失时弹窗不抖动（DESIGN.md 页面稳定性） */}
                  <p className={`min-h-4 text-xs ${cronHint?.error ? 'text-red-700' : 'text-zinc-500'}`}>
                    {cronHint?.error || cronHint?.description || ''}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <FormLabel htmlFor="loop-task-timezone">{t('loopTasks:field.timezone')}</FormLabel>
                  <SelectMenu
                    value={form.timezone}
                    onChange={(v) => setForm((f) => ({ ...f, timezone: v }))}
                    options={timezoneOptions}
                  />
                </div>
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
          <div className={`${consoleStructuredDialogPanelClass} w-[560px] max-w-[calc(100vw-2rem)]`}>
            <ConsoleStructuredDialogHeader
              title={`${t('loopTasks:run.history')} · ${runsOpenFor.title}`}
              subtitle={projectName(runsOpenFor.projectId)}
            />
            <ConsoleStructuredDialogBody>
              <div className="space-y-3">
                {runsLoading && runs.length === 0 ? (
                  <p className="text-sm text-zinc-400 py-4 text-center">{t('common:state.loading')}</p>
                ) : runs.length === 0 ? (
                  <p className="text-sm text-zinc-400 py-4 text-center">{t('loopTasks:run.no_runs')}</p>
                ) : (
                  <>
                    <div className="space-y-1">
                      {runs.map((run) => {
                        const meta = RUN_STATUS_META[run.status] || RUN_STATUS_META.failed;
                        return (
                          <button
                            key={run.id}
                            type="button"
                            onClick={() => setSelectedRun(run)}
                            className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-left transition-colors duration-150 hover:bg-zinc-100 ${selectedRun?.id === run.id ? 'bg-zinc-100' : ''}`}
                          >
                            <StatusBadge
                              tone={meta.tone}
                              spinning={meta.spinning}
                              label={t(`loopTasks:run.status_${run.status}`, { defaultValue: run.status })}
                            />
                            <span className="flex-1 min-w-0 truncate text-xs text-zinc-600">
                              {run.startedAt ? formatRelativeTime(run.startedAt) : ''}
                            </span>
                            {run.rounds != null && (
                              <span className="shrink-0 text-xs text-zinc-400">{t('loopTasks:run.rounds', { count: run.rounds })}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    {selectedRun && (
                      <div className="rounded-lg border border-zinc-200 bg-zinc-50/70 p-3">
                        {selectedRun.error && (
                          <p className="text-xs text-red-700 mb-2 break-words">
                            <span className="font-semibold">{t('loopTasks:run.error')}: </span>
                            {selectedRun.error}
                          </p>
                        )}
                        <div className="space-y-1 max-h-64 overflow-y-auto console-scroll-hidden">
                          {(selectedRun.logs || []).map((entry, i) => (
                            <div key={i} className="flex items-baseline gap-2 text-xs font-mono">
                              <span className="shrink-0 text-zinc-400">#{entry.round}</span>
                              <span className="shrink-0 text-zinc-700 font-semibold">{entry.action}</span>
                              <span className="min-w-0 flex-1 break-all text-zinc-500">{entry.summary}</span>
                            </div>
                          ))}
                          {(selectedRun.logs || []).length === 0 && !selectedRun.error && (
                            <p className="text-xs text-zinc-400">{selectedRun.status === 'running' ? '…' : '—'}</p>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
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
