/**
 * attentionService 单测（node:test）。
 * 注入 notifier / 上下文解析 / 尾部行读取，验证 L1 / L3' 状态机与通知发射；
 * 计时窗口通过 __configure 调小（不等待真实 20s）。
 */
const test = require('node:test');
const assert = require('node:assert');

const attentionService = require('./attentionService');

// 预热 shared ESM 动态导入（首个用例前完成编译，避免与 40ms 计时窗口竞态）。
test.before(async () => {
    const path = require('path');
    const { pathToFileURL } = require('url');
    await import(pathToFileURL(path.resolve(__dirname, '../../../shared/terminalPromptHeuristics.mjs')).href);
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** 每个用例独立状态 + 注入依赖；t.after 恢复。 */
function isolated(fn) {
    return async (t) => {
        const notifications = [];
        attentionService.__reset();
        const restore = attentionService.__configure({
            config: {
                quietCompletedMs: 40,
                completedRepeatMs: 60000,
                promptStableScans: 2,
                scanThrottleMs: 10,
            },
            deps: {
                notifier: async (evt) => { notifications.push(evt); },
                getSessionContext: async () => ({
                    userId: 'user_1',
                    agentName: 'Kimi Code',
                    sessionTitle: 'Fix login bug',
                    projectName: 'web',
                }),
                readTailLines: async () => [],
            },
        });
        t.after(restore);
        await fn(notifications);
    };
}

const QUESTION_ARGS = JSON.stringify({
    questions: [{ question: 'Which database?', header: 'DB', options: [{ label: 'PG' }, { label: 'MySQL' }] }],
});

test('L1: 问题型 tool_call → waiting_user(L1) + session_waiting 通知', isolated(async (notifications) => {
    attentionService.observeChatEntry('s1', { role: 'tool_call', tool: 'AskUserQuestion', content: QUESTION_ARGS });
    await tick();
    const st = attentionService.getState('s1');
    assert.equal(st.state, 'waiting_user');
    assert.equal(st.source, 'L1');
    assert.ok(st.reason.includes('Which database?'));
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, 'session_waiting');
    assert.equal(notifications[0].userId, 'user_1');
    assert.equal(notifications[0].payload.sessionId, 's1');
    assert.equal(notifications[0].payload.agentName, 'Kimi Code');
}));

test('L1: 普通 tool_call 不触发等待', isolated(async (notifications) => {
    attentionService.observeChatEntry('s2', { role: 'tool_call', tool: 'Bash', content: '{"command":"ls"}' });
    await tick();
    assert.equal(attentionService.getState('s2').state, 'working');
    assert.equal(notifications.length, 0);
}));

test('L1: user 消息清除等待，且不重复通知', isolated(async (notifications) => {
    attentionService.observeChatEntry('s3', { role: 'tool_call', tool: 'ask_followup_question', content: '{"question":"继续吗?"}' });
    await tick();
    assert.equal(attentionService.getState('s3').state, 'waiting_user');
    attentionService.observeChatEntry('s3', { role: 'user', content: '继续' });
    await tick();
    assert.equal(attentionService.getState('s3').state, 'working');
    assert.equal(notifications.length, 1, '清除等待不产生新通知');
}));

test('L1: tool_result（用户回答送达）清除等待', isolated(async (notifications) => {
    attentionService.observeChatEntry('s4', { role: 'tool_call', tool: 'AskUserQuestion', content: QUESTION_ARGS });
    await tick();
    attentionService.observeChatEntry('s4', { role: 'tool_result', callId: 'c1', content: 'PG' });
    await tick();
    assert.equal(attentionService.getState('s4').state, 'working');
    assert.equal(notifications.length, 1);
}));

test('L1: 等待中重复问题工具只刷新 reason，不重复通知', isolated(async (notifications) => {
    attentionService.observeChatEntry('s5', { role: 'tool_call', tool: 'AskUserQuestion', content: QUESTION_ARGS });
    await tick();
    attentionService.observeChatEntry('s5', { role: 'tool_call', tool: 'AskUserQuestion', content: '{"questions":[{"question":"换个问题?"}]}' });
    await tick();
    assert.equal(attentionService.getState('s5').state, 'waiting_user');
    assert.equal(notifications.length, 1);
    assert.ok(attentionService.getState('s5').reason.includes('换个问题'));
}));

test('completed: assistant 后静默 → 一次 session_completed；repeat 窗口内不重复', isolated(async (notifications) => {
    attentionService.observeChatEntry('s6', { role: 'user', content: '干活' });
    attentionService.observeChatEntry('s6', { role: 'assistant', content: '干完了' });
    await tick(110);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, 'session_completed');
    assert.equal(notifications[0].payload.sessionId, 's6');
    assert.equal(notifications[0].payload.reason, null);

    // repeat 窗口（60s）内的下一段完成不再通知
    attentionService.observeChatEntry('s6', { role: 'assistant', content: '又干了一轮' });
    await tick(110);
    assert.equal(notifications.length, 1);
}));

test('completed: PTY 输出把静默期重新计时，停止后仍收口（不再永久丢失）', isolated(async (notifications) => {
    // 旧实现只在 assistant 时排期一次，observeOutput 把计时器清掉后不再重排
    // → TUI 收尾阶段的状态栏计时器/光标闪烁（实测 0~200ms 一帧）会让
    // session_completed 永久丢失，用户侧表现为「任务跑完没通知」。
    attentionService.observeChatEntry('s7', { role: 'assistant', content: '开始' });
    // 持续输出（间隔 < quietCompletedMs=40）→ 期间不算安静完成
    for (let i = 0; i < 4; i++) {
        await tick(20);
        attentionService.observeOutput('s7', 'local:pty:s7');
    }
    assert.equal(notifications.length, 0, '输出滚动期间不应发 completed');
    // 输出停止 → 静默期满后应正常收口（旧实现在此处永久丢失）
    await tick(110);
    assert.equal(notifications.length, 1, '输出停止后应发出 completed');
    assert.equal(notifications[0].type, 'session_completed');
}));

test('completed: 等待用户输入时挂起（不发 completed）', isolated(async (notifications) => {
    // 先经问题工具进入等待（预热导入）→ assistant 再回到工作 → 再次提问：
    // 第二次提问会清掉 completed 计时器并再次进入等待。
    attentionService.observeChatEntry('s8', { role: 'tool_call', tool: 'AskUserQuestion', content: QUESTION_ARGS });
    await tick();
    attentionService.observeChatEntry('s8', { role: 'assistant', content: '先问一下' });
    attentionService.observeChatEntry('s8', { role: 'tool_call', tool: 'AskUserQuestion', content: QUESTION_ARGS });
    await tick(110);
    const kinds = notifications.map((n) => n.type);
    assert.ok(!kinds.includes('session_completed'), '等待输入不应发 completed');
    assert.ok(kinds.includes('session_waiting'));
}));

test("L3': 连续两轮扫到 prompt → waiting(L3)；prompt 消失解除", isolated(async (notifications) => {
    const promptLines = ['Do you want to proceed?', '1. Yes', '2. No', '❯'];
    await attentionService.evaluateLines('s9', promptLines);
    assert.equal(attentionService.getState('s9').state, 'working', '单轮命中只是累积');
    await attentionService.evaluateLines('s9', promptLines);
    await tick(); // 通知发射是异步 void,等 flush
    const st = attentionService.getState('s9');
    assert.equal(st.state, 'waiting_user');
    assert.equal(st.source, 'L3');
    assert.ok(st.reason.includes('Do you want to proceed?'));
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, 'session_waiting');

    // prompt 消失（用户已回答）→ 解除，无新通知
    await attentionService.evaluateLines('s9', ['build ok', 'exit 0']);
    assert.equal(attentionService.getState('s9').state, 'working');
    assert.equal(notifications.length, 1);
}));

test("L3': 无问句上下文的屏幕内容不误报", isolated(async (notifications) => {
    await attentionService.evaluateLines('s10', ['$ npm run dev', 'ready on :5173', 'Press Enter to submit to GitHub']);
    await attentionService.evaluateLines('s10', ['$ npm run dev', 'ready on :5173', 'Press Enter to submit to GitHub']);
    assert.equal(attentionService.getState('s10').state, 'working');
    assert.equal(notifications.length, 0);
}));

test("L3': 提示本体冻结才累计命中并通知（与 PTY 是否滚动无关）", isolated(async (notifications) => {
    // 稳定判据是「提示内容冻结」而非「PTY 静默」：等待确认的 TUI（codebuddy
    // 的 "waiting for permission"）会持续重绘 spinner，PTY 永不静默，用静默
    // 当代理信号会彻底漏报。这里断言 spinner 每轮都在变、但提示本体不变时，
    // 仍然能凑满稳定窗口并通知。
    const volatile = (n) => [
        `✹ Chilling… (${n}s · waiting for permission · ↓ ${n * 37} tokens)`,
        'Do you want to proceed?',
        ' > 1. Yes',
        '   2. No',
    ];
    let round = 0;
    const restore = attentionService.__configure({
        deps: { readTailLines: async () => volatile(round++) },
    });
    try {
        // 每轮都伴随 PTY 输出（lastActivityAt 持续刷新，永不静默）。
        attentionService.observeOutput('s12', 'local:pty:s12');
        await tick(20);
        attentionService.observeOutput('s12', 'local:pty:s12');
        await tick(20);
        attentionService.observeOutput('s12', 'local:pty:s12');
        await tick(20);
        await tick(); // 通知发射是异步 void,等 flush
        const st = attentionService.getState('s12');
        assert.equal(st.state, 'waiting_user', '提示冻结即应判等待（不依赖静默）');
        assert.equal(st.source, 'L3');
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].type, 'session_waiting');
    } finally {
        restore();
    }
}));

test("L3': 流式正文（提示本体每轮都在变）不累计命中、不通知", isolated(async (notifications) => {
    // 正文滚动时每轮内容都在增长：稳定键每次不同 → 计数反复重置 → 不通知。
    // 这是移除「静默门槛」后必须守住的防误报行为。
    let round = 0;
    const streaming = () => [
        '● 已完成修改，可以继续优化：',
        `  1. 增加测试覆盖${'，补充边界用例'.repeat(round++ % 3)}`,
        `  2. 补充文档说明${'，包含示例'.repeat(round % 2)}`,
        '  3. 性能优化',
    ];
    const restore = attentionService.__configure({
        deps: { readTailLines: async () => streaming() },
    });
    try {
        for (let i = 0; i < 5; i++) {
            attentionService.observeOutput('s13', 'local:pty:s13');
            await tick(20);
        }
        await tick();
        const st = attentionService.getState('s13');
        assert.notEqual(st.state, 'waiting_user', '流式正文不应判等待');
        assert.equal(notifications.length, 0);
    } finally {
        restore();
    }
}));

test("L3': codebuddy 权限确认（spinner 持续重绘）能被识别并通知", isolated(async (notifications) => {
    // 真实转录（boxlite_rt_d2eb3bf3275c）中 codebuddy 等待权限时的屏幕形态：
    // 状态栏 spinner 以 ~201ms 节奏刷新（PTY 永不静默 4s），提示本体冻结。
    // 修复前 scanQuietMs 门槛使扫描永不执行 → 连续多次确认都收不到通知。
    const screen = [
        '✹ Chilling… (0s · waiting for permission)',
        ' Do you want to make this edit to AppSidebar.jsx?',
        '',
        ' > 1. Yes',
        "   2. Yes, and don't ask again this session (shift + tab)",
        '   3. No, and tell CodeBuddy what to do differently (escape)',
    ];
    const restore = attentionService.__configure({
        deps: { readTailLines: async () => screen },
    });
    try {
        for (let i = 0; i < 3; i++) {
            attentionService.observeOutput('s14', 'local:pty:s14');
            await tick(20);
        }
        await tick();
        const st = attentionService.getState('s14');
        assert.equal(st.state, 'waiting_user');
        assert.equal(st.source, 'L3');
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].type, 'session_waiting');
    } finally {
        restore();
    }
}));

test("L3': 提示框上方滚动日志变化不影响稳定键（codebuddy 场景）", isolated(async (notifications) => {
    // 真实转录（boxlite_rt_d2eb3bf3275c）中 codebuddy 的提示框上方持续打印
    // 工具日志（Read/Bash 行、spinner）。若把整个快照纳入稳定键，则每轮 key
    // 都不同、stableHits 永远停在 1，等待通知永不触发（实测 18/18 轮 key 变化）。
    // 这里断言：只有「问题行+选项行」参与 key，上方滚动内容变化不影响累积。
    let round = 0;
    const screen = () => [
        `✸ Repairing… (${round}s · waiting for model · ↑ ${round * 40} tokens)`,
        // 上方滚动日志：每轮都不同（模拟工具输出持续滚动）
        `● Bash(cd /workspace && grep -n "max\\b" web/src/components/usage/MiniBarChart.jsx | head -${round++})`,
        '  └ Found 3 files (ctrl+o to expand)',
        '─────────────────────────────────────────────',
        ' Do you want to proceed?',
        ' > 1. Yes',
        "   2. Yes, and don't ask again for session (shift + tab)",
        '   3. No, and tell CodeBuddy what to do differently (escape)',
    ];
    const restore = attentionService.__configure({
        deps: { readTailLines: async () => screen() },
    });
    try {
        for (let i = 0; i < 3; i++) {
            attentionService.observeOutput('s15', 'local:pty:s15');
            await tick(20);
        }
        await tick();
        const st = attentionService.getState('s15');
        assert.equal(st.state, 'waiting_user', '滚动日志变化不应阻止等待判定');
        assert.equal(st.source, 'L3');
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].type, 'session_waiting');
    } finally {
        restore();
    }
}));

test("L3': L1 来源的等待不被屏幕扫描解除（生命周期归 L1）", isolated(async (notifications) => {
    attentionService.observeChatEntry('s11', { role: 'tool_call', tool: 'AskUserQuestion', content: QUESTION_ARGS });
    await tick();
    await attentionService.evaluateLines('s11', ['some other output']);
    await attentionService.evaluateLines('s11', ['more output']);
    assert.equal(attentionService.getState('s11').state, 'waiting_user');
    assert.equal(attentionService.getState('s11').source, 'L1');
}));

test("L3': GitHub Copilot CLI 权限选择对话框（无问句行）→ waiting + session_waiting 通知", isolated(async (notifications) => {
    // copilot 的工具权限对话框没有问句行，只有 工具名+命令+编号 Yes/No 选项。
    // 回归：detectTuiPrompt 曾对整屏返回 null → copilot 等用户选择时从不通知。
    const copilotPicker = [
      '╭─ shell ──────────────────────────────╮',
      '│ npm run build                        │',
      '│                                      │',
      '│ ❯ 1. Yes                             │',
      "│   2. Yes, and don't ask again for    │",
      '│      similar commands                │',
      '│   3. No, and tell Copilot what to    │',
      '│      do differently (esc)            │',
      '╰──────────────────────────────────────╯',
    ];
    await attentionService.evaluateLines('s13', copilotPicker);
    assert.equal(attentionService.getState('s13').state, 'working', '单轮命中只是累积');
    await attentionService.evaluateLines('s13', copilotPicker);
    await tick(); // 通知发射是异步 void,等 flush
    const st = attentionService.getState('s13');
    assert.equal(st.state, 'waiting_user');
    assert.equal(st.source, 'L3');
    assert.ok(st.reason.includes('Yes'), 'reason 快照应含选项行');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, 'session_waiting');
    assert.equal(notifications[0].payload.sessionId, 's13');

    // 用户做出选择（对话框消失）→ 解除等待，无新通知
    await attentionService.evaluateLines('s13', ['output continues']);
    assert.equal(attentionService.getState('s13').state, 'working');
    assert.equal(notifications.length, 1);
}));
