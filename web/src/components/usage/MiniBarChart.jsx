import { formatTokens } from '../../lib/formatTokens';

/**
 * 迷你堆叠柱状图（纯 CSS，无图表库依赖）。
 *
 * @param {Array<{label:string, primary:number, secondary?:number, tip?:string}>} data
 *        primary/compression 两段堆叠：primary=Prompt（蓝），secondary=Completion（绿）。
 * @param {number} [height] 像素高度，默认 96
 * @param {string} [primaryLabel] tooltip 中 primary 段的名称
 * @param {string} [secondaryLabel] tooltip 中 secondary 段的名称
 */
export default function MiniBarChart({
  data = [],
  height = 96,
  primaryLabel = 'Prompt',
  secondaryLabel = 'Completion',
}) {
  if (!data.length) return null;
  const totals = data.map((d) => (Number(d.primary) || 0) + (Number(d.secondary) || 0));
  const max = Math.max(...totals, 1);

  return (
    <div className="flex items-end gap-[2px]" style={{ height }}>
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
              <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] leading-relaxed shadow-lg group-hover:block">
                <div className="text-zinc-400">{d.tip ?? d.label}</div>
                {s > 0 && (
                  <div className="text-zinc-600">
                    <span className="mr-1 inline-block h-1.5 w-1.5 rounded-sm bg-emerald-400 align-middle" />
                    {secondaryLabel} {formatTokens(s)}
                  </div>
                )}
                <div className="font-medium text-zinc-800">
                  <span className="mr-1 inline-block h-1.5 w-1.5 rounded-sm bg-blue-500 align-middle" />
                  {primaryLabel} {formatTokens(p)}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
