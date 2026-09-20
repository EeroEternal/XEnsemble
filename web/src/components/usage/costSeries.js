import { SERIES_COLORS } from './MiniBarChart';

/** 「其他」合并段在 values / series 中使用的保留 key（不会与 agentId 冲突） */
export const OTHER_SERIES_KEY = '__other__';

/**
 * 把每日 costByAgent 转成堆叠图所需的 series + data。
 *
 * 配色数量有限（SERIES_COLORS），若 agent 数超过配色数，原先直接 slice 会静默丢掉
 * 尾部 agent 的费用，导致柱高小于当日真实合计、费用预估偏低。这里改为：超出部分
 * 合并为一个「其他」段（占用最后一个配色），保证每根柱子的分段之和 = 当日真实合计。
 *
 * 仅在 agent 数超过配色数时才引入「其他」段，否则所有 agent 各自成段。
 *
 * @param {Array<{day:string, costByAgent?:Record<string,number>}>} trend
 * @param {string} otherLabel 「其他」段显示名（走 i18n）
 * @returns {{series:Array<{key,label,color}>, data:Array<{label,tip,values}>, hasOther:boolean}}
 */
export function buildAgentCostChart(trend = [], otherLabel = 'Other') {
    const totals = new Map();
    for (const d of trend) {
        for (const [k, v] of Object.entries(d.costByAgent || {})) {
            totals.set(k, (totals.get(k) || 0) + (Number(v) || 0));
        }
    }
    if (totals.size === 0) return { series: [], data: [], hasOther: false };

    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const hasOther = ranked.length > SERIES_COLORS.length;
    const keep = hasOther ? ranked.slice(0, SERIES_COLORS.length - 1) : ranked;
    const rest = new Set(ranked.slice(keep.length));

    const series = keep.map((k, i) => ({ key: k, label: k, color: SERIES_COLORS[i] }));
    if (hasOther) {
        series.push({
            key: OTHER_SERIES_KEY,
            label: otherLabel,
            color: SERIES_COLORS[SERIES_COLORS.length - 1],
        });
    }

    const data = trend.map((d) => {
        const src = d.costByAgent || {};
        const values = {};
        for (const k of keep) values[k] = Number(src[k]) || 0;
        if (hasOther) {
            let other = 0;
            for (const k of rest) other += Number(src[k]) || 0;
            values[OTHER_SERIES_KEY] = other;
        }
        return { label: d.day, tip: d.day, values };
    });

    return { series, data, hasOther };
}
