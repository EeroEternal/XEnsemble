const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateCron, nextRun, describeCron, nextRunForTask, describeSchedule } = require('./cron');

test('validateCron accepts valid 5-field expressions', () => {
    assert.equal(validateCron('0 9 * * *'), '0 9 * * *');
    assert.equal(validateCron('*/5 * * * *'), '*/5 * * * *');
    assert.equal(validateCron('0 9 * * 1-5'), '0 9 * * 1-5');
});

test('validateCron rejects invalid expressions with loop_cron_invalid code', () => {
    assert.throws(() => validateCron(''), (e) => e.code === 'loop_cron_invalid');
    assert.throws(() => validateCron('not a cron'), (e) => e.code === 'loop_cron_invalid');
    assert.throws(() => validateCron('61 * * * *'), (e) => e.code === 'loop_cron_invalid');
});

test('nextRun returns the next matching time in the given timezone', () => {
    // 2026-09-10 10:00 UTC+8 之后，每天 09:00 (UTC+8) 的下一次是次日 09:00
    const after = Date.UTC(2026, 8, 10, 2, 0, 0); // 10:00 UTC+8
    const next = nextRun('0 9 * * *', 'Asia/Shanghai', new Date(after));
    assert.ok(next > after);
    // 下一刻钟应落在 09:00 UTC+8 = 01:00 UTC
    const d = new Date(next);
    assert.equal(d.getUTCHours(), 1);
    assert.equal(d.getUTCMinutes(), 0);
});

test('nextRun honors hourly expression', () => {
    const after = new Date('2026-09-10T03:07:00Z');
    const next = nextRun('0 * * * *', 'UTC', after);
    const d = new Date(next);
    assert.equal(d.getUTCHours(), 4);
    assert.equal(d.getUTCMinutes(), 0);
    assert.equal(d.getUTCSeconds(), 0);
});

test('nextRun throws on invalid expression', () => {
    assert.throws(() => nextRun('bad', 'UTC'));
});

test('describeCron renders common schedules crontab.guru style', () => {
    assert.equal(describeCron('0 9 * * *'), 'At 09:00.');
    assert.equal(describeCron('*/5 * * * *'), 'Every 5 minutes.');
    assert.equal(describeCron('0 * * * *'), 'At minute 0.');
    assert.equal(describeCron('0 9 * * 1-5'), 'At 09:00, Monday through Friday.');
    assert.equal(describeCron('0 10 * * 1'), 'At 10:00, on Monday.');
    assert.equal(describeCron('0 9 * * 1,3,5'), 'At 09:00, on Monday, Wednesday, Friday.');
    assert.equal(describeCron('30 8 1 * *'), 'At 08:30, on day-of-month 1.');
    assert.equal(describeCron('0 9 1 1 *'), 'At 09:00, on day-of-month 1, in January.');
    assert.equal(describeCron('0 0,12 * * *'), 'At minute 0 past 00:00, 12:00.');
    assert.equal(describeCron('10 9-18 * * *'), 'At minute 10 past 09:00 through 18:00.');
    assert.equal(describeCron('* * * * *'), 'Every minute.');
    assert.equal(describeCron('@daily'), 'At 00:00.');
    assert.equal(describeCron('@weekly'), 'At 00:00, on Sunday.');
});

test('describeCron returns null for unsupported structures, throws on invalid', () => {
    assert.equal(describeCron('0 9 * JAN *'), null); // 月份名称不支持描述
    assert.equal(describeCron('0 9 1-10/2 * *'), null); // dom 步进
    assert.throws(() => describeCron('not a cron'), (e) => e.code === 'loop_cron_invalid');
});

test('nextRunForTask supports all three schedule kinds', () => {
    const after = new Date('2026-09-10T03:07:00Z');
    // cron
    const cronNext = nextRunForTask({ scheduleKind: 'cron', cronExpr: '0 * * * *', timezone: 'UTC' }, after);
    assert.equal(new Date(cronNext).getUTCHours(), 4);
    // every
    assert.equal(nextRunForTask({ scheduleKind: 'every', intervalMs: 600_000 }, after), after.getTime() + 600_000);
    // at（固定目标时间）
    assert.equal(nextRunForTask({ scheduleKind: 'at', nextRunAt: 1234567890 }), 1234567890);
    // 默认 kind（存量数据无 schedule_kind）按 cron 处理
    assert.equal(nextRunForTask({ cronExpr: '0 * * * *', timezone: 'UTC' }, after), cronNext);
    // every 非法 interval → loop_interval_invalid
    assert.throws(() => nextRunForTask({ scheduleKind: 'every', intervalMs: 0 }), (e) => e.code === 'loop_interval_invalid');
});

test('describeSchedule handles every and at kinds', () => {
    assert.equal(describeSchedule({ scheduleKind: 'every', intervalMs: 30 * 60_000 }), 'Every 30 minutes.');
    assert.equal(describeSchedule({ scheduleKind: 'every', intervalMs: 2 * 3_600_000 }), 'Every 2 hours.');
    assert.equal(describeSchedule({ scheduleKind: 'every', intervalMs: 3 * 86_400_000 }), 'Every 3 days.');
    assert.equal(describeSchedule({ scheduleKind: 'every', intervalMs: 90 * 60_000 }), 'Every 90 minutes.');
    const atDesc = describeSchedule({ scheduleKind: 'at', nextRunAt: Date.UTC(2026, 8, 11, 1, 0), timezone: 'UTC' });
    assert.match(atDesc, /^Once, at .+/);
    // cron 类型走 describeCron
    assert.equal(describeSchedule({ scheduleKind: 'cron', cronExpr: '0 9 * * *' }), 'At 09:00.');
    assert.throws(() => describeSchedule({ scheduleKind: 'cron', cronExpr: 'bad' }), (e) => e.code === 'loop_cron_invalid');
});

test('describeSchedule localizes to zh', () => {
    // every / at
    assert.equal(describeSchedule({ scheduleKind: 'every', intervalMs: 30 * 60_000 }, 'zh'), '每 30 分钟执行。');
    assert.equal(describeSchedule({ scheduleKind: 'every', intervalMs: 2 * 3_600_000 }, 'zh'), '每 2 小时执行。');
    assert.equal(describeSchedule({ scheduleKind: 'every', intervalMs: 3 * 86_400_000 }, 'zh'), '每 3 天执行。');
    const atZh = describeSchedule({ scheduleKind: 'at', nextRunAt: Date.UTC(2026, 8, 11, 1, 0), timezone: 'UTC' }, 'zh');
    assert.match(atZh, /^单次，于 .+ 执行。$/);
    // cron 常见模式
    assert.equal(describeCron('0 9 * * *', 'zh'), '每天 09:00 执行。');
    assert.equal(describeCron('*/5 * * * *', 'zh'), '每 5 分钟 执行。');
    assert.equal(describeCron('0 * * * *', 'zh'), '每小时第 0 分钟 执行。');
    assert.equal(describeCron('0 9 * * 1-5', 'zh'), '周一至周五 09:00 执行。');
    assert.equal(describeCron('0 10 * * 1', 'zh'), '每周一 10:00 执行。');
    assert.equal(describeCron('0 9 * * 1,3,5', 'zh'), '每周一、三、五 09:00 执行。');
    assert.equal(describeCron('30 8 1 * *', 'zh'), '每月 1 日 08:30 执行。');
    assert.equal(describeCron('0 9 1 1 *', 'zh'), '每年 1 月 1 日 09:00 执行。');
    assert.equal(describeCron('0 9 * 9 *', 'zh'), '每年 9 月 每天 09:00 执行。');
    assert.equal(describeCron('@daily', 'zh'), '每天 00:00 执行。');
    // zh 不支持的罕见结构 → null（前端隐藏描述行）
    assert.equal(describeCron('0 9 * JAN *', 'zh'), null);
});
