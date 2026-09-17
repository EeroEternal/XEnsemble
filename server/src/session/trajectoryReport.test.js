const { test } = require('node:test');
const assert = require('node:assert/strict');

// analyzeClient 在模块加载时只读 env，测试前清掉 key，generateAdvice 走未配置分支
process.env.LLM_ANALYZE_API_KEY = '';

const trajectoryReport = require('./trajectoryReport');

// --- fixture 构造：符合真实录制形态的 trajectory.getAllSteps 输出 ---
// 每步 request.messages = 全量历史（含本步用户输入），response = 新的
// assistant 回复；工具结果由下一条请求以 tool_result 消息回带。提取器从
// 历史里的 assistant 消息取轮次，并对重发的 response 副本去重。

const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const textBlock = (text) => ({ type: 'text', text });

/** snap：一行 snapshot 轨迹（全量 messages + 归一化 response） */
function snap(seq, ts, messages, response, extra = {}) {
    return {
        seq, ts,
        agentId: 'test-agent', model: 'test-model',
        snapshot: true, msgCount: messages.length,
        request: { snapshot: true, messages, params: {} },
        response,
        status: 'ok',
        latencyMs: 100,
        error: null,
        ...extra,
    };
}

/**
 * session：按真实形态构建 N 轮会话。
 * @param {Array<{text: string, tools?: Array, extra?: object}>} userTurns
 */
function session(userTurns) {
    const messages = [];
    const steps = [];
    userTurns.forEach((ut, idx) => {
        messages.push({ role: 'user', content: ut.text });
        const content = [textBlock('ok'), ...(ut.tools || [])];
        steps.push(snap(idx + 1, (idx + 1) * 1000, messages.slice(),
            { format: 'anthropic', content, finish_reason: 'tool_use' }, ut.extra));
        messages.push({ role: 'assistant', content });
        if ((ut.tools || []).length) {
            messages.push({
                role: 'user',
                content: ut.tools.map((t) => ({ type: 'tool_result', tool_use_id: t.id, content: 'done' })),
            });
        }
    });
    return steps;
}

test('analyzeTrajectory returns clean metrics for a simple session, no issues', () => {
    const steps = session([
        { text: '帮我看看这个项目结构', tools: [toolUse('t1', 'Read', { path: 'a.js' })] },
        { text: '谢谢' },
    ]);
    const r = trajectoryReport.analyzeTrajectory(steps);
    assert.equal(r.metrics.turnCount, 4); // user1, assistant1(+tool), user2, assistant2(final)
    assert.equal(r.metrics.userTurnCount, 2);
    assert.equal(r.metrics.toolCallCount, 1);
    assert.equal(r.metrics.corrections, 0);
    assert.deepEqual(r.issues, []);
    assert.ok(Array.isArray(r.turns) && r.turns.length > 0);
});

test('loop_detected fires at >=3 identical consecutive tool calls', () => {
    const mk = (id) => toolUse(id, 'Bash', { command: 'npm test' });
    const steps = session([
        { text: 'run tests', tools: [mk('t1')] },
        { text: 'continue', tools: [mk('t2')] },
        { text: 'again', tools: [mk('t3')] },
    ]);
    const r = trajectoryReport.analyzeTrajectory(steps);
    const loop = r.issues.find((i) => i.code === 'loop_detected');
    assert.ok(loop, 'expected loop_detected issue');
    assert.equal(loop.severity, 'critical');
    assert.equal(loop.count, 3);
    assert.ok(Number.isFinite(loop.evidence[0].seq));
});

test('loop_detected does not fire for 2 repeats or differing args', () => {
    const steps = session([
        { text: 'run', tools: [toolUse('t1', 'Bash', { command: 'npm test' })] },
        { text: 'again', tools: [toolUse('t2', 'Bash', { command: 'npm test' })] },
        { text: 'build now', tools: [toolUse('t3', 'Bash', { command: 'npm run build' })] },
    ]);
    const r = trajectoryReport.analyzeTrajectory(steps);
    assert.ok(!r.issues.some((i) => i.code === 'loop_detected'));
});

test('file_rework fires when same path written >=3 times', () => {
    const steps = session([
        { text: '改配置', tools: [toolUse('t1', 'Edit', { path: 'config.js' })] },
        { text: '再改', tools: [toolUse('t2', 'Write', { path: 'config.js' })] },
        { text: '还改', tools: [toolUse('t3', 'Edit', { file_path: 'config.js' })] },
        { text: '改别的', tools: [toolUse('t4', 'Edit', { path: 'other.js' })] },
    ]);
    const r = trajectoryReport.analyzeTrajectory(steps);
    const rework = r.issues.find((i) => i.code === 'file_rework');
    assert.ok(rework, 'expected file_rework issue');
    assert.equal(rework.count, 3);
    assert.ok(rework.evidence[0].excerpt.includes('config.js'));
});

test('file_rework ignores read-only tools', () => {
    const steps = session([
        { text: '看看', tools: [toolUse('t1', 'Read', { path: 'a.js' })] },
        { text: '再看看', tools: [toolUse('t2', 'Read', { path: 'a.js' })] },
        { text: '搜一下', tools: [toolUse('t3', 'Grep', { path: 'a.js' })] },
    ]);
    const r = trajectoryReport.analyzeTrajectory(steps);
    assert.ok(!r.issues.some((i) => i.code === 'file_rework'));
});

test('high_corrections fires on dense correction turns (reuses skillScorer lexicon)', () => {
    const steps = session([
        { text: '修复登录 bug', tools: [toolUse('t1', 'Edit', { path: 'auth.js' })] },
        { text: '不对，应该用 bcrypt', tools: [toolUse('t2', 'Edit', { path: 'auth.js' })] },
        { text: '还是不行，重新来', tools: [toolUse('t3', 'Edit', { path: 'auth.js' })] },
    ]);
    const r = trajectoryReport.analyzeTrajectory(steps);
    const corr = r.issues.find((i) => i.code === 'high_corrections');
    assert.ok(corr, 'expected high_corrections issue');
    assert.equal(r.metrics.corrections, 2);
});

test('high_corrections stays silent when corrections are sparse', () => {
    const turns = [];
    for (let i = 0; i < 10; i += 1) {
        turns.push({ text: i === 0 ? '不对，改一下这个' : `正常第 ${i} 条需求描述，内容足够长不像纠正`, tools: [toolUse(`t${i}`, 'Read', { path: 'a.js' })] });
    }
    const r = trajectoryReport.analyzeTrajectory(session(turns));
    assert.ok(!r.issues.some((i) => i.code === 'high_corrections'));
});

test('frequent_compaction fires at >=3 snapshot rows beyond the first', () => {
    const steps = [
        snap(1, 1000, [{ role: 'user', content: '任务A' }], { content: [textBlock('done')] }),
        snap(2, 2000, [{ role: 'user', content: '任务B' }], { content: [textBlock('done')] }),
        snap(3, 3000, [{ role: 'user', content: '任务C' }], { content: [] }),
        snap(4, 4000, [{ role: 'user', content: '任务D' }], { content: [] }),
        snap(5, 5000, [{ role: 'user', content: '任务E' }], { content: [] }),
    ];
    const r = trajectoryReport.analyzeTrajectory(steps);
    const comp = r.issues.find((i) => i.code === 'frequent_compaction');
    assert.ok(comp, 'expected frequent_compaction issue');
    assert.equal(comp.count, 5); // 全部行都是 snapshot
});

test('call_errors clusters by error prefix', () => {
    const steps = [
        session([{ text: '跑一下', tools: [toolUse('t1', 'Bash', { command: 'x' })] }])[0],
        snap(2, 2000, [{ role: 'user', content: '再跑' }], { content: [] }, { status: 'error', error: '429 rate limited' }),
        snap(3, 3000, [{ role: 'user', content: '继续' }], { content: [] }, { status: 'error', error: '429 rate limited' }),
    ];
    const r = trajectoryReport.analyzeTrajectory(steps);
    const err = r.issues.find((i) => i.code === 'call_errors');
    assert.ok(err, 'expected call_errors issue');
    assert.equal(err.count, 2);
    assert.ok(err.evidence[0].excerpt.includes('429'));
});

test('abnormal_exit fires for nonzero exitCode and for user stop', () => {
    const steps = session([{ text: 'hi' }]);
    const r1 = trajectoryReport.analyzeTrajectory(steps, { exitCode: 1 });
    assert.ok(r1.issues.some((i) => i.code === 'abnormal_exit'));
    const r2 = trajectoryReport.analyzeTrajectory(steps, { stopped: true });
    assert.ok(r2.issues.some((i) => i.code === 'abnormal_exit'));
    const r3 = trajectoryReport.analyzeTrajectory(steps, { exitCode: 0 });
    assert.ok(!r3.issues.some((i) => i.code === 'abnormal_exit'));
});

test('empty trajectory yields empty result', () => {
    const r = trajectoryReport.analyzeTrajectory([]);
    assert.equal(r.metrics.turnCount, 0);
    assert.deepEqual(r.issues, []);
    assert.deepEqual(r.turns, []);
});

test('toolSignature normalizes key order', () => {
    assert.equal(
        trajectoryReport.toolSignature('Edit', '{"path":"a.js","content":"x"}'),
        trajectoryReport.toolSignature('Edit', '{"content":"x","path":"a.js"}'),
    );
    assert.notEqual(
        trajectoryReport.toolSignature('Edit', '{"path":"a.js"}'),
        trajectoryReport.toolSignature('Edit', '{"path":"b.js"}'),
    );
});

// --- LLM 建议层（不 mock analyzeClient：未配置分支真实走通） ---

test('generateAdvice throws llm_not_configured without API key', async () => {
    await assert.rejects(
        () => trajectoryReport.generateAdvice([], []),
        (err) => err.code === 'llm_not_configured',
    );
});

test('validateAdvice drops suggestions without a real "before" quote and caps at 3', () => {
    const advice = trajectoryReport.validateAdvice({
        overall: 'ok-ish',
        promptSuggestions: [
            { title: 'a', problem: 'p', before: '用户原话', after: '改写' },
            { title: 'b', problem: 'p', before: '', after: '无引用丢弃' },
            { title: 'c', problem: 'p', before: '原话2', after: '改写2' },
            { title: 'd', problem: 'p', before: '原话3', after: '改写3' },
            { title: 'e', problem: 'p', before: '原话4', after: '改写4' },
        ],
        agentNotes: [' note '],
    });
    assert.equal(advice.promptSuggestions.length, 3);
    assert.equal(advice.promptSuggestions[0].title, 'a');
    assert.equal(advice.agentNotes[0], 'note');
    assert.ok(!advice.promptSuggestions.some((s) => s.title === 'b'));
});

test('validateAdvice returns null for empty/invalid payloads', () => {
    assert.equal(trajectoryReport.validateAdvice(null), null);
    assert.equal(trajectoryReport.validateAdvice({}), null);
    assert.equal(trajectoryReport.validateAdvice({ promptSuggestions: 'nope', agentNotes: 42 }), null);
});

test('buildAdvicePrompt truncates flow to char budget and embeds issues JSON', () => {
    const turns = [];
    for (let i = 0; i < 200; i += 1) turns.push({ role: 'user', ts: i, text: 'x'.repeat(600) });
    const prompt = trajectoryReport.buildAdvicePrompt(turns, [{ code: 'loop_detected', severity: 'critical', count: 3, evidence: [] }]);
    assert.ok(prompt.length < 6000);
    assert.ok(prompt.includes('loop_detected'));
});
