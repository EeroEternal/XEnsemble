import { describe, it, expect } from 'vitest';
import { buildAgentCostChart, OTHER_SERIES_KEY } from './costSeries';
import { SERIES_COLORS } from './MiniBarChart';

const N = SERIES_COLORS.length; // 6

function trendOf(perDay) {
    // perDay: [{ day, agents: {a: cost, ...} }]
    return perDay.map((d) => ({ day: d.day, costByAgent: d.agents }));
}

describe('buildAgentCostChart', () => {
    it('每个 agent 各自成段当数量未超配色数', () => {
        const trend = trendOf([
            { day: '2026-09-19', agents: { pi: 1, cline: 2 } },
            { day: '2026-09-20', agents: { pi: 3, cline: 4 } },
        ]);
        const { series, data, hasOther } = buildAgentCostChart(trend);
        expect(hasOther).toBe(false);
        expect(series.map((s) => s.key).sort()).toEqual(['cline', 'pi']);
        expect(data).toHaveLength(2);
    });

    it('超出配色数的 agent 合并为「其他」，且每日分段之和 = 当日真实合计', () => {
        // 造 8 个 agent（> 6）
        const agentsFor = (mul) => Object.fromEntries(
            Array.from({ length: 8 }, (_, i) => [`a${i}`, (i + 1) * mul]),
        );
        const trend = trendOf([
            { day: '2026-09-19', agents: agentsFor(1) },
            { day: '2026-09-20', agents: agentsFor(2) },
        ]);
        const { series, data, hasOther } = buildAgentCostChart(trend, '其他');
        expect(hasOther).toBe(true);
        // 段数 = 配色数（Top5 具名 + 其他）
        expect(series).toHaveLength(N);
        expect(series[series.length - 1].key).toBe(OTHER_SERIES_KEY);
        expect(series[series.length - 1].label).toBe('其他');

        // 关键：每日柱高（分段之和）必须等于当日全部 agent 之和
        for (const d of trend) {
            const expected = Object.values(d.costByAgent).reduce((a, b) => a + b, 0);
            const row = data.find((x) => x.label === d.day);
            const actual = Object.values(row.values).reduce((a, b) => a + b, 0);
            expect(actual).toBeCloseTo(expected, 6);
        }
    });

    it('恰好等于配色数时不产生「其他」段', () => {
        const agents = Object.fromEntries(Array.from({ length: N }, (_, i) => [`a${i}`, i + 1]));
        const { series, hasOther } = buildAgentCostChart(trendOf([{ day: 'd1', agents }]));
        expect(hasOther).toBe(false);
        expect(series).toHaveLength(N);
    });

    it('cline 当天费用高但区间累计排第 7 时，其费用仍进入「其他」不被丢弃', () => {
        // 5 个 agent 区间累计更高（具名），a5 与 cline 累计更低（并入「其他」）
        const base = { a0: 100, a1: 90, a2: 80, a3: 70, a4: 60, a5: 50 };
        const trend = trendOf([
            { day: 'd1', agents: { ...base, cline: 40 } },
            { day: 'd2', agents: { ...base, cline: 5 } },
        ]);
        const { series, data, hasOther } = buildAgentCostChart(trend, '其他');
        expect(hasOther).toBe(true);
        // cline 累计 45，未进具名 Top5，应落入「其他」
        expect(series.some((s) => s.key === 'cline')).toBe(false);
        const d1 = data.find((x) => x.label === 'd1');
        const d1Total = Object.values(d1.values).reduce((a, b) => a + b, 0);
        const d1Expected = 100 + 90 + 80 + 70 + 60 + 50 + 40;
        expect(d1Total).toBeCloseTo(d1Expected, 6);
        // 「其他」当天 = 所有未具名 agent 之和 = a5(50) + cline(40)
        expect(d1.values[OTHER_SERIES_KEY]).toBeCloseTo(90, 6);
    });

    it('空趋势返回空结构', () => {
        expect(buildAgentCostChart([])).toEqual({ series: [], data: [], hasOther: false });
        expect(buildAgentCostChart(trendOf([{ day: 'd1', agents: {} }])).series).toEqual([]);
    });
});
