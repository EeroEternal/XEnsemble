import { formatTokens } from '../../lib/formatTokens';

/**
 * 迷你堆叠柱状图（纯 CSS，无图表库依赖）。
 *
 * @param {Array<{label:string, primary:number, secondary?:number, tip?:string}>} data
 *        primary/compression 两段堆叠：primary=Prompt（蓝），secondary=Completion（绿）。
 * @param {number} [height] 像素高度，默认 96
 * @param {string} [primaryLabel] tooltip 中 primary 段的名称
 * @param {string} [secondaryLabel] tooltip 中 secondary 段的名称
 * @param {boolean} [showAxes=false] 显示横纵坐标（Y 轴刻度 + 网格线 + X 轴起止日期）
 * @param {(v:number)=>string} [formatValue] 刻度与 tooltip 数值格式化（默认 token 缩写）
 */
export default function MiniBarChart({
  data = [],
  height = 96,
  primaryLabel = 'Prompt',
  secondaryLabel = 'Completion',
  showAxes = false,
  formatValue = formatTokens,
}) {
  if (!data.length) return null;
  const totals = data.map((d) => (Number(d.primary) || 0) + (Number(d.secondary) || 0));
  const max = Math.max(...totals, 1);

  const bars = (
    <div className="relative flex items-end gap-[2px]" style={{ height }}>
      {showAxes && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-zinc-200" />
          <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-zinc-100" />
        </>
      )}
      {data.map((d, i) => {
        const p = Number(d.primary) || 0;
        const s = Number(d.secondary) || 0;
        const total = p + s;
        const hPct = (total / max) * 100;
        const pPct = total > 0 ? (p / total) * 100 : 0;
        return (
          <div key={`${d.label}-${i}`} className="group relative flex h-full flex-1 items-end justify-center">
            <div
              className="w-full max-w-[18px] overflow-hidden rounded-[2px] bg-zinc-100 transition-colors group-hover:bg-zinc-200"
              style={{ height: `${Math.max(hPct, 1.5)}%` }}
            >
              {total > 0 && (
                <>
                  <div className="w-full bg-emerald-400" style={{ height: `${100 - pPct}%` }} />
                  <div className="w-full bg-blue-500" style={{ height: `${pPct}%` }} />
                </>
              )}
            </div>
            {total > 0 && (
              <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-200 bg-surface px-2 py-1 text-[11px] leading-relaxed shadow-lg group-hover:block">
                <div className="text-zinc-400">{d.tip ?? d.label}</div>
                {s > 0 && (
                  <div className="text-zinc-600">
                    <span className="mr-1 inline-block h-1.5 w-1.5 rounded-sm bg-emerald-400 align-middle" />
                    {secondaryLabel} {formatValue(s)}
                  </div>
                )}
                <div className="font-medium text-zinc-800">
                  <span className="mr-1 inline-block h-1.5 w-1.5 rounded-sm bg-blue-500 align-middle" />
                  {primaryLabel} {formatValue(p)}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  if (!showAxes) return bars;

  return (
    <div className="flex gap-2">
      <div className="flex shrink-0 flex-col justify-between text-right text-[10px] tabular-nums text-zinc-400" style={{ height }}>
        <span>{formatValue(max)}</span>
        <span>{formatValue(max / 2)}</span>
        <span>0</span>
      </div>
      <div className="min-w-0 flex-1">
        {bars}
        <div className="mt-1 flex justify-between text-[10px] tabular-nums text-zinc-400">
          <span>{data[0]?.label}</span>
          {data.length > 2 && <span>{data[Math.floor((data.length - 1) / 2)]?.label}</span>}
          <span>{data[data.length - 1]?.label}</span>
        </div>
      </div>
    </div>
  );
}
