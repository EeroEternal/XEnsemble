import { formatTokens } from '../../lib/formatTokens';

/**
 * 横向条形列表（模型/项目分布复用）。
 * @param {Array<{key:string, totalTokens:number, requests?:number}>} items
 * @param {string} emptyText 空态文案
 * @param {string} unnamedText key 为空时的兜底文案
 */
export default function UsageBarList({ items = [], emptyText = '', unnamedText = '(unknown)' }) {
  if (!items.length) {
    return <p className="py-2 text-xs text-zinc-400">{emptyText}</p>;
  }
  const max = Math.max(...items.map((i) => Number(i.totalTokens) || 0), 1);
  return (
    <div className="space-y-1.5">
      {items.map((item) => {
        const v = Number(item.totalTokens) || 0;
        const pct = (v / max) * 100;
        const name = item.key || unnamedText;
        return (
          <div key={name} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-2.5">
            <span className="truncate text-xs text-zinc-600" title={name}>{name}</span>
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100">
              <div className="h-full rounded-full bg-zinc-800 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="font-mono text-[11px] tabular-nums text-zinc-500">
              {formatTokens(v)}
              {item.requests != null ? <span className="ml-1 text-zinc-400">· {item.requests}</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
