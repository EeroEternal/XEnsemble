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

test('completed: 期间有 PTY 输出 → 不算安静完成', isolated(async (notifications) => {
    attentionService.observeChatEntry('s7', { role: 'assistant', content: '开始' });
    attentionService.observeOutput('s7', 'local:pty:s7');
    await tick(110);
    assert.equal(notifications.length, 0);
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

test("L3': L1 来源的等待不被屏幕扫描解除（生命周期归 L1）", isolated(async (notifications) => {
    attentionService.observeChatEntry('s11', { role: 'tool_call', tool: 'AskUserQuestion', content: QUESTION_ARGS });
    await tick();
    await attentionService.evaluateLines('s11', ['some other output']);
    await attentionService.evaluateLines('s11', ['more output']);
    assert.equal(attentionService.getState('s11').state, 'waiting_user');
    assert.equal(attentionService.getState('s11').source, 'L1');
}));
