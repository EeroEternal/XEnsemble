import { useMemo, useState, useRef, useEffect } from 'react';
import { formatTokens } from '../../lib/formatTokens';

/**
 * 用户 Token 成本散点图（纯 SVG + HTML tooltip，无图表库依赖）。
 *
 * 横轴 = 用户总 token，纵轴 = 估算金额（USD），两侧均有轴线与刻度。
 * 一条**斜向右上**的虚线是「中位成本效率基准」：所有用户的 总成本/总token
 * 的中位单价（USD / 1M tokens）× token 数——单价恰为中位的用户都落在线上，
 * 高于线的用户花的单位价钱更贵。单价高于中位 ×1.5 的用户圆点用琥珀色区分。
 *
 * tooltip 用 HTML 实现：svg 的 <title> 在 preserveAspectRatio="none" 拉伸的
 * 容器里时部分浏览器不弹（实测），HTML 层不受 svg 变换影响。
 *
 * 高度：绘图区由父容器 flex-1 弹性决定（组件根为 flex-col，吃满卡片），
 * 用 ResizeObserver 实测实际像素高供坐标计算；height prop 只作空态占位。
 *
 * @param {Array<{userId:string, username:string, displayName?:string|null, totalTokens:number, requests?:number, costUsd:number|null}>} users
 * @param {number} [height=104] 空态占位高度
 */
const HIGH_COST_RATIO = 1.5;  // 点的单价 > 基准单价 × 1.5 视为偏高
const PAD = { top: 14, right: 14, left: 44 };
const VB_W = 600;             // viewBox 逻辑宽度（preserveAspectRatio=none 拉伸填充）

export default function UserCostScatter({ users = [], height = 104 }) {
  const [hover, setHover] = useState(null);
  const plotRef = useRef(null);
  const [plotH, setPlotH] = useState(height);

  // 实测绘图区像素高：flex-1 下容器高度由卡片剩余空间决定，写死值会对不齐
  useEffect(() => {
    const el = plotRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const h = Math.round(entries[0]?.contentRect?.height || 0);
      if (h > 0) setPlotH(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const points = useMemo(
    () => users
      .filter((u) => (u.totalTokens || 0) > 0 && u.costUsd != null)
      .map((u) => ({ ...u, x: u.totalTokens, y: u.costUsd })),
    [users],
  );

  // 中位单价（成本效率）：每个用户 costUsd/totalTokens（USD per token）取中位数。
  // 基准线 = 该单价 × token 数 → 斜向右上的直线；单价恰为中位的用户都落在线上。
  const baseUnit = useMemo(() => {
    const units = points.map((p) => p.y / p.x).sort((a, b) => a - b);
    if (!units.length) return null;
    const mid = Math.floor(units.length / 2);
    return units.length % 2 ? units[mid] : (units[mid - 1] + units[mid]) / 2;
  }, [points]);

  const highCount = baseUnit != null
    ? points.filter((p) => p.y / p.x > baseUnit * HIGH_COST_RATIO).length
    : 0;

  const { xs, ys, xMax, yMax, baseLine } = useMemo(() => {
    const h = plotH;
    const xMax = Math.max(...points.map((p) => p.x), 1);
    const yMax = Math.max(...points.map((p) => p.y), 0.01) * 1.08; // 8% 头部空间防贴顶
    const xs = (x) => PAD.left + (x / xMax) * (VB_W - PAD.left - PAD.right);
    // 基线贴 svg 底边（bottom pad = 0）：左图柱底也贴其绘图盒底边，两图 X 轴基线同高。
    // 顶部仍留白防最大点贴顶；刻度文字由 svg 下方的 HTML 行承担（同左图）。
    const PAD_B = 0;
    const ys = (y) => h - PAD_B - (y / yMax) * (h - PAD.top - PAD_B);
    const baseLine = baseUnit != null
      ? { x1: 0, y1: ys(0), x2: xMax, y2: ys(baseUnit * xMax) }  // 过原点的斜线
      : null;
    return { xs, ys, xMax, yMax, baseLine };
  }, [points, baseUnit, plotH]);

  if (!points.length) {
    return (
      <div className="flex items-center justify-center text-xs text-zinc-400" style={{ height }}>
        暂无成本数据
      </div>
    );
  }

  const fmtY = (v) => `$${v >= 1 ? v.toFixed(2) : v.toFixed(4)}`;
  const fmtUnit = (u) => `$${u >= 1 ? u.toFixed(2) : u.toFixed(4)}/1M`;
  const gridY = [yMax, yMax / 2, 0];
  const h = plotH;

  // 图例置于图上方（与并排柱状图的图例位置一致，保证两图绘图区顶部对齐）。
  // 结构与左图逐字对应：自然行高 + mb-2（左图图例行同款），不定高——高度差会
  // 直接移动绘图区起点，破坏两图 X 轴基线对齐。
  const legend = (
    <div className="mb-2 flex items-center gap-x-3 overflow-hidden whitespace-nowrap">
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-zinc-400">
        <span className="inline-block h-2 w-2 rounded-full bg-blue-500" /> 用户
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-zinc-400">
        <span className="inline-block h-2 w-2 rounded-full bg-amber-500" /> 成本偏高（单价 &gt; 中位 ×{HIGH_COST_RATIO}）
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-zinc-400">
        <span className="inline-block h-px w-4 border-t border-dashed border-zinc-400" />
        中位基准 {baseUnit != null ? fmtUnit(baseUnit * 1e6) : ''}{highCount > 0 ? `（${highCount} 人偏高）` : ''}
      </span>
    </div>
  );

  return (
    // 根必须 flex-1 撑满卡片（卡片是 grid 定高的 flex 列）：否则根高塌成内容高，
    // 下层 flex-1 的 svg 包裹层跟着塌 0，svg 被压成一条细线（实测回归）。
    // 刻度文字层的定位上下文是 svg 包裹层（relative），而非含图例的整卡，
    // 否则图例高度会把 ys() 算出的坐标整体顶偏、与图例文字重叠。
    <div className="flex min-h-0 flex-1 flex-col">
      {legend}
      <div ref={plotRef} className="relative min-h-0 flex-1">
      <svg viewBox={`0 0 ${VB_W} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%' }} className="block">
        {/* 水平网格线 */}
        {gridY.map((v, i) => (
          <line key={i} x1={PAD.left} x2={VB_W - PAD.right} y1={ys(v)} y2={ys(v)}
            stroke={i === gridY.length - 1 ? '#e4e4e7' : '#f4f4f5'}
            strokeDasharray={i === gridY.length - 1 ? '0' : '3 3'} vectorEffect="non-scaling-stroke" />
        ))}
        {/* 纵轴（Y 轴竖线）+ 横轴基线（基线贴 svg 底边，与左图柱底同位） */}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top - 6} y2={h}
          stroke="#d4d4d8" vectorEffect="non-scaling-stroke" />
        <line x1={PAD.left} x2={VB_W - PAD.right} y1={h} y2={h}
          stroke="#d4d4d8" vectorEffect="non-scaling-stroke" />
        {/* 中位成本效率基准线：过原点的斜线（单价中位 × token） */}
        {baseLine && (
          <line x1={xs(baseLine.x1)} y1={baseLine.y1} x2={xs(baseLine.x2)} y2={baseLine.y2}
            stroke="#a1a1aa" strokeWidth="1.5" strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
        )}
        {/* 散点（hover 事件直接绑在 circle 上，HTML tooltip 显示用户信息） */}
        {points.map((p) => {
          const high = baseUnit != null && p.y / p.x > baseUnit * HIGH_COST_RATIO;
          return (
            <circle key={p.userId} cx={xs(p.x)} cy={ys(p.y)} r="5"
              fill={high ? '#f59e0b' : '#3b82f6'} fillOpacity={hover?.userId === p.userId ? 1 : 0.85}
              stroke="#fff" strokeWidth="1.5" vectorEffect="non-scaling-stroke"
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHover(p)}
              onMouseLeave={() => setHover(null)}>
            </circle>
          );
        })}
      </svg>

      {/* Y 轴刻度文字（HTML 叠加，定位上下文 = svg 包裹层，坐标与 ys() 一致） */}
      <div className="pointer-events-none absolute inset-0">
        {gridY.map((v, i) => (
          <span key={i} className="absolute -translate-y-1/2 text-[10px] tabular-nums text-zinc-400"
            style={{ left: 0, width: PAD.left - 6, textAlign: 'right', top: ys(v) }}>{fmtY(v)}</span>
        ))}
        {/* 基准线单价标注（贴在线的上端） */}
        {baseUnit != null && (
          <span className="absolute whitespace-nowrap rounded bg-zinc-100 px-1 py-px text-[10px] tabular-nums text-zinc-500"
            style={{ left: `${(xs(xMax * 0.62) / VB_W) * 100}%`, top: ys(baseUnit * xMax * 0.62) - 14 }}>
            中位 {fmtUnit(baseUnit * 1e6)}
          </span>
        )}
        {/* HTML tooltip：跟随悬停点（svg 不拉伸文字层，信息完整可读） */}
        {hover && (
          <div className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-zinc-200 bg-surface px-2 py-1 text-[11px] leading-relaxed shadow-lg"
            style={{ left: `${(xs(hover.x) / VB_W) * 100}%`, top: ys(hover.y) - 8 }}>
            <div className="font-medium text-zinc-800">{hover.username}</div>
            {hover.displayName ? <div className="text-zinc-400">{hover.displayName}</div> : null}
            <div className="text-zinc-600">
              {formatTokens(hover.x)} tokens · {hover.requests != null ? `${hover.requests} 次请求 · ` : ''}{fmtY(hover.y)}
            </div>
            <div className={hover.y / hover.x > baseUnit * HIGH_COST_RATIO ? 'text-amber-600' : 'text-zinc-400'}>
              单价 {fmtUnit((hover.y / hover.x) * 1e6)}{hover.y / hover.x > baseUnit * HIGH_COST_RATIO ? '（成本偏高）' : ''}
            </div>
          </div>
        )}
      </div>
      </div>

      {/* X 轴刻度：与左图（MiniBarChart）刻度行同款 mt-1，基线到刻度行的间距一致 */}
      <div className="mt-1 flex justify-between pl-11 pr-3 text-[10px] tabular-nums text-zinc-400">
        <span>0</span>
        <span>{formatTokens(xMax / 2)}</span>
        <span>{formatTokens(xMax)}</span>
      </div>
    </div>
  );
}
