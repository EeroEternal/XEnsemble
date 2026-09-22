import { formatTokens } from '../../lib/formatTokens';

/** 多段堆叠默认配色（按 series 顺序取用；图例圆点与柱内分段共用同一 class） */
export const SERIES_COLORS = [
  'bg-blue-500',
  'bg-emerald-400',
  'bg-amber-400',
  'bg-violet-500',
  'bg-rose-400',
  'bg-cyan-500',
];

/**
 * 迷你堆叠柱状图（纯 CSS，无图表库依赖）。
 *
 * @param {Array<{key:string, label:string, color:string}>} series
 *        堆叠段定义（自下而上）：key 对应 data 各项 values 中的字段名，
 *        color 为 Tailwind 背景 class（柱内分段与 tooltip 圆点共用）。
 * @param {Array<{label:string, tip?:string, values:Record<string,number>}>} data
 *        每个数据点的分段数值按 series.key 从 values 取。
 * @param {number} [height] 像素高度，默认 96
 * @param {boolean} [showAxes=false] 显示横纵坐标（Y 轴刻度 + 网格线 + X 轴起止日期）
 * @param {(v:number)=>string} [formatValue] 刻度与 tooltip 数值格式化（默认 token 缩写）
 * @param {string} [totalLabel] tooltip 合计行名称（如「合计」）；提供时在分段明细下展示
 * @param {string} [yAxisWidth] Y 轴刻度列的固定宽度 class（如 'w-8'）。不传则按内容撑开。
 *        并排的两张图若刻度文案宽度不同（如 "$0.21" vs "$0.5757"），绘图区左边界会不一致、
 *        X 轴线段对不齐；传入相同值即可让两图绘图区严格对齐。
 * @param {boolean} [legendOverlay=false] 把图例悬浮在绘图区右上角内侧（稍低于顶端刻度、
 *        纵轴右侧），不占独立布局行——卡片顶部不产生空白带。多 series 且需要顶部
 *        对齐的并排图使用。
 */
export default function MiniBarChart({
  data = [],
  series = [],
  height = 96,
  showAxes = false,
  formatValue = formatTokens,
  totalLabel,
  yAxisWidth = '',
  legendOverlay = false,
}) {
  if (!data.length || !series.length) return null;
  const totals = data.map((d) => series.reduce((sum, s) => sum + (Number(d.values?.[s.key]) || 0), 0));
  const max = Math.max(...totals, 1);

  const legend = series.length > 1 && (
    // pointer-events-none：不挡柱子 tooltip。absolute 定位在绘图区右上角，
    // top-3 让图例稍低于顶端刻度行（"纵坐标顶部"），left 侧让开 Y 轴列。
    <div className="pointer-events-none absolute right-1 top-3 z-10 flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
      {series.map((s) => (
        <span key={s.key} className="flex shrink-0 items-center gap-1 text-[11px] text-zinc-400">
          <span className={`inline-block h-1.5 w-1.5 rounded-sm ${s.color}`} /> {s.label}
        </span>
      ))}
    </div>
  );

  const bars = (
    <div className="relative flex items-end gap-[2px]" style={{ height }}>
      {showAxes && (
        <>
          {/* 横向网格线：顶部 / 1/2 处（与左轴 max、max/2 刻度对齐，虚线弱化） */}
          <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-zinc-200" />
          <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-zinc-100" />
          {/* X 轴基线：柱底水平实线（与左轴 0 刻度对齐） */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-zinc-200" />
          {/* Y 轴：左侧竖线，与刻度数字列相接 */}
          <div className="pointer-events-none absolute inset-y-0 left-0 border-l border-zinc-200" />
        </>
      )}
      {data.map((d, i) => {
        const total = totals[i];
        const hPct = (total / max) * 100;
        const nonzero = series.filter((s) => (Number(d.values?.[s.key]) || 0) > 0);
        return (
          <div key={`${d.label}-${i}`} className="group relative flex h-full flex-1 items-end justify-center">
            <div
              className="w-full max-w-[18px] overflow-hidden rounded-[2px] bg-zinc-100 transition-colors group-hover:bg-zinc-200"
              style={{ height: `${Math.max(hPct, 1.5)}%` }}
            >
              {total > 0 && (
                // 自下而上按 series 顺序堆叠（flex-col-reverse：首个 series 贴底）
                <div className="flex h-full w-full flex-col-reverse">
                  {nonzero.map((s) => (
                    <div
                      key={s.key}
                      className={`w-full ${s.color}`}
                      style={{ height: `${((Number(d.values[s.key]) || 0) / total) * 100}%` }}
                    />
                  ))}
                </div>
              )}
            </div>
            {total > 0 && (
              <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-200 bg-surface px-2 py-1 text-[11px] leading-relaxed shadow-lg group-hover:block">
                <div className="text-zinc-400">{d.tip ?? d.label}</div>
                {nonzero.map((s) => (
                  <div key={s.key} className="text-zinc-600">
                    <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-sm ${s.color} align-middle`} />
                    {s.label} {formatValue(Number(d.values[s.key]))}
                  </div>
                ))}
                {totalLabel && (
                  <div className="font-medium text-zinc-800">
                    {totalLabel} {formatValue(total)}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  if (!showAxes) {
    if (legendOverlay) return <div className="relative">{bars}{legend}</div>;
    return bars;
  }

  return (
    <div className="flex gap-2">
      <div className={`flex shrink-0 flex-col justify-between text-right text-[10px] tabular-nums text-zinc-400 ${yAxisWidth}`} style={{ height }}>
        <span className="truncate">{formatValue(max)}</span>
        <span className="truncate">{formatValue(max / 2)}</span>
        <span>0</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative">
          {bars}
          {legendOverlay && legend}
        </div>
        <div className="mt-1 flex justify-between text-[10px] tabular-nums text-zinc-400">
          <span>{data[0]?.label}</span>
          {data.length > 2 && <span>{data[Math.floor((data.length - 1) / 2)]?.label}</span>}
          <span>{data[data.length - 1]?.label}</span>
        </div>
      </div>
    </div>
  );
}
