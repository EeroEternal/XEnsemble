import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Loader2, Download, Search, Clock, Layers, Zap,
  User, Bot, Wrench, Sparkles, XCircle, BookOpen, Lightbulb, ChevronRight,
} from 'lucide-react';
import { apiFetch, getAccessToken, getWsUrl } from '../../lib/api';
import { extractSkillFromSession } from '../../lib/skillsApi';
import SessionReportPanel from './SessionReportPanel';
import { useToast } from '../Toast';
import { consoleButtonFocusClass } from '../../lib/consoleTokens';
import { cn } from '../../lib/utils';
import MarkdownView from '../Markdown';
import injectedTags from '../../../../shared/injectedTags.json';

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
const MINIMUM_ZOOM_UNITS = 4;      // sequence 模式最小缩放（4 条记录）
const MINIMUM_ZOOM_MS = 20;        // duration 模式最小缩放（20ms）

// 明暗双主题表面色 —— 注意：zinc/surface 色在 .dark 下经 CSS 变量自动反转，
// 勿加 dark: 前缀（否则双重反转回浅色）；语义色(red/blue/amber/sky/violet)才需 dark:
const SURFACE = 'bg-zinc-50';
const CARD = 'bg-surface';
const BORDER = 'border-zinc-200';
const T1 = 'text-zinc-900';
const T2 = 'text-zinc-600';
const T3 = 'text-zinc-400';
const HOVER_ROW = 'hover:bg-zinc-100';
const SELECTED_ROW = 'bg-zinc-200/70';

const KIND_STYLES = {
  system: {
    badge: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30',
    text: 'text-zinc-700', icon: Bot, bar: 'border-l-blue-400 dark:border-l-blue-500',
  },
  context: {
    badge: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30',
    text: 'text-zinc-500', icon: BookOpen, bar: 'border-l-emerald-400 dark:border-l-emerald-500',
  },
  user: {
    badge: 'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30',
    text: 'text-sky-800 dark:text-sky-200', icon: User, bar: 'border-l-sky-400 dark:border-l-sky-500',
  },
  assistant: {
    badge: 'bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/30',
    text: 'text-zinc-800', icon: Bot, bar: 'border-l-violet-400 dark:border-l-violet-500',
  },
  thinking: {
    badge: 'bg-violet-100 text-violet-600 border-violet-200 dark:bg-violet-500/10 dark:text-violet-300/80 dark:border-violet-500/20',
    text: 'text-zinc-500 italic', icon: Sparkles, bar: 'border-l-violet-300 dark:border-l-violet-500/50',
  },
  tool: {
    badge: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
    text: 'text-zinc-600', icon: Wrench, bar: 'border-l-amber-400 dark:border-l-amber-500',
  },
  error: {
    badge: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30',
    text: 'text-zinc-600', icon: XCircle, bar: 'border-l-red-400 dark:border-l-red-500',
  },
};

// response.content 块数组（response 为空/形状异常时返回 []）
const respBlocks = (resp) => (Array.isArray(resp?.content) ? resp.content : []);

function preview(text, max = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Agent CLI 注入的伪用户包裹标签（与 server 端共享同一份白名单）
const INJECTED_TAGS = new Set(injectedTags.tags || []);

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

// claude-code/qwen-code 压缩/警示/离开总结/记忆整理/输入建议生成等 CLI 注入开头模式 → 上下文
const COMPACTED_RE = /^This session is being continued from a previous conversation/;
const CAVEAT_RE = /^Caveat: The messages below/;
const STEPPED_AWAY_RE = /^The user (?:stepped away|is away|has stepped away)/;
const MEMORY_RE = /^Managed memory has/;
const SUGGESTION_MODE_RE = /^\[SUGGESTION MODE:/;

const SYNTHETIC_USER_RES = [COMPACTED_RE, CAVEAT_RE, STEPPED_AWAY_RE, MEMORY_RE, SUGGESTION_MODE_RE];

/** 该消息是否为 CLI 合成的伪用户指令（与 server 端 conversationExtractor 同一约定集） */
function isSyntheticUserMessage(m) {
  if (!m || typeof m !== 'object' || (m.role !== 'user' && m.role !== 'human')) return false;
  let text = '';
  if (typeof m.content === 'string') text = m.content;
  else if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b?.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
    }
  }
  const trimmed = text.trim();
  return trimmed.length > 0 && SYNTHETIC_USER_RES.some((re) => re.test(trimmed));
}

/**
 * 把 steps 展开为消息级条目。绝对游标去重（agent 每轮重放全量历史），
 * 与 conversationExtractor.extractFromTrajectory 同一套规则。
 */
export function buildEntries(steps, t) {
  const entries = [];
  let cursor = 0;
  let systemSeen = false;
  let src = 'req'; // 当前记录来源：'req'=请求上下文 / 'resp'=模型响应
  let round = 0; // 用户轮次：一条真实用户输入开启一轮（见 pushUserText）
  let callsGroup = 0; // 工具折叠分组：最近一条助手消息的 stepSeq（两个助手之间的工具同组）

  const toolById = new Map(); // tool_use.id -> 已呈现的调用条目（去重重放的 tool_use）

  const push = (kind, label, text, payload, step, name) => {
    const entry = {
      id: `${step.seq}:${entries.length}`,
      kind, label, name: name || null,
      text: String(text || ''),
      payload,
      stepSeq: step.seq,
      step,
      ts: step.ts,
      src, // 'req'=请求上下文 / 'resp'=模型响应（来源页展示）
      round, // 用户轮次编号（分组/折叠/边界统一用它）
      callsGroup, // 工具折叠分组（两个助手之间的工具归为同组）
    };
    entries.push(entry);
    return entry;
  };

  const resultTextOf = (b) => {
    const c = b && typeof b === 'object' && 'content' in b ? b.content : b;
    return typeof c === 'string' ? c : JSON.stringify(c ?? '');
  };

  // 工具调用（tool_use）。agent 每次请求会重放上一条 assistant 消息，同一个
  // tool_use 会先随 response 出现、再随下一次请求出现——按 id 去重，以 response
  // 侧为权威（与 conversationExtractor 的 pending-response 去重同一语义）。
  const pushToolCall = (b, step) => {
    const id = b?.id ?? null;
    if (id && toolById.has(id)) return;
    const entry = push('tool', t('trajectory.role_tool'), JSON.stringify(b?.input ?? {}), b, step, b?.name);
    if (id) toolById.set(id, entry);
  };

  // 工具结果（tool_result / role:tool）。按 tool_use_id 挂到对应调用条目
  // （列表箭头拼接、详情页参数下方展示结果）；匹配不到（分页截断 / 无 id）
  // 时保留为独立结果条目。
  const pushToolResult = (b, step) => {
    const id = b?.tool_use_id ?? b?.tool_call_id ?? null;
    const call = id ? toolById.get(id) : null;
    const text = resultTextOf(b);
    if (call) {
      if (call.result == null) call.result = { text, payload: b, step, ts: step.ts };
      return;
    }
    push('tool', t('trajectory.role_tool'), text, b, step);
  };

  // 用户文本 → 上下文/用户 分段（注入标签拆分 + 压缩摘要识别）
  const pushUserText = (text, payload, step) => {
    const raw = String(text || '');
    if (!raw.trim()) return;
    let tag = null;
    if (COMPACTED_RE.test(raw)) tag = 'compacted';
    else if (STEPPED_AWAY_RE.test(raw)) tag = 'recap';
    else if (MEMORY_RE.test(raw)) tag = 'memory';
    else if (CAVEAT_RE.test(raw)) tag = 'caveat';
    else if (SUGGESTION_MODE_RE.test(raw)) tag = 'suggestion';
    const segs = tag ? [{ kind: 'context', text: raw, tag }] : splitInjectedSegments(raw);
    // 一条 user 消息 = 至多一个用户轮次：剥离注入后仍有真实文本才开启新一轮，
    // 该消息的所有分段（含 context）落在同一轮，纯注入消息不开启。
    if (segs.some((seg) => seg.kind === 'user')) { round += 1; callsGroup = 0; }
    for (const seg of segs) {
      if (seg.kind === 'context') push('context', t('trajectory.role_context'), seg.text, payload, step, seg.tag);
      else push('user', t('trajectory.role_user'), seg.text, payload, step);
    }
  };

  for (const step of steps) {
    const req = step.request || {};
    if (!Array.isArray(req.messages)) continue;
    // delta 行（非快照）的 messages 已由 proxy 前缀比对保证全是新增——
    // 并行合成调用（如 qwen memory 刷新）会交错推进历史，绝对游标只对
    // 快照行有效，delta 行必须全量处理，否则真实用户消息会被误跳过。
    const isSnapshot = step.snapshot === true;
    const base = (Number(step.msgCount) || 0) - req.messages.length;
    const msgs = req.messages;
    const errored = step.status === 'error';
    src = 'req';

    // 合成旁路调用（建议生成/记忆整理等）：整行的新增消息全部是 CLI 合成用户
    // 指令时跳过——否则快照行会推进游标越过真实用户消息（真实消息被误跳过），
    // 指令也会被标成「用户」。快照行看绝对下标 ≥ cursor 的增量；delta 行的
    // 全部消息即增量。
    {
      const startIdx = isSnapshot ? Math.max(cursor - base, 0) : 0;
      if (msgs.length > startIdx) {
        let syntheticOnly = true;
        for (let i = startIdx; i < msgs.length; i += 1) {
          if (!isSyntheticUserMessage(msgs[i])) { syntheticOnly = false; break; }
        }
        if (syntheticOnly) continue;
      }
    }

    for (let i = 0; i < msgs.length; i += 1) {
      if (isSnapshot && base + i < cursor) continue;
      const m = msgs[i];
      if (!m || typeof m !== 'object') continue;
      const content = m.content;

      if (m.role === 'user' || m.role === 'human') {
        if (Array.isArray(content)) {
          // 一条 user 消息的所有 text 块合并后只调一次 pushUserText——多 text 块
          // 不能各开一轮（与 server extractor 的 addUserText 同口径）。
          let userText = '';
          for (const b of content) {
            if (b?.type === 'tool_result') {
              pushToolResult(b, step);
            } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
              userText += (userText ? '\n' : '') + b.text;
            }
          }
          if (userText.trim()) pushUserText(userText, content, step);
        } else {
          pushUserText(typeof content === 'string' ? content : '', m, step);
        }
      } else if (m.role === 'assistant') {
        // 重发的助手消息按 tool_use.id 去重（response 侧已呈现同一次调用）
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === 'tool_use') pushToolCall(b, step);
          }
        }
      } else if (m.role === 'tool') {
        pushToolResult(m, step);
      } else if (m.role === 'system') {
        push(systemSeen ? 'context' : 'system', systemSeen ? t('trajectory.role_context') : t('trajectory.role_system'), typeof content === 'string' ? content : JSON.stringify(content), m, step);
        systemSeen = true;
      }
    }
    // 游标推进到该请求的绝对上下文长度（每行都推进，与 server extractor 同口径）。
    // 只在快照行推进会让后续快照把已消费的历史再算一遍 → 重复的用户消息/轮次。
    if ((Number(step.msgCount) || 0) > cursor) cursor = Number(step.msgCount);

    // 该次调用的响应 → 一条助手条目（思考 + 正文）+ 工具调用。
    // 思考本就是助手回复的一部分（同一 response 的 content 块），不再单独成行。
    src = 'resp';
    const thinkingParts = [];
    const textParts = [];
    for (const b of respBlocks(step.response)) {
      if (b.type === 'thinking' && b.thinking) thinkingParts.push(b.thinking);
      else if (b.type === 'text' && b.text) textParts.push(b.text);
    }
    const thinkingText = thinkingParts.join('\n');
    const replyText = textParts.join('\n');
    if (thinkingText || replyText) {
      // 有助手消息：开启新的工具折叠组（后续无助手的纯工具步也归入本组）
      callsGroup = step.seq;
      const entry = push(
        errored ? 'error' : 'assistant',
        t('trajectory.role_assistant'),
        replyText,
        respBlocks(step.response).slice(), // 原始 response.content 块：「原始内容」= 真原文
        step,
      );
      if (thinkingText) entry.thinking = thinkingText;
    }
    for (const b of respBlocks(step.response)) {
      if (b.type === 'tool_use') pushToolCall(b, step);
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

// span.kind → 悬停提示的角色标签 i18n key
const SPAN_LABEL_KEY = {
  user: 'role_user', system: 'role_system', context: 'role_context',
  message: 'role_assistant', thinking: 'role_thinking', tool: 'role_tool', error: 'role_assistant',
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

/** 悬停提示的时间格式：HH:MM:SS.mmm */
function fmtClock(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 条目时间元数据：entryId -> {t0, t1, dur}（epoch ms）。 */
function buildEntryTiming(entries, steps) {
  const timing = new Map();
  const boundariesMs = [];
  if (!steps.length) return { timing, boundariesMs };
  const t0 = steps[0].ts || 0;
  const stepMeta = new Map();
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    const start = s.ts || t0;
    const end = start + (s.latencyMs || 0);
    const nextStart = i + 1 < steps.length ? (steps[i + 1].ts || end) : null;
    stepMeta.set(s.seq, { start, end, nextStart });
  }

  const byStep = new Map();
  for (const e of entries) {
    if (!byStep.has(e.stepSeq)) byStep.set(e.stepSeq, []);
    byStep.get(e.stepSeq).push(e);
  }

  let lastRound = 0;
  for (const s of steps) {
    const meta = stepMeta.get(s.seq);
    const list = byStep.get(s.seq) || [];
    for (const e of list) {
      if (e.kind === 'user' || e.kind === 'system' || e.kind === 'context') {
        timing.set(e.id, { t0: meta.start, t1: meta.start, dur: 0 });
      }
    }
    // 每开启一个用户轮次画一条边界线（一轮一条）
    const maxRound = list.reduce((m, e) => Math.max(m, e.round), 0);
    if (maxRound > lastRound) {
      boundariesMs.push(meta.start);
      lastRound = maxRound;
    }
    const modelEntry = list.find((e) => e.kind === 'assistant' || e.kind === 'thinking' || e.kind === 'error');
    if (modelEntry) timing.set(modelEntry.id, { t0: meta.start, t1: meta.end, dur: meta.end - meta.start });
    const calls = list.filter((e) => e.kind === 'tool' && e.name != null);
    if (calls.length) {
      const wEnd = meta.nextStart != null ? meta.nextStart : meta.end;
      const window = Math.max(wEnd - meta.end, 0);
      const per = window / calls.length;
      calls.forEach((e, j) => {
        timing.set(e.id, { t0: meta.end + per * j, t1: meta.end + per * (j + 1), dur: per });
      });
    }
  }
  return { timing, boundariesMs };
}

/** sequence 投影：每条记录 1 单位宽，附带真实时间用于悬停提示。 */
function buildSequenceTimeline(entries, timing) {
  const spans = [];
  const boundaries = [];
  let lastRound = 0;
  entries.forEach((e, i) => {
    // 每开启一个用户轮次画一条边界线（一轮一条）
    if (e.round > lastRound) { boundaries.push(i); lastRound = e.round; }
    if (e.kind === 'tool' && e.name == null) return;
    const tm = timing.get(e.id) || { t0: 0, t1: 0, dur: 0 };
    spans.push({
      entryId: e.id, kind: spanKind(e), lane: spanLane(spanKind(e)),
      start: i, end: i + 1, isError: e.step.status === 'error',
      t0: tm.t0, t1: tm.t1, dur: tm.dur,
    });
  });
  return { spans, boundaries, start: 0, end: entries.length };
}

/**
 * duration 投影：真实时间定位/定宽 + 空闲间隙压缩（DeepSeek duration 模式）。
 * 没有任何记录覆盖的时间段（用户思考/等待）被折叠，块与块紧密相邻。
 */
function buildDurationTimeline(entries, timing, boundariesMs) {
  const spans = [];
  entries.forEach((e) => {
    if (e.kind === 'tool' && e.name == null) return;
    const tm = timing.get(e.id);
    if (!tm) return;
    spans.push({
      entryId: e.id, kind: spanKind(e), lane: spanLane(spanKind(e)),
      t0: tm.t0, t1: Math.max(tm.t1, tm.t0), dur: tm.dur,
      isError: e.step.status === 'error',
    });
  });
  if (!spans.length) return { spans: [], boundaries: [], start: 0, end: 1 };

  // 空闲压缩：按时间排序游走，未被覆盖的间隙累计移除
  const sorted = [...spans].sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  let covered = null;
  let removed = 0;
  const gaps = [];
  const offsetBySpan = new Map();
  for (const sp of sorted) {
    if (covered !== null && sp.t0 > covered) {
      gaps.push({ from: covered, to: sp.t0 });
      removed += sp.t0 - covered;
    }
    offsetBySpan.set(sp, removed);
    covered = covered === null ? sp.t1 : Math.max(covered, sp.t1);
  }
  const offsetAt = (t) => gaps.reduce((n, g) => n + (g.to <= t ? g.to - g.from : t > g.from ? t - g.from : 0), 0);
  let start = Infinity;
  let end = -Infinity;
  for (const sp of spans) {
    const off = offsetBySpan.get(sp) ?? 0;
    sp.start = sp.t0 - off;
    sp.end = Math.max(sp.start, sp.t1 - off);
    start = Math.min(start, sp.start);
    end = Math.max(end, sp.end);
  }
  const boundaries = boundariesMs.map((b) => offsetAt(b));
  return { spans, boundaries, start, end: Math.max(end, start + 1) };
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

function Timeline({ model, selectedId, range, onRangeChange, onSelect, onRecordFocus, minZoom }) {
  const { t } = useTranslation('sessions');
  const [draft, setDraft] = useState(null);
  const [viewport, setViewport] = useState(null);
  const [panning, setPanning] = useState(false);
  const [tip, setTip] = useState(null); // 悬停提示 {x, y, label, range, total}
  const dragRef = useRef(null);
  const panRef = useRef(null);
  const rootRef = useRef(null);
  const trackRef = useRef(null);
  const fullDuration = Math.max(1, model.end - model.start);
  const effectiveMinZoom = Math.min(minZoom, fullDuration);

  const viewportDuration = Math.min(fullDuration, Math.max(1, (viewport?.end ?? 0) - (viewport?.start ?? 0)));
  const domainStart = viewport === null
    ? model.start
    : Math.min(Math.max(viewport.start, model.start), model.end - viewportDuration);
  const domainDuration = viewport === null ? fullDuration : viewportDuration;
  const domainRef = useRef(null);
  domainRef.current = { domainStart, domainDuration, fullDuration, modelStart: model.start, modelEnd: model.end, effectiveMinZoom };

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
        Math.max(d.effectiveMinZoom, d.domainDuration * Math.exp(event.deltaY * 0.0015)),
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
        <div className="flex h-[50px] w-11 shrink-0 flex-col justify-around border-r border-zinc-200 pr-1 text-right">
          {[t('trajectory.lane_input'), t('trajectory.lane_model'), t('trajectory.role_tool')].map((l) => (
            <span key={l} className="text-[10px] leading-none text-zinc-400">{l}</span>
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
      <div className="grid h-[50px] grid-cols-[44px_minmax(0,1fr)] overflow-hidden bg-zinc-50">
        <div className="relative border-r border-zinc-200">
          {[t('trajectory.lane_input'), t('trajectory.lane_model'), t('trajectory.role_tool')].map((l, i) => (
            <span
              key={l}
              className="absolute right-1 flex h-2 items-center justify-end text-[10px] leading-none text-zinc-400"
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
          {/* 选区遮罩（选区外变暗；明暗主题各自适配）+ 边缘条 */}
          {visible !== null && (
            <>
              <div className="pointer-events-none absolute inset-y-0 z-[1] bg-black/30 dark:bg-white/10" style={{ left: 0, width: `${Math.max(0, visible.start) * 100}%` }} />
              <div className="pointer-events-none absolute inset-y-0 z-[1] bg-black/30 dark:bg-white/10" style={{ left: `${Math.min(100, visible.end) * 100}%`, right: 0 }} />
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
                  className="absolute bottom-0 top-0 w-px bg-zinc-300"
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
                    onMouseEnter={(event) => {
                      // fixed 定位相对视口；垂直固定在时间线下方（只水平跟随鼠标），
                      // 避免 tooltip 盖住正在查看的时间线块，且不受祖先 overflow-hidden 裁剪
                      const trackRect = trackRef.current?.getBoundingClientRect();
                      const x = Math.min(event.clientX + 10, window.innerWidth - 200);
                      const y = trackRect ? trackRect.bottom + 6 : Math.min(event.clientY + 14, window.innerHeight - 90);
                      const label = t(`trajectory.${SPAN_LABEL_KEY[sp.kind] || 'role_assistant'}`);
                      const range = sp.t1 > sp.t0 ? `${fmtClock(sp.t0)} → ${fmtClock(sp.t1)}` : fmtClock(sp.t0);
                      const ms = Math.max(0, Math.round(sp.dur || (sp.t1 - sp.t0)));
                      setTip({
                        x, y, label, range,
                        total: t('trajectory.tip_total', { ms: ms.toLocaleString() }),
                      });
                    }}
                    onMouseLeave={() => setTip(null)}
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
      {/* 悬停提示：createPortal 渲染到 body，z 最高，不被 sticky 轮次头/overflow 裁剪遮挡 */}
      {tip && createPortal(
        <div
          className="pointer-events-none fixed z-[9999] rounded-md border border-zinc-300 bg-zinc-50 px-2.5 py-1.5 text-[11px] leading-snug text-zinc-900 shadow-lg"
          style={{ left: `${tip.x}px`, top: `${tip.y}px` }}
        >
          <div className="font-medium">{tip.label}</div>
          {tip.range && <div className="font-mono text-[10px] text-zinc-500">{tip.range}</div>}
          {tip.total && <div className="font-mono text-[10px] text-zinc-500">{tip.total}</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── 右侧详情 ──────────────────────────────────────────────

// overview 折叠 section：标题可点击跳转到对应 tab，正文给缩略预览。
function OverviewSection({ label, onOpen, children }) {
  return (
    <section>
      <button
        type="button"
        onClick={onOpen}
        className={cn('flex items-center gap-1 text-[11px] font-semibold tracking-wider uppercase mb-1.5', T3, 'hover:text-zinc-700', consoleButtonFocusClass)}
      >
        <span>{label}</span>
        <span className="text-zinc-400">→</span>
      </button>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

// 可折叠 JSON 树：工具参数/结果按层级展开（对齐 DeepSeek harness JsonTree）。
function JsonTree({ value, name = null }) {
  const [collapsed, setCollapsed] = useState(false);
  const isObj = value !== null && typeof value === 'object';
  if (!isObj) {
    const isStr = typeof value === 'string';
    const isNum = typeof value === 'number';
    const isBool = typeof value === 'boolean';
    const isNull = value === null;
    const color = isStr ? 'text-emerald-700 dark:text-emerald-300'
      : isNum ? 'text-sky-700 dark:text-sky-300'
        : isBool ? 'text-amber-700 dark:text-amber-300'
          : isNull ? 'text-zinc-400' : 'text-zinc-700';
    return (
      <div className="pl-5 font-mono text-[11.5px] leading-relaxed break-all">
        {name !== null && <span className="text-zinc-500">{name}<span className="text-zinc-400">: </span></span>}
        <span className={color}>{isStr ? `"${value}"` : String(value)}</span>
      </div>
    );
  }
  const isArr = Array.isArray(value);
  const pairs = isArr ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  return (
    <div className="font-mono text-[11.5px] leading-relaxed">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className={cn('flex items-center gap-1 text-left hover:text-zinc-900', consoleButtonFocusClass)}
      >
        <span className="w-3 shrink-0 text-zinc-400">{collapsed ? '▸' : '▾'}</span>
        {name !== null && <span className="text-zinc-600">{name}<span className="text-zinc-400">: </span></span>}
        <span className="text-zinc-400">{isArr ? '[' : '{'}</span>
        {collapsed && <span className="text-zinc-400">…{isArr ? `] ${pairs.length}` : `} ${pairs.length}`}</span>}
      </button>
      {!collapsed && (
        <>
          {pairs.map(([k, v]) => <JsonTree key={k} value={v} name={k} />)}
          <div className="text-zinc-400">{isArr ? ']' : '}'}</div>
        </>
      )}
    </div>
  );
}

function DetailPanel({ entry, round = 0, entries = [], onNavigate }) {
  const { t } = useTranslation('sessions');
  const [tab, setTab] = useState('overview');
  const [thinkingOpen, setThinkingOpen] = useState(false);
  useEffect(() => { setTab('overview'); setThinkingOpen(false); }, [entry?.id]);
  if (!entry) {
    return <div className={cn('flex-1 flex items-center justify-center text-xs', T3)}>{t('trajectory.detail_empty')}</div>;
  }
  const step = entry.step;
  const usage = step.response?.usage;
  const style = KIND_STYLES[entry.kind] || KIND_STYLES.assistant;
  // 「原始内容」= Agent 逐字原文：调用块 + 结果块（不做拍平/注入项目元数据）。
  // seq/model/status/耗时等在「来源」tab。
  const raw = entry.name != null
    ? {
        call: entry.payload,
        ...(entry.result ? { result: entry.result.payload } : {}),
      }
    : entry.payload;
  const srcLabel = entry.src === 'resp' ? t('trajectory.src_response') : t('trajectory.src_request');

  // 层级导航：tool 的父消息（同一次调用里发起它的助手条目），助手条目已含思考
  const parentMessage = entry.kind === 'tool'
    ? entries.find((e) => e.id !== entry.id && e.stepSeq === entry.stepSeq && e.kind === 'assistant') || null
    : null;

  // 助手正文：全量走 MarkdownView（代码高亮 / KaTeX 公式，与会话历史一致）。
  // 概述里由外层限高 + 滚动，预览 tab 显示全文。
  const renderedBody = () => (
    <div className="text-[13px]">
      {entry.text ? <MarkdownView>{entry.text}</MarkdownView> : <p className="text-zinc-400">—</p>}
    </div>
  );

  // 思考块：概述与预览 tab 共用。概述限高滚动，预览 tab 不限高完整铺开。
  const renderThinking = ({ bounded = true } = {}) => (
    entry.thinking ? (
      <div className="mb-1.5">
        <button
          type="button"
          onClick={() => setThinkingOpen((o) => !o)}
          aria-expanded={thinkingOpen}
          className={cn('flex items-center gap-1 text-[11px] font-semibold tracking-wider uppercase text-zinc-400 hover:text-zinc-700', consoleButtonFocusClass)}
        >
          <ChevronRight className={cn('w-3 h-3 shrink-0 transition-transform', thinkingOpen && 'rotate-90')} strokeWidth={2} />
          <span>{t('trajectory.role_thinking')}</span>
        </button>
        {thinkingOpen && (
          <div className={cn('mt-1.5 border-l-2 border-zinc-200 pl-3', bounded && 'max-h-40 overflow-y-auto')}>
            <p className="text-[12px] leading-relaxed text-zinc-500 whitespace-pre-wrap break-words">{entry.thinking}</p>
          </div>
        )}
      </div>
    ) : null
  );

  // 工具调用：参数（tool_use.input）与结果（tool_result/tool.content）
  const toolInput = (() => {
    const p = entry.payload;
    if (p && p.input != null) return p.input;
    try { return JSON.parse(entry.text); } catch { return null; }
  })();
  const toolOutput = (() => {
    // 合并后的工具条目：结果挂在 entry.result（箭头拼接 / 参数下方展示）
    if (entry.result) {
      const c = entry.result.payload?.content ?? entry.result.text;
      if (typeof c === 'string') { try { return JSON.parse(c); } catch { return c; } }
      return c;
    }
    const p = entry.payload;
    if (p && p.content != null) {
      if (typeof p.content === 'string') { try { return JSON.parse(p.content); } catch { return p.content; } }
      return p.content;
    }
    return null;
  })();

  // 动态 tab：tool 有 参数/结果，其余消息走 预览/原始
  const tabs = entry.kind === 'tool'
    ? [
        ['overview', t('trajectory.tab_overview')],
        ['input', t('trajectory.tab_input', { defaultValue: '参数' })],
        ['output', t('trajectory.tab_output', { defaultValue: '结果' })],
        ['raw', t('trajectory.tab_raw')],
        ['source', t('trajectory.tab_source')],
      ]
    : [
        ['overview', t('trajectory.tab_overview')],
        ['preview', t('trajectory.tab_preview')],
        ['raw', t('trajectory.tab_raw')],
      ];

  const renderOverviewSections = () => {
    if (entry.kind === 'tool') {
      return (
        <div className="space-y-3">
          <OverviewSection label={t('trajectory.tab_input', { defaultValue: '参数' })} onOpen={() => setTab('input')}>
            {toolInput != null
              ? <JsonTree value={toolInput} />
              : <p className="text-xs text-zinc-400">{t('trajectory.detail_empty')}</p>}
          </OverviewSection>
          {toolOutput != null && (
            <OverviewSection label={t('trajectory.tab_output', { defaultValue: '结果' })} onOpen={() => setTab('output')}>
              {typeof toolOutput === 'object'
                ? <JsonTree value={toolOutput} />
                : <pre className="font-mono text-[11px] text-zinc-700 whitespace-pre-wrap break-words max-h-40 overflow-hidden">{toolOutput}</pre>}
            </OverviewSection>
          )}
        </div>
      );
    }
    return (
      <OverviewSection label={t('trajectory.tab_preview')} onOpen={() => setTab('preview')}>
        {/* 思考：放在「预览」标题下、正文上方，默认折叠 */}
        {renderThinking()}
        {/* 概述只做有界预览：正文限高、范围内滚动；看全文点标题跳「预览」tab */}
        <div className="max-h-56 overflow-y-auto">
          {renderedBody()}
        </div>
      </OverviewSection>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部：类型 + 所属轮次 */}
      <div className={cn('shrink-0 px-4 pt-3 flex items-center gap-2')}>
        <span className={cn('inline-flex items-center gap-1.5 h-5 px-2 rounded-full text-[10px] font-medium border', style.badge)}>
          {entry.label}
        </span>
        {round > 0 && <span className={cn('text-[11px]', T3)}>{t('trajectory.round_label', { n: round })}</span>}
        {entry.kind === 'tool' && entry.name && <span className={cn('text-[11px] font-mono', T3)}>{entry.name}</span>}
      </div>
      <div className={cn('h-10 shrink-0 flex items-center gap-1 px-3 border-b', BORDER)}>
        {tabs.map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => setTab(v)}
            className={cn('h-7 px-3 rounded text-xs font-medium', consoleButtonFocusClass, tab === v ? 'bg-zinc-200/80 text-zinc-900' : 'text-zinc-500 hover:text-zinc-800')}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'overview' && (
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
            {parentMessage && (
              <button
                type="button"
                onClick={() => onNavigate?.(parentMessage.id)}
                className={cn('flex items-center gap-1.5 text-[11px] text-left', T2, 'hover:text-zinc-900', consoleButtonFocusClass)}
              >
                <span>{t('trajectory.from_assistant', { defaultValue: '来自助手消息' })}</span>
                <span className="text-zinc-400">·</span>
                <span className="truncate max-w-[220px]">{preview(parentMessage.text, 40)}</span>
              </button>
            )}
            {renderOverviewSections()}
          </div>
        )}
        {tab === 'preview' && (
          <div className="space-y-3">
            {renderThinking({ bounded: false })}
            {renderedBody()}
          </div>
        )}
        {tab === 'input' && (
          toolInput != null
            ? <JsonTree value={toolInput} />
            : <p className="text-xs text-zinc-400">{t('trajectory.detail_empty')}</p>
        )}
        {tab === 'output' && (
          toolOutput != null
            ? (typeof toolOutput === 'object'
                ? <JsonTree value={toolOutput} />
                : <pre className="font-mono text-[11.5px] text-zinc-700 whitespace-pre-wrap break-words">{toolOutput}</pre>)
            : <p className="text-xs text-zinc-400">{t('trajectory.detail_empty')}</p>
        )}
        {tab === 'raw' && (
          <pre className={cn('font-mono text-[11.5px] leading-relaxed rounded-md p-3 overflow-auto whitespace-pre border', 'bg-zinc-100 text-zinc-800 border-zinc-200')}>{JSON.stringify(raw, null, 2)}</pre>
        )}
        {tab === 'source' && (
          <div className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-2.5 text-xs">
            <span className={T2}>{t('trajectory.field_payload')}</span>
            <span className={T1}>{srcLabel}</span>
            <span className={T2}>{t('trajectory.field_call')}</span>
            <span className={cn(T1, 'font-mono')}>#{step.seq}</span>
            <span className={T2}>{t('trajectory.field_model')}</span>
            <span className={cn(T1, 'font-mono')}>{step.model || '—'}</span>
            <span className={T2}>{t('trajectory.field_agent')}</span>
            <span className={cn(T1, 'font-mono')}>{step.agentId || '—'}</span>
            {entry.kind === 'context' && entry.name && (
              <>
                <span className={T2}>{t('trajectory.field_tag')}</span>
                <span className={cn(T1, 'font-mono')}>&lt;{entry.name}&gt;</span>
              </>
            )}
            <span className={T2}>{t('trajectory.field_time')}</span>
            <span className={cn(T1, 'font-mono')}>{entry.ts ? new Date(entry.ts).toLocaleString() : '—'}</span>
            <span className={T2}>{t('trajectory.field_status')}</span>
            <span className={step.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}>
              {step.status === 'error' ? t('trajectory.status_error') : t('trajectory.status_ok')}
            </span>
            {usage && (
              <>
                <span className={T2}>tokens</span>
                <span className={cn(T1, 'font-mono')}>{usage.prompt_tokens} / {usage.completion_tokens} · {usage.total_tokens}</span>
              </>
            )}
          </div>
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
  const [totals, setTotals] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [range, setRange] = useState(null);
  const [query, setQuery] = useState('');
  const [exporting, setExporting] = useState(false);
  const [extracting, setExtracting] = useState(false);
  // 轨迹洞察：右侧滑入面板（rules 指标/问题 + LLM 提示词建议），实时计算不落库
  const [report, setReport] = useState(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [copiedAfter, setCopiedAfter] = useState(null);
  const [follow, setFollow] = useState(true);
  // DeepSeek toolbar 开关：时长投影 / 轮次折叠 / 调用折叠
  const [durationOn, setDurationOn] = useState(false);
  const [turnsCollapsed, setTurnsCollapsed] = useState(false);
  const [groupOverrides, setGroupOverrides] = useState({});
  const [callsCollapsed, setCallsCollapsed] = useState(false);
  // 局部展开的 stepSeq（折叠状态下点某个摘要行，只展开该步的工具调用）
  const [expandedGroups, setExpandedGroups] = useState({});
  const afterSeqRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const baseStepStatsRef = useRef(null); // Map<seq, {latency, tools}> at totals snapshot
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
      // totals 只在首屏（after_seq=0）由服务端返回：头部指标走全量口径
      if (data.totals) {
        setTotals(data.totals);
        // 记录快照时各步的耗时/工具数，供响应晚到（在途调用）做差值补齐
        const m = new Map();
        for (const s of incoming) {
          m.set(s.seq, {
            latency: s.latencyMs || 0,
            tools: respBlocks(s.response).filter((b) => b?.type === 'tool_use').length,
          });
        }
        baseStepStatsRef.current = m;
      }
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
    baseStepStatsRef.current = null;
    setSteps([]);
    setTotals(null);
    setSelectedId(null);
    setRange(null);
    setTurnsCollapsed(false);
    setGroupOverrides({});
    setCallsCollapsed(false);
    setExpandedGroups({});
    setReport(null);
    setReportOpen(false);
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
  const timingInfo = useMemo(() => buildEntryTiming(entries, steps), [entries, steps]);
  const seqModel = useMemo(() => buildSequenceTimeline(entries, timingInfo.timing), [entries, timingInfo]);
  const durationModel = useMemo(() => buildDurationTimeline(entries, timingInfo.timing, timingInfo.boundariesMs), [entries, timingInfo]);
  const model = durationOn ? durationModel : seqModel;

  const visibleEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      // 搜索过滤（工具折叠在渲染时按「两个助手之间」处理，不在这里过滤）
      if (q && !(`${e.text} ${e.name || ''} ${e.thinking || ''} ${e.result?.text || ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [entries, query]);

  // 选区聚焦：span 与选区相交的条目保持高亮，其余在列表中变暗（用当前激活投影）
  const focusIds = useMemo(() => {
    if (range === null) return null;
    const set = new Set();
    for (const sp of model.spans) {
      if (sp.start <= range.end && sp.end >= range.start) set.add(sp.entryId);
    }
    return set;
  }, [range, model]);

  // 轮次分组：按条目上的用户轮次编号（buildEntries 按 user 消息打标），
  // 轮次可整体折叠（DeepSeek turns 开关）
  const groups = useMemo(() => {
    const out = [];
    const byRound = new Map();
    for (const e of visibleEntries) {
      let g = byRound.get(e.round);
      if (!g) {
        g = { round: e.round, title: '', entries: [] };
        byRound.set(e.round, g);
        out.push(g);
      }
      if (!g.title && e.kind === 'user') g.title = e.text;
      g.entries.push(e);
    }
    return out;
  }, [visibleEntries]);

  // 每个用户轮次的折叠摘要：步骤数（不同模型调用）+ 工具调用数
  const roundMeta = useMemo(() => {
    const m = new Map();
    const stepSets = new Map();
    for (const e of entries) {
      let cur = m.get(e.round);
      if (!cur) { cur = { steps: 0, toolCalls: 0 }; m.set(e.round, cur); }
      if (e.kind === 'tool' && e.name) cur.toolCalls += 1;
      let set = stepSets.get(e.round);
      if (!set) { set = new Set(); stepSets.set(e.round, set); }
      set.add(e.stepSeq);
    }
    for (const [round, cur] of m) cur.steps = stepSets.get(round)?.size || 0;
    return m;
  }, [entries]);

  const groupExpanded = (round) => groupOverrides[round] ?? !turnsCollapsed;
  const toggleGroup = (round) => setGroupOverrides((o) => ({ ...o, [round]: !(o[round] ?? !turnsCollapsed) }));
  const toggleAllGroups = () => {
    setTurnsCollapsed((c) => !c);
    setGroupOverrides({});
  };

  const selected = useMemo(() => entries.find((e) => e.id === selectedId) || null, [entries, selectedId]);

  // 选中条目所属轮次（概述页头部展示）
  const roundByEntry = useMemo(() => {
    const map = new Map();
    for (const e of entries) map.set(e.id, e.round);
    return map;
  }, [entries]);

  // 「两个助手之间」的工具汇总：无助手的纯工具步会与上一个助手同组
  const callsGroupMeta = useMemo(() => {
    const m = new Map();
    for (const e of entries) {
      if (e.kind !== 'tool' || !e.name) continue;
      const cur = m.get(e.callsGroup) || { count: 0, names: [] };
      cur.count += 1;
      if (e.name) cur.names.push(e.name);
      m.set(e.callsGroup, cur);
    }
    return m;
  }, [entries]);

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

  // 头部三个指标以服务端全量聚合为准（首屏 totals），避免分页截断；
  // totals 缺失（旧接口 / 加载中）时回退到已加载步骤的本地计算。
  // totals 之后新到的步骤（WS 推送 / 分页）按 seq > totals.maxSeq 增量补上。
  const localRounds = useMemo(() => entries.reduce((n, e) => Math.max(n, e.round), 0), [entries]);
  // 时长/调用：服务端 totals 为全量基准。totals 之后：
  //  - seq > maxSeq 的新步整个计入；
  //  - seq <= maxSeq 的步按「相对快照的差值」补齐（响应晚到的在途调用）。
  const baseMaxSeq = totals?.maxSeq ?? null;
  const baseStats = baseStepStatsRef.current;
  let extraDurationMs = 0;
  let extraToolCalls = 0;
  for (const s of steps) {
    const latency = s.latencyMs || 0;
    const tools = respBlocks(s.response).filter((b) => b?.type === 'tool_use').length;
    if (baseMaxSeq == null || s.seq > baseMaxSeq) {
      extraDurationMs += latency;
      extraToolCalls += tools;
      continue;
    }
    const base = baseStats?.get(s.seq);
    if (!base) continue; // 快照时已计入且无差值信息
    extraDurationMs += Math.max(0, latency - base.latency);
    extraToolCalls += Math.max(0, tools - base.tools);
  }
  const durationMs = (totals?.durationMs ?? 0) + extraDurationMs;
  const toolCallTotal = (totals?.toolCalls ?? 0) + extraToolCalls;
  // 轮次 = 列表实际渲染的轮次数（与可见「第 N 轮」严格一致；分页时也只算已加载）
  const rounds = localRounds;

  const openReport = async () => {
    if (reportOpen) { setReportOpen(false); return; }
    setReportOpen(true);
    if (report || reportLoading) return;
    setReportLoading(true);
    try {
      const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/report`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.status === 'ready') setReport(data);
    } catch {
      showToast('error', t('trajectory.report_load_failed'));
    } finally {
      setReportLoading(false);
    }
  };

  const copyAfter = (s) => {
    const text = typeof s?.after === 'string' ? s.after : '';
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    setCopiedAfter(s);
  };

  // evidence seq → 定位到该步的首个条目（时间线点击选中同一实现）
  const jumpToSeq = (seq) => {
    const e = entries.find((en) => en.stepSeq === seq);
    if (e) selectEntry(e.id, { scroll: true });
  };

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', SURFACE, T1)}>
      {/* 指标栏：三个指标即可点击开关（对齐 DeepSeek toolbar） */}
      <div className={cn('shrink-0 border-b px-3 h-8 flex items-center', BORDER)}>
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <button
            type="button"
            aria-pressed={durationOn}
            title={durationOn ? t('trajectory.use_equal_width') : t('trajectory.use_actual_duration')}
            onClick={() => setDurationOn((p) => !p)}
            className={cn('flex items-center gap-1.5 text-xs rounded px-1 -mx-1 h-6', consoleButtonFocusClass, durationOn ? 'text-sky-700 dark:text-sky-300 bg-sky-100/60 dark:bg-sky-500/10' : T2, 'hover:bg-zinc-100')}
          >
            <Clock className="w-3.5 h-3.5 text-zinc-400" strokeWidth={1.75} />
            {t('trajectory.metric_duration')} <b className={cn(T1, 'font-mono')}>{(durationMs / 1000).toFixed(1)}s</b>
          </button>
          <button
            type="button"
            aria-pressed={turnsCollapsed}
            title={turnsCollapsed ? t('trajectory.expand_turns') : t('trajectory.collapse_turns')}
            onClick={toggleAllGroups}
            className={cn('flex items-center gap-1.5 text-xs rounded px-1 -mx-1 h-6', consoleButtonFocusClass, turnsCollapsed ? 'text-sky-700 dark:text-sky-300 bg-sky-100/60 dark:bg-sky-500/10' : T2, 'hover:bg-zinc-100')}
          >
            <Layers className="w-3.5 h-3.5 text-zinc-400" strokeWidth={1.75} />
            {t('trajectory.metric_rounds')} <b className={cn(T1, 'font-mono')}>{rounds}</b>
            <span className="text-[10px] text-zinc-400">{turnsCollapsed ? '⊞' : '⊟'}</span>
          </button>
          <button
            type="button"
            aria-pressed={callsCollapsed}
            title={callsCollapsed ? t('trajectory.expand_calls') : t('trajectory.collapse_calls')}
            onClick={() => { setCallsCollapsed((p) => !p); setExpandedGroups({}); }}
            className={cn('flex items-center gap-1.5 text-xs rounded px-1 -mx-1 h-6', consoleButtonFocusClass, callsCollapsed ? 'text-sky-700 dark:text-sky-300 bg-sky-100/60 dark:bg-sky-500/10' : T2, 'hover:bg-zinc-100')}
          >
            <Zap className="w-3.5 h-3.5 text-zinc-400" strokeWidth={1.75} />
            {t('trajectory.metric_calls')} <b className={cn(T1, 'font-mono')}>{toolCallTotal}</b>
            <span className="text-[10px] text-zinc-400">{callsCollapsed ? '⊞' : '⊟'}</span>
          </button>
          <div className="flex-1" />
          <div className={cn('flex items-center gap-1.5 w-44 h-6 px-2 rounded-md border bg-surface focus-within:border-zinc-500', 'border-zinc-300')}>
            <Search className="w-3.5 h-3.5 text-zinc-400 shrink-0" strokeWidth={1.75} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('trajectory.search_placeholder')}
              className={cn('min-w-0 flex-1 bg-transparent text-xs outline-none', T1, 'placeholder:text-zinc-400')}
            />
          </div>
          <button
            type="button"
            onClick={extractSkill}
            disabled={extracting}
            title={t('skills:extract_from_session', { defaultValue: 'Extract as Skill' })}
            className={cn('flex items-center gap-1.5 h-6 px-2.5 rounded-md border text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed', 'border-zinc-300 bg-surface text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900', consoleButtonFocusClass)}
          >
            {extracting ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} /> : <Sparkles className="w-3.5 h-3.5" strokeWidth={1.75} />}
          </button>
          <button
            type="button"
            onClick={openReport}
            aria-pressed={reportOpen}
            title={t('trajectory.report_button')}
            aria-label={t('trajectory.report_button')}
            className={cn('flex items-center justify-center w-7 h-6 rounded-md border text-xs font-medium disabled:cursor-not-allowed', 'border-zinc-300 bg-surface text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900', consoleButtonFocusClass, reportOpen && 'bg-zinc-100 text-zinc-900')}
          >
            {reportLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} /> : <Lightbulb className="w-3.5 h-3.5" strokeWidth={1.75} />}
          </button>
          <button
            type="button"
            onClick={exportJsonl}
            disabled={exporting}
            title={t('trajectory.export_jsonl')}
            className={cn('flex items-center gap-1.5 h-6 px-2.5 rounded-md border text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed', 'border-zinc-300 bg-surface text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900', consoleButtonFocusClass)}
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} /> : <Download className="w-3.5 h-3.5" strokeWidth={1.75} />}
          </button>
        </div>
      </div>

      {/* 轨迹时间线 */}
      <Timeline
        model={model}
        selectedId={selectedId}
        range={range}
        onRangeChange={setRange}
        onSelect={(id) => selectEntry(id)}
        onRecordFocus={(id) => selectEntry(id, { scroll: true })}
        minZoom={durationOn ? MINIMUM_ZOOM_MS : MINIMUM_ZOOM_UNITS}
      />

      {/* 主体：消息级列表 + 详情 */}
      <div className="flex flex-1 min-h-0">
        <div ref={listRef} className="flex-1 min-w-0 overflow-y-auto">
          {loading && steps.length === 0 && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 text-zinc-400 animate-spin" strokeWidth={1.5} />
            </div>
          )}
          {groups.map((g, gi) => {
            const expandable = g.round > 0;
            const expanded = !expandable || groupExpanded(g.round);
            return (
              <div key={gi}>
                {g.round > 0 && (
                  <button
                    type="button"
                    onClick={() => expandable && toggleGroup(g.round)}
                    className={cn('sticky top-0 z-10 w-full flex items-center gap-2 px-3 h-7 backdrop-blur border-b text-left', 'bg-zinc-100/95', 'border-zinc-200', consoleButtonFocusClass, expandable && 'cursor-pointer')}
                  >
                    <span className={cn('text-[10px] shrink-0', T3)}>{t('trajectory.round_label', { n: g.round })}</span>
                    <span className="text-[11px] text-sky-700 dark:text-sky-300 truncate min-w-0">{preview(g.title, 60)}</span>
                    {expandable && !expanded && (
                      <span className={cn('ml-auto text-[10px] shrink-0 font-mono', T3)}>
                        {t('trajectory.group_steps', { count: roundMeta.get(g.round)?.steps || 0 })}
                        {' · '}
                        ⚙ {t('trajectory.group_calls', { count: roundMeta.get(g.round)?.toolCalls || 0 })}
                      </span>
                    )}
                  </button>
                )}
                {expanded && g.entries.map((e, i) => {
                const style = KIND_STYLES[e.kind] || KIND_STYLES.assistant;
                const Icon = style.icon;
                const dimmed = range !== null && focusIds !== null && !focusIds.has(e.id);
                // 工具调用折叠：按「两个助手之间」聚合（中间没有助手消息的多个
                // 纯工具步合并成一组）。在该组第一个工具条目处渲染一行汇总。
                if (callsCollapsed && e.kind === 'tool' && !expandedGroups[e.callsGroup]) {
                  const prev = g.entries[i - 1];
                  const firstOfGroup = !prev || prev.callsGroup !== e.callsGroup || prev.kind !== 'tool';
                  if (!firstOfGroup) return null;
                  const meta = callsGroupMeta.get(e.callsGroup);
                  if (!meta) return null;
                  return (
                    <div key={`calls-${e.callsGroup}`} className="pl-10 pr-3 py-1">
                      <button
                        type="button"
                        onClick={() => setExpandedGroups((o) => ({ ...o, [e.callsGroup]: true }))}
                        title={t('trajectory.expand_calls')}
                        className={cn('text-[10px] text-zinc-400 font-mono hover:text-zinc-700', consoleButtonFocusClass)}
                      >
                        ⚙ {t('trajectory.calls_summary', { count: meta.count, tools: meta.names.join(', ') })}
                      </button>
                    </div>
                  );
                }
                return (
                  <Fragment key={e.id}>
                  <button
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
                      <span className={cn(style.text, e.kind === 'tool' && 'font-mono text-[11px]', e.kind !== 'tool' && !e.text && e.thinking && 'text-zinc-500')}>
                        {preview(e.text || e.thinking, e.kind === 'tool' ? 120 : 200)}
                      </span>
                      {e.result && (
                        <>
                          <span className="text-zinc-400 mx-1">→</span>
                          <span className="font-mono text-[11px] text-zinc-500">{preview(e.result.text, 100)}</span>
                        </>
                      )}
                    </span>
                    {e.step.status === 'error' && <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" strokeWidth={2} />}
                  </button>
                  </Fragment>
                );
              })}
                </div>
              );
            })}
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

        {/* 右侧详情面板：报告开启时滑入报告，否则显示条目详情 */}
        <aside className={cn('w-[400px] shrink-0 border-l flex flex-col min-h-0', CARD, BORDER)}>
          {reportOpen ? (
            <SessionReportPanel
              report={report}
              onClose={() => setReportOpen(false)}
              onJumpToSeq={jumpToSeq}
              onCopyAfter={copyAfter}
              copiedAfter={copiedAfter}
            />
          ) : (
            <DetailPanel entry={selected} round={selected ? (roundByEntry.get(selected.id) || 0) : 0} entries={entries} onNavigate={selectEntry} />
          )}
        </aside>
      </div>
    </div>
  );
}
