import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2, Download, Search, Clock, Layers, Zap,
  User, Bot, Wrench, Sparkles, XCircle, BookOpen,
} from 'lucide-react';
import { apiFetch, getAccessToken, getWsUrl } from '../../lib/api';
import { extractSkillFromSession } from '../../lib/skillsApi';
import { useToast } from '../Toast';
import SelectMenu from '../SelectMenu';
import { consoleButtonFocusClass } from '../../lib/consoleTokens';
import { cn } from '../../lib/utils';

/**
 * TrajectoryViewer (0029) — 全量执行轨迹查看器（DeepSeek harness 风格，明暗双主题）。
 *
 * 顶部：时长/轮次/调用指标 + 轨迹时间线（sequence 模式：每条记录占 1 单位宽，
 * 左键拖选区间聚焦、滚轮缩放、右键拖拽平移、点 span 选中、Esc/双击清除）。
 * 主列表：消息级条目，按轮次分组，选区外条目变暗。
 * 数据源：GET /api/v1/sessions/:id/trajectory + WS trajectory_event 实时推送。
 */

const LIMIT = 100;
const MINIMUM_DRAG_PX = 3;
const MINIMUM_ZOOM_UNITS = 4;

// 明暗双主题表面色
const SURFACE = 'bg-zinc-50 dark:bg-zinc-950';
const CARD = 'bg-white dark:bg-zinc-950';
const BORDER = 'border-zinc-200 dark:border-zinc-800';
const T1 = 'text-zinc-900 dark:text-zinc-200';
const T2 = 'text-zinc-600 dark:text-zinc-400';
const T3 = 'text-zinc-400 dark:text-zinc-500';
const HOVER_ROW = 'hover:bg-zinc-100 dark:hover:bg-zinc-900/70';
const SELECTED_ROW = 'bg-zinc-200/70 dark:bg-zinc-800/80';

const KIND_STYLES = {
  system: {
    badge: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30',
    text: 'text-zinc-700 dark:text-zinc-400', icon: Bot, bar: 'border-l-blue-400 dark:border-l-blue-500',
  },
  context: {
    badge: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30',
    text: 'text-zinc-500 dark:text-zinc-400', icon: BookOpen, bar: 'border-l-emerald-400 dark:border-l-emerald-500',
  },
  user: {
    badge: 'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30',
    text: 'text-sky-800 dark:text-sky-200', icon: User, bar: 'border-l-sky-400 dark:border-l-sky-500',
  },
  assistant: {
    badge: 'bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/30',
    text: 'text-zinc-800 dark:text-zinc-200', icon: Bot, bar: 'border-l-violet-400 dark:border-l-violet-500',
  },
  thinking: {
    badge: 'bg-violet-100 text-violet-600 border-violet-200 dark:bg-violet-500/10 dark:text-violet-300/80 dark:border-violet-500/20',
    text: 'text-zinc-500 dark:text-zinc-400 italic', icon: Sparkles, bar: 'border-l-violet-300 dark:border-l-violet-500/50',
  },
  tool: {
    badge: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
    text: 'text-zinc-600 dark:text-zinc-400', icon: Wrench, bar: 'border-l-amber-400 dark:border-l-amber-500',
  },
  error: {
    badge: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30',
    text: 'text-zinc-600 dark:text-zinc-400', icon: XCircle, bar: 'border-l-red-400 dark:border-l-red-500',
  },
};

function preview(text, max = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Agent CLI 注入的伪用户消息包裹标签（与 server 端 proxy.js stripInjectedContext 同一约定集）
const INJECTED_TAGS = new Set([
  'system-reminder', 'local-command-caveat', 'local-command-stdout',
  'command-name', 'command-message', 'command-args',
]);

/**
 * 把 role:'user' 的文本拆成 真实用户输入 / 注入上下文 分段。
 * 用与 proxy.js 相同的平衡标签游走（嵌套包裹也能正确闭合），
 * 这样所有 Agent（claude-code/droid/kimi/qwen…）的注入都能统一识别，
 * 而不是把 <system-reminder> 错标成「用户」。
 */
function splitInjectedSegments(text) {
  const OPEN = /^<([A-Za-z][A-Za-z0-9-]*)(\s[^>]*)?>/;
  const CLOSE = /^<\/([A-Za-z][A-Za-z0-9-]*)>/;
  const segments = [];
  let userBuf = '';
  const flushUser = () => {
    if (userBuf.trim()) segments.push({ kind: 'user', text: userBuf });
    userBuf = '';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const m = rest.match(OPEN);
    if (m && INJECTED_TAGS.has(m[1])) {
      const innerStart = i + m[0].length;
      let depth = 1;
      let j = innerStart;
      let balanced = false;
      while (j < text.length) {
        const sub = text.slice(j);
        const c = sub.match(CLOSE);
        if (c && c[1] === m[1]) {
          depth -= 1;
          j += c[0].length;
          if (depth === 0) { balanced = true; break; }
          continue;
        }
        const o = sub.match(OPEN);
        if (o && o[1] === m[1]) { depth += 1; j += o[0].length; continue; }
        j += 1;
      }
      if (balanced) {
        flushUser();
        const inner = text.slice(innerStart, j - m[1].length - 3).trim();
        segments.push({ kind: 'context', text: inner || text.slice(i, j), tag: m[1] });
        i = j;
        continue;
      }
    }
    userBuf += text[i];
    i += 1;
  }
  flushUser();
  return segments;
}

// claude-code 压缩/警示开头模式 → 上下文
const COMPACTED_RE = /^This session is being continued from a previous conversation/;
const CAVEAT_RE = /^Caveat: The messages below/;

/**
 * 把 steps 展开为消息级条目。绝对游标去重（agent 每轮重放全量历史），
 * 与 conversationExtractor.extractFromTrajectory 同一套规则。
 */
function buildEntries(steps, t) {
  const entries = [];
  let cursor = 0;
  let systemSeen = false;

  const push = (kind, label, text, payload, step, name) => {
    entries.push({
      id: `${step.seq}:${entries.length}`,
      kind, label, name: name || null,
      text: String(text || ''),
      payload,
      stepSeq: step.seq,
      step,
      ts: step.ts,
    });
  };

  const respBlocks = (resp) => (Array.isArray(resp?.content) ? resp.content : []);

  // 用户文本 → 上下文/用户 分段（注入标签拆分 + 压缩摘要识别）
  const pushUserText = (text, payload, step) => {
    const raw = String(text || '');
    if (!raw.trim()) return;
    let tag = null;
    if (COMPACTED_RE.test(raw)) tag = 'compacted';
    else if (CAVEAT_RE.test(raw)) tag = 'caveat';
    const segs = tag ? [{ kind: 'context', text: raw, tag }] : splitInjectedSegments(raw);
    for (const seg of segs) {
      if (seg.kind === 'context') push('context', t('trajectory.role_context'), seg.text, payload, step, seg.tag);
      else push('user', t('trajectory.role_user'), seg.text, payload, step);
    }
  };

  for (const step of steps) {
    const req = step.request || {};
    if (!Array.isArray(req.messages)) continue;
    const base = (Number(step.msgCount) || 0) - req.messages.length;
    const msgs = req.messages;
    const errored = step.status === 'error';

    for (let i = 0; i < msgs.length; i += 1) {
      if (base + i < cursor) continue;
      const m = msgs[i];
      if (!m || typeof m !== 'object') continue;
      const content = m.content;

      if (m.role === 'user' || m.role === 'human') {
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === 'tool_result') {
              const r = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
              push('tool', t('trajectory.role_tool'), r, b, step);
            } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
              pushUserText(b.text, b, step);
            }
          }
        } else {
          pushUserText(typeof content === 'string' ? content : '', m, step);
        }
      } else if (m.role === 'assistant') {
        // 重发的助手消息跳过 —— 由该调用 response 的内容块呈现（避免重复）
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === 'tool_use') {
              push('tool', t('trajectory.role_tool'), JSON.stringify(b.input ?? {}), b, step, b.name);
            }
          }
        }
      } else if (m.role === 'tool') {
        const r = typeof content === 'string' ? content : JSON.stringify(content);
        push('tool', t('trajectory.role_tool'), r, m, step);
      } else if (m.role === 'system') {
        push(systemSeen ? 'context' : 'system', systemSeen ? t('trajectory.role_context') : t('trajectory.role_system'), typeof content === 'string' ? content : JSON.stringify(content), m, step);
        systemSeen = true;
      }
    }
    if ((Number(step.msgCount) || 0) > cursor) cursor = Number(step.msgCount);

    // 该次调用的响应 → 助手文本 + 思考 + 工具调用
    for (const b of respBlocks(step.response)) {
      if (b.type === 'text' && b.text) push(errored ? 'error' : 'assistant', t('trajectory.role_assistant'), b.text, b, step);
      else if (b.type === 'thinking' && b.thinking) push('thinking', t('trajectory.role_thinking'), b.thinking, b, step);
      else if (b.type === 'tool_use') push('tool', t('trajectory.role_tool'), JSON.stringify(b.input ?? {}), b, step, b.name);
    }
  }
  return entries;
}

// ── 轨迹时间线（sequence 模式：每条记录 1 单位宽，可拖选/缩放/平移） ──

const SPAN_COLORS = {
  user: 'bg-sky-500 dark:bg-sky-400',
  system: 'bg-blue-500 dark:bg-blue-400',
  context: 'bg-emerald-500 dark:bg-emerald-400',
  message: 'bg-violet-500 dark:bg-violet-400',
  tool: 'bg-amber-500 dark:bg-amber-400',
};

function spanKind(entry) {
  if (entry.kind === 'assistant' || entry.kind === 'thinking') return 'message';
  if (entry.kind === 'error') return 'message';
  return entry.kind;
}

function spanLane(kind) {
  if (kind === 'tool') return 2;
  if (kind === 'message') return 1;
  return 0;
}

/** DeepSeek sequence 投影：每条记录占 1 单位；tool_result（无 name）不占 span。 */
function buildSequenceTimeline(entries) {
  const spans = [];
  const boundaries = [];
  entries.forEach((e, i) => {
    if (e.kind === 'tool' && e.name == null) return;
    if (e.kind === 'user') boundaries.push(i);
    spans.push({
      entryId: e.id,
      kind: spanKind(e),
      lane: spanLane(spanKind(e)),
      start: i,
      end: i + 1,
      isError: e.step.status === 'error',
    });
  });
  return { spans, boundaries, start: 0, end: entries.length };
}

function orderedRange(left, right) {
  return left <= right ? { start: left, end: right } : { start: right, end: left };
}

function clampFraction(v) {
  return Math.min(1, Math.max(0, v));
}

function centeredRange(center, width, minimum, maximum) {
  const w = Math.min(maximum - minimum, Math.max(0, width));
  const start = Math.min(Math.max(center - w / 2, minimum), maximum - w);
  return { start, end: start + w };
}

function Timeline({ model, selectedId, range, onRangeChange, onSelect, onRecordFocus }) {
  const { t } = useTranslation('sessions');
  const [draft, setDraft] = useState(null);
  const [viewport, setViewport] = useState(null);
  const [panning, setPanning] = useState(false);
  const dragRef = useRef(null);
  const panRef = useRef(null);
  const rootRef = useRef(null);
  const trackRef = useRef(null);
  const fullDuration = Math.max(1, model.end - model.start);

  const viewportDuration = Math.min(fullDuration, Math.max(1, (viewport?.end ?? 0) - (viewport?.start ?? 0)));
  const domainStart = viewport === null
    ? model.start
    : Math.min(Math.max(viewport.start, model.start), model.end - viewportDuration);
  const domainDuration = viewport === null ? fullDuration : viewportDuration;
  const domainRef = useRef(null);
  domainRef.current = { domainStart, domainDuration, fullDuration, modelStart: model.start, modelEnd: model.end };

  // 滚轮缩放（锚点缩放；缩到全域即复位 viewport）
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      const d = domainRef.current;
      const track = trackRef.current;
      if (!d || track === null) return;
      const rect = track.getBoundingClientRect();
      const anchorFraction = clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
      const nextDuration = Math.min(
        d.fullDuration,
        Math.max(Math.min(MINIMUM_ZOOM_UNITS, d.fullDuration), d.domainDuration * Math.exp(event.deltaY * 0.0015)),
      );
      if (nextDuration >= d.fullDuration * 0.999) {
        setViewport(null);
        return;
      }
      const anchorTime = d.domainStart + anchorFraction * d.domainDuration;
      const nextStart = Math.min(
        Math.max(anchorTime - anchorFraction * nextDuration, d.modelStart),
        d.modelEnd - nextDuration,
      );
      setViewport({ start: nextStart, end: nextStart + nextDuration });
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, []);

  if (model.end <= model.start) {
    return (
      <div className={cn('flex items-stretch gap-0 border-b', BORDER)}>
        <div className="flex h-[50px] w-11 shrink-0 flex-col justify-around border-r border-zinc-200 pr-1 text-right dark:border-zinc-800">
          {[t('trajectory.lane_input'), t('trajectory.lane_model'), t('trajectory.role_tool')].map((l) => (
            <span key={l} className="text-[10px] leading-none text-zinc-400 dark:text-zinc-500">{l}</span>
          ))}
        </div>
        <div className="relative h-[50px] flex-1">
          <span className={cn('absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-xs', T3)}>
            {t('trajectory.timeline_empty')}
          </span>
        </div>
      </div>
    );
  }

  const fractionAt = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
  };

  const recordIdAt = (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const value = target?.closest('[data-timeline-record-id]')?.dataset.timelineRecordId;
    return value || null;
  };

  const onPointerDown = (event) => {
    if (event.button === 2) {
      // 右键拖拽：平移 viewport（未缩放时右键点击仅清除选区）
      panRef.current = {
        anchorClientX: event.clientX,
        anchorStart: domainStart,
        moved: false,
        pannable: viewport !== null,
        pointerId: event.pointerId,
      };
      setPanning(true);
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      return;
    }
    if (event.button !== 0) return;
    const anchor = fractionAt(event);
    const anchorTime = domainStart + anchor * domainDuration;
    dragRef.current = {
      pointerId: event.pointerId,
      anchorTime,
      anchorClientX: event.clientX,
      recordId: recordIdAt(event),
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    setDraft({ start: anchorTime, end: anchorTime });
  };

  const onPointerMove = (event) => {
    const pan = panRef.current;
    if (pan !== null && pan.pointerId === event.pointerId) {
      if (Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX) pan.moved = true;
      if (!pan.pannable) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const delta = (event.clientX - pan.anchorClientX) / Math.max(1, rect.width);
      const nextStart = Math.min(
        Math.max(pan.anchorStart - delta * domainDuration, model.start),
        model.end - domainDuration,
      );
      setViewport({ start: nextStart, end: nextStart + domainDuration });
      return;
    }
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const pointTime = domainStart + fractionAt(event) * domainDuration;
    setDraft(orderedRange(drag.anchorTime, pointTime));
  };

  const onPointerEnd = (event) => {
    const pan = panRef.current;
    if (pan !== null && pan.pointerId === event.pointerId) {
      const moved = pan.moved || Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX;
      panRef.current = null;
      setPanning(false);
      if (!moved) onRangeChange(null); // 右键单击 = 清除选区
      return;
    }
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const pointTime = domainStart + fractionAt(event) * domainDuration;
    const selected = orderedRange(drag.anchorTime, pointTime);
    dragRef.current = null;
    setDraft(null);
    const click = Math.abs(event.clientX - drag.anchorClientX) < MINIMUM_DRAG_PX;
    const clickedSpan = click && drag.recordId !== null
      ? model.spans.find((s) => s.entryId === drag.recordId)
      : undefined;
    if (clickedSpan !== undefined) {
      onRangeChange(null);
      onSelect(clickedSpan.entryId);
      return;
    }
    const minSelection = Math.min(domainDuration, fullDuration / model.spans.length);
    const committed = selected.end - selected.start < minSelection
      ? centeredRange(click ? selected.start : (selected.start + selected.end) / 2, minSelection, model.start, model.end)
      : selected;
    onRangeChange(committed);
    if (click) {
      // 点空白：聚焦最近的记录
      const point = selected.start;
      const nearest = model.spans.reduce((best, s) => {
        const dBest = point < best.start ? best.start - point : point > best.end ? point - best.end : 0;
        const dS = point < s.start ? s.start - point : point > s.end ? point - s.end : 0;
        return dS < dBest ? s : best;
      });
      onRecordFocus(nearest.entryId);
    }
  };

  const onKeyDown = (event) => {
    if (event.key !== 'Escape' || range === null) return;
    event.preventDefault();
    onRangeChange(null);
  };

  // 选区在全域内的投影（fraction），draft 优先展示
  const projectRange = (r) => {
    const lo = Math.min(Math.max(r.start, model.start), model.end);
    const hi = Math.min(Math.max(r.end, model.start), model.end);
    return {
      start: (lo - domainStart) / domainDuration,
      end: (hi - domainStart) / domainDuration,
    };
  };
  const visible = draft !== null ? projectRange(draft) : range !== null ? projectRange(range) : null;
  const activeRange = draft ?? range;
  const dragging = draft !== null;

  // viewport 投影：lanes 容器按全域缩放/平移
  const domainLeft = `${-(domainStart - model.start) / domainDuration * 100}%`;
  const domainWidth = `${fullDuration / domainDuration * 100}%`;
  const pos = (unit) => (unit - model.start) / fullDuration * 100;

  return (
    <div
      ref={rootRef}
      className={cn('relative z-[1] select-none border-b', BORDER)}
      aria-label={t('trajectory.timeline_aria')}
    >
      <div className="grid h-[50px] grid-cols-[44px_minmax(0,1fr)] overflow-hidden bg-zinc-50 dark:bg-zinc-900/60">
        <div className="relative border-r border-zinc-200 dark:border-zinc-800">
          {[t('trajectory.lane_input'), t('trajectory.lane_model'), t('trajectory.role_tool')].map((l, i) => (
            <span
              key={l}
              className="absolute right-1 flex h-2 items-center justify-end text-[10px] leading-none text-zinc-400 dark:text-zinc-500"
              style={{ top: 7 + i * 14 }}
            >
              {l}
            </span>
          ))}
        </div>
        <div
          ref={trackRef}
          className={cn('relative overflow-hidden', panning ? 'cursor-grabbing' : 'cursor-crosshair')}
          aria-label={t('trajectory.timeline_aria')}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={() => { dragRef.current = null; panRef.current = null; setDraft(null); setPanning(false); }}
          onDoubleClick={(event) => { event.preventDefault(); onRangeChange(null); }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {/* 选区遮罩 + 边缘条 */}
          {visible !== null && (
            <>
              <div className="pointer-events-none absolute inset-y-0 z-[1]" style={{ left: 0, width: `${Math.max(0, visible.start) * 100}%`, backgroundColor: 'rgba(0,0,0,0.28)' }} />
              <div className="pointer-events-none absolute inset-y-0 z-[1]" style={{ left: `${Math.min(100, visible.end) * 100}%`, right: 0, backgroundColor: 'rgba(0,0,0,0.28)' }} />
              <div className={cn('pointer-events-none absolute inset-y-0 z-[1] min-w-[1px] bg-sky-500/15 dark:bg-sky-400/15', dragging && 'bg-sky-500/20 dark:bg-sky-400/20')} style={{ left: `${visible.start * 100}%`, width: `${(visible.end - visible.start) * 100}%` }} />
              <div className="pointer-events-none absolute inset-y-0 z-[4] w-[3px] bg-sky-600 dark:bg-sky-400" style={{ left: `${visible.start * 100}%` }} />
              <div className="pointer-events-none absolute inset-y-0 z-[4] w-[3px] bg-sky-600 dark:bg-sky-400" style={{ left: `calc(${Math.min(100, visible.end) * 100}% - 3px)` }} />
            </>
          )}
          {/* 轮次边界 */}
          <div className="pointer-events-none absolute bottom-[7px] top-[7px]" style={{ left: domainLeft, width: domainWidth }}>
            {model.boundaries
              .filter((b) => b > model.start && b >= domainStart && b <= domainStart + domainDuration)
              .map((b) => (
                <span
                  key={b}
                  className="absolute bottom-0 top-0 w-px bg-zinc-300 dark:bg-zinc-700"
                  style={{ left: `${pos(b)}%` }}
                />
              ))}
          </div>
          {/* 三泳道 spans */}
          <div className="absolute bottom-[7px] top-[7px]" style={{ left: domainLeft, width: domainWidth }}>
            {model.spans
              .filter((sp) => sp.entryId === selectedId
                || (sp.end >= domainStart && sp.start <= domainStart + domainDuration))
              .map((sp) => {
                const inFocus = activeRange === null
                  || (sp.start <= activeRange.end && sp.end >= activeRange.start);
                return (
                  <span
                    key={sp.entryId}
                    aria-hidden="true"
                    data-timeline-record-id={sp.entryId}
                    className={cn(
                      'absolute h-2 rounded-[1px]',
                      SPAN_COLORS[sp.kind] || SPAN_COLORS.message,
                      sp.isError && 'bg-red-500 dark:bg-red-500',
                      !inFocus && 'opacity-20',
                      selectedId === sp.entryId && 'z-[1] opacity-100 ring-2 ring-sky-600 dark:ring-sky-400',
                    )}
                    style={{
                      top: sp.lane * 14,
                      left: `calc(${pos(sp.start)}% + min(${pos(sp.end) - pos(sp.start)}% * 0.08, 1px))`,
                      width: `max(2px, calc(${pos(sp.end) - pos(sp.start)}% - min(${pos(sp.end) - pos(sp.start)}% * 0.16, 2px)))`,
                    }}
                  />
                );
              })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 右侧详情 ──────────────────────────────────────────────

function DetailPanel({ entry }) {
  const { t } = useTranslation('sessions');
  const [tab, setTab] = useState('overview');
  useEffect(() => { setTab('overview'); }, [entry?.id]);
  if (!entry) {
    return <div className={cn('flex-1 flex items-center justify-center text-xs', T3)}>{t('trajectory.detail_empty')}</div>;
  }
  const step = entry.step;
  const usage = step.response?.usage;
  const style = KIND_STYLES[entry.kind] || KIND_STYLES.assistant;
  const raw = entry.name != null
    ? { name: entry.name, input: entry.payload?.input ?? entry.payload, step: { seq: step.seq, model: step.model, status: step.status, latency_ms: step.latencyMs } }
    : entry.payload;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn('h-11 shrink-0 border-b flex items-center gap-1 px-3', BORDER)}>
        {[
          ['overview', t('trajectory.tab_overview')],
          ['raw', t('trajectory.tab_raw')],
        ].map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => setTab(v)}
            className={cn('h-7 px-3 rounded text-xs font-medium', consoleButtonFocusClass, tab === v ? 'bg-zinc-200/80 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-300')}
          >
            {label}
          </button>
        ))}
        <span className={cn('ml-auto inline-flex items-center gap-1.5 h-5 px-2 rounded-full text-[10px] font-medium border', style.badge)}>
          {entry.label}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'overview' ? (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-2.5">
              <span className={T2}>{t('trajectory.field_type')}</span>
              <span className={T1}>{entry.name || entry.label}</span>
              <span className={T2}>{t('trajectory.field_source')}</span>
              <span className={cn(T1, 'font-mono')}>#{step.seq} · {step.model || '—'}</span>
              <span className={T2}>{t('trajectory.field_status')}</span>
              <span className={step.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}>
                {step.status === 'error' ? t('trajectory.status_error') : t('trajectory.status_ok')}
              </span>
              <span className={T2}>{t('trajectory.field_duration')}</span>
              <span className={T1}>{step.latencyMs != null ? `${step.latencyMs} ${t('trajectory.ms')}` : '—'}</span>
              {usage && (
                <>
                  <span className={T2}>tokens</span>
                  <span className={cn(T1, 'font-mono')}>{usage.prompt_tokens} / {usage.completion_tokens} · {usage.total_tokens}</span>
                </>
              )}
            </div>
            {step.error && (
              <div className="rounded-md bg-red-50 border border-red-200 dark:bg-red-500/10 dark:border-red-500/30 p-2.5 font-mono text-[11px] text-red-600 dark:text-red-300 whitespace-pre-wrap break-words">{step.error}</div>
            )}
            <div>
              <div className={cn('text-[11px] font-semibold tracking-wider mb-1.5', T3)}>{t('trajectory.field_preview')}</div>
              {entry.kind === 'tool' ? (
                <pre className={cn('font-mono text-[11.5px] leading-relaxed rounded-md p-2.5 overflow-x-auto whitespace-pre-wrap break-words border', CARD, 'text-zinc-800 dark:text-zinc-200', BORDER)}>{entry.text}</pre>
              ) : (
                <p className={cn('text-[13px] leading-relaxed whitespace-pre-wrap break-words', entry.kind === 'thinking' ? 'italic text-zinc-500 dark:text-zinc-400' : T1)}>{entry.text || '—'}</p>
              )}
            </div>
          </div>
        ) : (
          <pre className={cn('font-mono text-[11.5px] leading-relaxed rounded-md p-3 overflow-auto whitespace-pre border', 'bg-zinc-100 text-zinc-800 border-zinc-200 dark:bg-zinc-900 dark:text-zinc-200 dark:border-zinc-800')}>{JSON.stringify(raw, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

// ── 主组件 ────────────────────────────────────────────────

export default function TrajectoryViewer({ sessionId, live = false }) {
  const { t } = useTranslation('sessions');
  const { showToast } = useToast();
  const [steps, setSteps] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [range, setRange] = useState(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [exporting, setExporting] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [follow, setFollow] = useState(true);
  const afterSeqRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const listRef = useRef(null);

  const fetchSteps = useCallback(async ({ reset = false } = {}) => {
    const after = reset ? 0 : afterSeqRef.current;
    if (!reset) {
      // 并发护栏用 ref（state 会让 useCallback 身份变化，连累依赖它的 effect）
      if (loadingMoreRef.current) return;
      loadingMoreRef.current = true;
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/trajectory?after_seq=${after}&limit=${LIMIT}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const incoming = Array.isArray(data.steps) ? data.steps : [];
      afterSeqRef.current = incoming.length ? incoming[incoming.length - 1].seq : afterSeqRef.current;
      setSteps((prev) => {
        const merged = reset ? incoming : [...prev, ...incoming.filter((s) => !prev.some((p) => p.seq === s.seq))];
        merged.sort((a, b) => a.seq - b.seq);
        return merged;
      });
      setHasMore(Boolean(data.has_more));
    } catch (e) {
      setError(e?.message || 'load failed');
    } finally {
      if (!reset) loadingMoreRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, [sessionId]);

  useEffect(() => {
    afterSeqRef.current = 0;
    setSteps([]);
    setSelectedId(null);
    setRange(null);
    fetchSteps({ reset: true });
  }, [sessionId, fetchSteps]);

  // 实时更新：运行中会话通过 WS 订阅 trajectory_event（LLM 调用完成即推，零轮询延迟）。
  // 断线重连后 backfill 全量，补齐断连期间的步骤；连续两次连不上则视为会话已不在。
  useEffect(() => {
    if (!live) return undefined;
    let disposed = false;
    let ws = null;
    let reconnectTimer = null;
    let failed = 0;

    const schedule = () => {
      if (disposed) return;
      failed += 1;
      if (failed > 2) return;
      reconnectTimer = setTimeout(connect, 1500);
    };

    const connect = () => {
      if (disposed) return;
      const token = getAccessToken();
      // chat=1：跳过终端历史回放（轨迹视图没有终端可画）
      const url = `${getWsUrl(sessionId, token, 0)}&chat=1`;
      try {
        ws = new WebSocket(url);
      } catch {
        schedule();
        return;
      }
      ws.onmessage = (event) => {
        if (disposed) return;
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'ready') {
          fetchSteps({ reset: true }); // backfill 断连期间的步骤
          return;
        }
        if (msg.type === 'trajectory_event' && msg.data && Number.isFinite(msg.data.seq)) {
          const step = msg.data;
          afterSeqRef.current = Math.max(afterSeqRef.current, step.seq);
          setSteps((prev) => {
            const i = prev.findIndex((p) => p.seq === step.seq);
            if (i >= 0) {
              const next = prev.slice();
              next[i] = step;
              return next;
            }
            return [...prev, step].sort((a, b) => a.seq - b.seq);
          });
          return;
        }
        if (msg.type === 'exit' || msg.type === 'error') {
          try { ws.close(); } catch { /* ignore */ }
        }
      };
      ws.onclose = () => schedule();
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        try { ws.close(); } catch { /* ignore */ }
      }
    };
  }, [live, sessionId, fetchSteps]);

  const entries = useMemo(() => buildEntries(steps, t), [steps, t]);
  const seqModel = useMemo(() => buildSequenceTimeline(entries), [entries]);

  const visibleEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (filter === 'error' && e.step.status !== 'error') return false;
      if (filter === 'tool' && !(e.kind === 'tool')) return false;
      if (q && !(`${e.text} ${e.name || ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [entries, filter, query]);

  // 选区聚焦：span 与选区相交的条目保持高亮，其余在列表中变暗
  const focusIds = useMemo(() => {
    if (range === null) return null;
    const set = new Set();
    for (const sp of seqModel.spans) {
      if (sp.start <= range.end && sp.end >= range.start) set.add(sp.entryId);
    }
    return set;
  }, [range, seqModel]);

  // 轮次分组：以用户条目为界
  const groups = useMemo(() => {
    const out = [];
    let idx = 0;
    for (const e of visibleEntries) {
      if (e.kind === 'user') {
        idx += 1;
        out.push({ round: idx, title: e.text, entries: [] });
      }
      if (!out.length) out.push({ round: 0, title: '', entries: [] });
      out[out.length - 1].entries.push(e);
    }
    return out;
  }, [visibleEntries]);

  const selected = useMemo(() => entries.find((e) => e.id === selectedId) || null, [entries, selectedId]);

  // follow：新条目到达自动选中最后一条
  const lastId = entries.length ? entries[entries.length - 1].id : null;
  useEffect(() => {
    if (follow && lastId) setSelectedId(lastId);
  }, [follow, lastId]);

  const selectEntry = (id, { scroll = false } = {}) => {
    setSelectedId(id);
    setFollow(false);
    if (scroll && listRef.current) {
      const el = listRef.current.querySelector(`[data-entry-id="${CSS.escape(id)}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }
  };

  const exportJsonl = async () => {
    setExporting(true);
    try {
      const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/trajectory/export`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trajectory-${sessionId}.jsonl`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      showToast('error', t('trajectory.load_failed', { defaultValue: 'Failed to load trajectory' }));
    } finally {
      setExporting(false);
    }
  };

  const extractSkill = async () => {
    if (extracting) return;
    setExtracting(true);
    try {
      await extractSkillFromSession(sessionId);
      showToast('success', t('skills:extract_from_session_done', { defaultValue: 'Skill draft created.' }));
      window.dispatchEvent(new CustomEvent('xensemble:skills_changed'));
    } catch {
      showToast('error', t('skills:extract_failed', { defaultValue: 'Failed to extract skill.' }));
    } finally {
      setExtracting(false);
    }
  };

  const totalLatency = steps.reduce((n, s) => n + (s.latencyMs || 0), 0);
  const rounds = groups.filter((g) => g.round > 0).length;

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', SURFACE, T1)}>
      {/* 指标栏 */}
      <div className={cn('shrink-0 border-b px-3 py-2', BORDER)}>
        <div className="flex items-center gap-4">
          <span className={cn('flex items-center gap-1.5 text-xs', T2)}>
            <Clock className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500" strokeWidth={1.75} />
            {t('trajectory.metric_duration')} <b className={cn(T1, 'font-mono')}>{(totalLatency / 1000).toFixed(1)}s</b>
          </span>
          <span className={cn('flex items-center gap-1.5 text-xs', T2)}>
            <Layers className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500" strokeWidth={1.75} />
            {t('trajectory.metric_rounds')} <b className={cn(T1, 'font-mono')}>{rounds}</b>
          </span>
          <span className={cn('flex items-center gap-1.5 text-xs', T2)}>
            <Zap className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500" strokeWidth={1.75} />
            {t('trajectory.metric_calls')} <b className={cn(T1, 'font-mono')}>{steps.length}</b>
          </span>
          <div className="flex-1" />
          <div className="w-40">
            <SelectMenu
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: t('trajectory.filter_all') },
                { value: 'error', label: t('trajectory.filter_errors') },
                { value: 'tool', label: t('trajectory.filter_tools') },
              ]}
            />
          </div>
          <div className={cn('flex items-center gap-1.5 w-44 h-8 px-2 rounded-md border bg-white dark:bg-zinc-900 focus-within:border-zinc-500 dark:focus-within:border-zinc-500', 'border-zinc-300 dark:border-zinc-700')}>
            <Search className="w-3.5 h-3.5 text-zinc-400 shrink-0" strokeWidth={1.75} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('trajectory.search_placeholder')}
              className={cn('min-w-0 flex-1 bg-transparent text-xs outline-none', T1, 'placeholder:text-zinc-400 dark:placeholder:text-zinc-600')}
            />
          </div>
          <button
            type="button"
            onClick={extractSkill}
            disabled={extracting}
            title={t('skills:extract_from_session', { defaultValue: 'Extract as Skill' })}
            className={cn('flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed', 'border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900', 'dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100', consoleButtonFocusClass)}
          >
            {extracting ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} /> : <Sparkles className="w-3.5 h-3.5" strokeWidth={1.75} />}
          </button>
          <button
            type="button"
            onClick={exportJsonl}
            disabled={exporting}
            title={t('trajectory.export_jsonl')}
            className={cn('flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed', 'border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900', 'dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100', consoleButtonFocusClass)}
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} /> : <Download className="w-3.5 h-3.5" strokeWidth={1.75} />}
          </button>
        </div>
      </div>

      {/* 轨迹时间线 */}
      <Timeline
        model={seqModel}
        selectedId={selectedId}
        range={range}
        onRangeChange={setRange}
        onSelect={(id) => selectEntry(id)}
        onRecordFocus={(id) => selectEntry(id, { scroll: true })}
      />

      {/* 主体：消息级列表 + 详情 */}
      <div className="flex flex-1 min-h-0">
        <div ref={listRef} className="flex-1 min-w-0 overflow-y-auto">
          {loading && steps.length === 0 && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 text-zinc-400 animate-spin" strokeWidth={1.5} />
            </div>
          )}
          {groups.map((g, gi) => (
            <div key={gi}>
              {g.round > 0 && (
                <div className={cn('sticky top-0 z-10 flex items-center gap-2 px-3 h-8 backdrop-blur border-b', 'bg-zinc-100/95 dark:bg-zinc-900/95', 'border-zinc-200 dark:border-zinc-800/80')}>
                  <span className={cn('text-[11px]', T3)}>{t('trajectory.round_label', { n: g.round })}</span>
                  <span className="text-xs text-sky-700 dark:text-sky-300 truncate min-w-0">{preview(g.title, 60)}</span>
                </div>
              )}
              {g.entries.map((e) => {
                const style = KIND_STYLES[e.kind] || KIND_STYLES.assistant;
                const Icon = style.icon;
                const dimmed = range !== null && focusIds !== null && !focusIds.has(e.id);
                return (
                  <button
                    key={e.id}
                    type="button"
                    data-entry-id={e.id}
                    onClick={() => selectEntry(e.id)}
                    className={cn(
                      'w-full flex items-start gap-2.5 px-3 py-1.5 text-left border-l-2',
                      consoleButtonFocusClass,
                      style.bar,
                      selectedId === e.id ? SELECTED_ROW : HOVER_ROW,
                      dimmed && 'opacity-30',
                    )}
                  >
                    <span className={cn('inline-flex items-center gap-1 h-5 mt-0.5 px-1.5 rounded border text-[10px] font-medium shrink-0', style.badge)}>
                      <Icon className="w-3 h-3" strokeWidth={2} />
                      {e.label}
                    </span>
                    <span className="flex-1 min-w-0 text-xs leading-relaxed break-all">
                      {e.kind === 'tool' && e.name && <span className="text-amber-700 dark:text-amber-300 font-mono mr-1.5">{e.name}</span>}
                      <span className={cn(style.text, e.kind === 'tool' && 'font-mono text-[11px]')}>
                        {preview(e.text, e.kind === 'tool' ? 120 : 200)}
                      </span>
                    </span>
                    {e.step.status === 'error' && <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" strokeWidth={2} />}
                  </button>
                );
              })}
            </div>
          ))}
          {hasMore && (
            <button
              type="button"
              onClick={() => fetchSteps()}
              disabled={loadingMore}
              className={cn('w-full h-9 text-xs flex items-center justify-center gap-1.5', T3, HOVER_ROW, consoleButtonFocusClass)}
            >
              {loadingMore && <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} />}
              {t('trajectory.load_more')}
            </button>
          )}
          {!loading && steps.length === 0 && !error && (
            <p className={cn('text-xs text-center py-12 px-4', T3)}>{t('trajectory.empty')}</p>
          )}
          {error && (
            <p className="text-xs text-red-500 dark:text-red-400 text-center py-8 px-4">{t('trajectory.load_failed')}</p>
          )}
        </div>

        {/* 右侧详情面板 */}
        <aside className={cn('w-[400px] shrink-0 border-l flex flex-col min-h-0', CARD, BORDER)}>
          <DetailPanel entry={selected} />
        </aside>
      </div>
    </div>
  );
}
