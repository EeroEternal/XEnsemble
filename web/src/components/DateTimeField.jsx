import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../lib/utils';
import { consoleInputClass, consoleMenuDropdownZClass } from '../lib/consoleTokens';
import { parseAtLocal } from '../lib/dateTimeFormat';

const pad2 = (n) => String(n).padStart(2, '0');
const POPUP_MIN_SPACE = 340;
const POPUP_GAP = 4;

/**
 * 单次执行时间输入：等宽文本框（YYYY-MM-DD HH:mm，本地时区）+ 自绘日历弹层。
 * 不用原生 datetime 控件——避免浏览器语言格式混杂与行高差异导致的弹窗抖动。
 * 弹层经 portal 渲染（fixed 定位），不影响弹窗本体高度。
 */
export default function DateTimeField({ id, value, onChange, placeholder = 'YYYY-MM-DD HH:mm' }) {
  const { i18n } = useTranslation();
  const zh = i18n.language?.startsWith('zh');
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [view, setView] = useState(() => ({ y: new Date().getFullYear(), m: new Date().getMonth() }));
  const rootRef = useRef(null);
  const popRef = useRef(null);

  // 当前输入的合法时刻（用于选中态/时刻选择回显）；非法时用兜底
  const parsed = parseAtLocal(value);
  const valid = Number.isFinite(parsed);

  const openPopover = () => {
    const base = valid ? new Date(parsed) : new Date();
    setView({ y: base.getFullYear(), m: base.getMonth() });
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom;
      setPos({
        left: rect.left,
        top: rect.bottom,
        bottom: rect.top,
        dropUp: spaceBelow < POPUP_MIN_SPACE,
      });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (rootRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKeyDown = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onScrollResize = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize);
    };
  }, [open]);

  const emit = (y, m, day, hh, mm) => onChange?.(`${y}-${pad2(m + 1)}-${pad2(day)} ${pad2(hh)}:${pad2(mm)}`);

  // 选日期：保留输入中已有时刻（合法时），否则默认 09:00
  const pickDay = (day) => {
    const base = valid ? new Date(parsed) : null;
    emit(view.y, view.m, day, base ? base.getHours() : 9, base ? base.getMinutes() : 0);
  };
  const setHour = (hh) => {
    const base = valid ? new Date(parsed) : new Date(view.y, view.m, 1, hh, 0);
    emit(view.y, view.m, base.getDate(), hh, base.getMinutes());
  };
  const setMinute = (mm) => {
    const base = valid ? new Date(parsed) : new Date(view.y, view.m, 1, 9, mm);
    emit(view.y, view.m, base.getDate(), base.getHours(), mm);
  };

  const timeBase = valid ? new Date(parsed) : null;
  const curHour = timeBase ? timeBase.getHours() : 9;
  const curMinute = timeBase ? timeBase.getMinutes() : 0;
  const hourOptions = Array.from({ length: 24 }, (_, i) => i);
  const minuteOptions = Array.from({ length: 60 }, (_, i) => i);

  // 月视图网格：周日起始
  const firstDay = new Date(view.y, view.m, 1).getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const cells = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const today = new Date();
  const isToday = (d) => today.getFullYear() === view.y && today.getMonth() === view.m && today.getDate() === d;
  const isSelected = (d) => valid
    && parsed && new Date(parsed).getFullYear() === view.y
    && new Date(parsed).getMonth() === view.m && new Date(parsed).getDate() === d;

  const weekHeaders = zh
    ? ['日', '一', '二', '三', '四', '五', '六']
    : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const monthTitle = zh
    ? `${view.y} 年 ${view.m + 1} 月`
    : new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(view.y, view.m, 1));

  const dayBtn = (d) => cn(
    'flex h-7 w-7 items-center justify-center rounded-md text-xs transition-colors',
    isSelected(d) ? 'bg-zinc-900 text-white' : 'text-zinc-700 hover:bg-zinc-100',
    !isSelected(d) && isToday(d) && 'border border-zinc-400',
  );

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={rootRef}
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        className={cn(consoleInputClass, 'h-[38px] font-mono pr-9')}
      />
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPopover())}
        aria-label={zh ? '选择日期' : 'Pick date'}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 focus:outline-none focus:ring-0"
      >
        <CalendarDays className="w-4 h-4" />
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{
            position: 'fixed',
            left: Math.max(8, Math.min(pos.left, window.innerWidth - 264)),
            ...(pos.dropUp
              ? { bottom: window.innerHeight - pos.bottom + POPUP_GAP }
              : { top: pos.top + POPUP_GAP }),
          }}
          className={cn('w-64 rounded-lg border border-zinc-200 bg-surface p-2 shadow-lg shadow-zinc-200/50', consoleMenuDropdownZClass)}
          role="dialog"
        >
          <div className="flex items-center justify-between px-1 pb-1">
            <button type="button" onClick={() => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }))} className="p-1 rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900" aria-label={zh ? '上个月' : 'Previous month'}>
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-semibold text-zinc-900">{monthTitle}</span>
            <button type="button" onClick={() => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }))} className="p-1 rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900" aria-label={zh ? '下个月' : 'Next month'}>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-y-0.5">
            {weekHeaders.map((w) => (
              <div key={w} className="flex h-6 items-center justify-center text-[10px] font-medium text-zinc-400">{w}</div>
            ))}
            {cells.map((d, i) => (
              d == null
                ? <div key={`b${i}`} />
                : (
                  <button key={d} type="button" onClick={() => pickDay(d)} className={dayBtn(d)}>
                    {d}
                  </button>
                )
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 border-t border-zinc-100 pt-2">
            <select
              aria-label={zh ? '小时' : 'Hour'}
              value={curHour}
              onChange={(e) => setHour(Number(e.target.value))}
              className="w-full bg-surface border border-zinc-300 rounded-md px-2 py-1.5 text-xs text-zinc-900 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900"
            >
              {hourOptions.map((h) => <option key={h} value={h}>{pad2(h)}</option>)}
            </select>
            <select
              aria-label={zh ? '分钟' : 'Minute'}
              value={curMinute}
              onChange={(e) => setMinute(Number(e.target.value))}
              className="w-full bg-surface border border-zinc-300 rounded-md px-2 py-1.5 text-xs text-zinc-900 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900"
            >
              {minuteOptions.map((mm) => <option key={mm} value={mm}>{pad2(mm)}</option>)}
            </select>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
