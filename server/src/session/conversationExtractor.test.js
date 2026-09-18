const { test } = require('node:test');
const assert = require('node:assert/strict');
const extractor = require('./conversationExtractor');

function fakeTranscriptStore(frames) {
    return {
        readFrom: (streamRef, afterSeq = 0) =>
            frames.filter((f) => f.seq > (Number(afterSeq) || 0)),
    };
}

test('extractFromTranscript splits turns on in frames and aggregates out frames', () => {
    const store = fakeTranscriptStore([
        { seq: 1, ts: 1000, kind: 'in', data: 'fix the login bug\n' },
        { seq: 2, ts: 1500, kind: 'out', data: 'Looking at auth.js\n' },
        { seq: 3, ts: 1600, kind: 'out', data: 'Found the issue\n' },
        { seq: 4, ts: 5000, kind: 'in', data: 'what was it?\n' },
        { seq: 5, ts: 5500, kind: 'out', data: 'A missing await\n' },
    ]);
    const { source, turns } = extractor.extractFromTranscript(store, 's1');
    assert.equal(source, 'transcript');
    assert.equal(turns.length, 4);
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[0].text, 'fix the login bug');
    assert.equal(turns[1].role, 'assistant');
    assert.equal(turns[1].text, 'Looking at auth.js\nFound the issue');
    assert.deepEqual(turns[1].tools, []);
    assert.equal(turns[2].text, 'what was it?');
    assert.equal(turns[3].text, 'A missing await');
});

test('extractFromTranscript aggregates assistant output on 2s gap', () => {
    const store = fakeTranscriptStore([
        { seq: 1, ts: 1000, kind: 'in', data: 'go\n' },
        { seq: 2, ts: 1100, kind: 'out', data: 'part one\n' },
        // gap > 2s → new assistant turn
        { seq: 3, ts: 4200, kind: 'out', data: 'part two\n' },
    ]);
    const { turns } = extractor.extractFromTranscript(store, 's1');
    assert.equal(turns.length, 3);
    assert.equal(turns[1].text, 'part one');
    assert.equal(turns[2].text, 'part two');
});

test('extractFromTranscript strips ANSI and collapses redraw lines', () => {
    const store = fakeTranscriptStore([
        { seq: 1, ts: 1000, kind: 'in', data: 'run tests\n' },
        { seq: 2, ts: 1100, kind: 'out', data: '\x1b[32mOK\x1b[0m\n' },
        { seq: 3, ts: 1200, kind: 'out', data: 'OK\r\x1b[32mOK\x1b[0m\n' },
        { seq: 4, ts: 1300, kind: 'out', data: 'OK\n' },
    ]);
    const { turns } = extractor.extractFromTranscript(store, 's1');
    const assistant = turns.find((t) => t.role === 'assistant');
    assert.equal(assistant.text, 'OK');
});

test('extractFromTranscript truncates over-long turns', () => {
    const long = 'x'.repeat(20000);
    const store = fakeTranscriptStore([
        { seq: 1, ts: 1000, kind: 'in', data: long },
    ]);
    const { turns } = extractor.extractFromTranscript(store, 's1');
    assert.equal(turns[0].truncated, true);
    assert.ok(turns[0].text.includes('…(truncated'));
    assert.ok(turns[0].text.length < 20000);
});

test('extractFromTranscript respects afterSeq cursor', () => {
    const store = fakeTranscriptStore([
        { seq: 1, ts: 1000, kind: 'in', data: 'first' },
        { seq: 2, ts: 2000, kind: 'in', data: 'second' },
    ]);
    const { turns } = extractor.extractFromTranscript(store, 's1', 1);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, 'second');
});

test('extractFromChat attaches tool_call/tool_result to assistant turn as structured entries', () => {
    const history = [
        { seq: 1, ts: 1000, role: 'user', content: 'fix the login bug' },
        { seq: 2, ts: 1100, role: 'tool_call', callId: 'c1', tool: 'Edit', content: '{"path":"auth.js"}' },
        { seq: 3, ts: 1200, role: 'tool_result', callId: 'c1', tool: 'Edit', content: 'ok' },
        { seq: 4, ts: 1300, role: 'assistant', content: 'Done, edited auth.js' },
    ];
    const { source, turns, headSeq } = extractor.extractFromChat(history);
    assert.equal(source, 'chat');
    assert.equal(headSeq, 4);
    assert.equal(turns.length, 3);
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[0].text, 'fix the login bug');
    assert.equal(turns[1].role, 'assistant');
    assert.equal(turns[1].text, '');
    assert.deepEqual(turns[1].tools, [
        { tool: 'Edit', args: '{"path":"auth.js"}', callId: 'c1', result: 'ok' },
    ]);
    assert.equal(turns[2].text, 'Done, edited auth.js');
});

test('extractFromChat creates a tool-only assistant turn and pairs result by callId', () => {
    const history = [
        { seq: 1, ts: 1000, role: 'user', content: 'go' },
        { seq: 2, ts: 1100, role: 'tool_call', callId: 'a', tool: 'Read', content: '{"filePath":"/workspace"}' },
        { seq: 3, ts: 1200, role: 'tool_call', callId: 'b', tool: 'Bash', content: '{"command":"ls"}' },
        { seq: 4, ts: 1300, role: 'tool_result', callId: 'b', tool: 'Bash', content: 'src/' },
        { seq: 5, ts: 1400, role: 'tool_result', callId: 'a', tool: 'Read', content: '...file...' },
        { seq: 6, ts: 1500, role: 'assistant', content: 'I inspected the workspace' },
    ];
    const { turns } = extractor.extractFromChat(history);
    assert.equal(turns.length, 3);
    const toolTurn = turns[1];
    assert.equal(toolTurn.role, 'assistant');
    assert.equal(toolTurn.text, '');
    assert.equal(toolTurn.tools.length, 2);
    assert.equal(toolTurn.tools[0].tool, 'Read');
    assert.equal(toolTurn.tools[0].result, '...file...');
    assert.equal(toolTurn.tools[1].tool, 'Bash');
    assert.equal(toolTurn.tools[1].result, 'src/');
    // Results pair back even when the result order differs from the call order.
    assert.deepEqual(toolTurn.tools[0].args, '{"filePath":"/workspace"}');
    assert.deepEqual(toolTurn.tools[1].args, '{"command":"ls"}');
});

test('extractFromChat respects afterSeq cursor', () => {
    const history = [
        { seq: 1, ts: 1000, role: 'user', content: 'first' },
        { seq: 2, ts: 2000, role: 'user', content: 'second' },
    ];
    const { turns, headSeq } = extractor.extractFromChat(history, 1);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, 'second');
    // head is computed from the FULL history, so the cursor can advance.
    assert.equal(headSeq, 2);
});

test('extract prefers chat transcript over state dir and transcript', async () => {
    const store = fakeTranscriptStore([
        { seq: 1, ts: 1000, kind: 'in', data: 'from transcript' },
    ]);
    const { source, turns } = await extractor.extract({
        transcriptStore: store,
        streamRef: 's1',
        stateDirRef: '.xensemble/state/s1',
        readStateDir: async () => JSON.stringify({
            type: 'user',
            message: { role: 'user', content: 'from state dir' },
        }),
        readChatHistory: async () => [
            { seq: 1, ts: 1000, role: 'user', content: 'from chat' },
            { seq: 2, ts: 1100, role: 'assistant', content: 'replied' },
        ],
    });
    assert.equal(source, 'chat');
    assert.equal(turns[0].text, 'from chat');
});

// ── trajectory 源（0029）─────────────────────────────────

test('extract prefers trajectory over chat transcript (0029)', async () => {
    const store = fakeTranscriptStore([]);
    const steps = [
        {
            seq: 1, ts: 1000, msgCount: 1, status: 'ok', agentId: 'claude-code', model: 'm',
            request: { snapshot: true, params: {}, messages: [{ role: 'user', content: 'from trajectory' }] },
            response: { format: 'openai', content: [{ type: 'text', text: 'traj reply' }], finish_reason: 'stop', usage: null },
        },
    ];
    const { source, turns } = await extractor.extract({
        transcriptStore: store,
        streamRef: 's1',
        readChatHistory: async () => [
            { seq: 1, ts: 1000, role: 'user', content: 'from chat' },
            { seq: 2, ts: 1100, role: 'assistant', content: 'replied' },
        ],
        readTrajectorySteps: async () => steps,
    });
    assert.equal(source, 'trajectory');
    assert.equal(turns[0].text, 'from trajectory');
    assert.equal(turns[1].text, 'traj reply');
});

test('extractFromTrajectory pairs openai tool results and dedupes replayed history', () => {
    const steps = [
        {
            seq: 1, ts: 1000, msgCount: 3, status: 'ok',
            request: {
                snapshot: true, params: {},
                messages: [
                    { role: 'user', content: 'run the tests' },
                    { role: 'assistant', content: 'running', tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{"command":"npm test"}' } }] },
                    { role: 'user', content: 'context reminder blob' },
                ],
            },
            response: null,
        },
        {
            seq: 2, ts: 2000, msgCount: 4, status: 'ok',
            request: {
                snapshot: false, params: {},
                messages: [
                    { role: 'tool', tool_call_id: 'c1', content: 'all 10 tests passed' },
                    { role: 'assistant', content: 'green — committing' },
                ],
            },
            response: null,
        },
    ];
    const { source, turns } = extractor.extractFromTrajectory(steps);
    assert.equal(source, 'trajectory');
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[0].text, 'run the tests');
    const asst = turns.find((t) => t.role === 'assistant' && t.text === 'running');
    assert.ok(asst);
    assert.equal(asst.tools.length, 1);
    assert.equal(asst.tools[0].tool, 'bash');
    assert.equal(asst.tools[0].callId, 'c1');
    assert.equal(asst.tools[0].result, 'all 10 tests passed');
    assert.equal(turns.filter((t) => t.text === 'run the tests').length, 1);
    assert.ok(turns.some((t) => t.role === 'assistant' && t.text === 'green — committing'));
});

test('extractFromTrajectory handles anthropic tool_use / tool_result blocks', () => {
    const steps = [
        {
            seq: 1, ts: 1000, msgCount: 2, status: 'ok',
            request: {
                snapshot: true, params: {},
                messages: [
                    { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
                    {
                        role: 'assistant',
                        content: [
                            { type: 'thinking', thinking: 'read first' },
                            { type: 'text', text: 'reading the file' },
                            { type: 'tool_use', id: 't9', name: 'read_file', input: { path: 'a.ts' } },
                        ],
                    },
                ],
            },
            response: null,
        },
        {
            seq: 2, ts: 2000, msgCount: 3, status: 'ok',
            request: {
                snapshot: false, params: {},
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'tool_result', tool_use_id: 't9', content: 'file contents here' },
                        ],
                    },
                ],
            },
            response: null,
        },
    ];
    const { turns } = extractor.extractFromTrajectory(steps);
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[0].text, 'fix it');
    const asst = turns[1];
    assert.equal(asst.role, 'assistant');
    assert.equal(asst.text, 'reading the file');
    assert.equal(asst.tools.length, 1);
    assert.equal(asst.tools[0].tool, 'read_file');
    assert.deepEqual(JSON.parse(asst.tools[0].args), { path: 'a.ts' });
    assert.equal(asst.tools[0].result, 'file contents here');
});

test('extractFromTrajectory keeps real messages when bypass memory deltas interleave', () => {
    // 真实场景：CLI 在轮次间并行发起记忆整理调用（旁路上下文以 delta 落库，
    // 随后主调用因前缀链断裂存为快照）。内容过滤已移除：合成消息原样成轮，
    // 但真实用户消息绝不能因旁路上下文顶乱下标而被跳过丢失。
    const steps = [
        {
            seq: 1, ts: 1000, msgCount: 2, status: 'ok',
            request: {
                snapshot: true, params: {},
                messages: [
                    { role: 'user', content: '你是会总结对话内容吗' },
                    { role: 'assistant', content: 'turn1 answer' },
                ],
            },
            response: null,
        },
        {
            seq: 2, ts: 2000, msgCount: 3, status: 'ok',
            request: {
                snapshot: false, params: {},
                messages: [
                    { role: 'user', content: 'Managed memory has TWO directories. Choose which one to write each memory into...' },
                ],
            },
            response: null,
        },
        {
            // 主调用 N+1：旁路 delta 顶断前缀链 → 存为快照
            seq: 3, ts: 3000, msgCount: 3, status: 'ok',
            request: {
                snapshot: true, params: {},
                messages: [
                    { role: 'user', content: '你是会总结对话内容吗' },
                    { role: 'assistant', content: 'turn1 answer' },
                    { role: 'user', content: '你自己会总结对话内容吗' },
                ],
            },
            response: null,
        },
    ];
    const { turns } = extractor.extractFromTrajectory(steps);
    const texts = turns.filter((t) => t.role === 'user').map((t) => t.text);
    assert.ok(texts.includes('你是会总结对话内容吗'));
    assert.ok(texts.includes('你自己会总结对话内容吗'));
    // 合成消息原样呈现（不再过滤），且真实消息无重复
    assert.ok(texts.some((t) => t.startsWith('Managed memory has')));
    assert.equal(texts.filter((t) => t === '你自己会总结对话内容吗').length, 1);
});

test('extractFromTrajectory never loses real messages around divergent suggestion snapshots', () => {
    // 真实场景：CLI 在轮次间并行发起「输入建议」生成调用，其上下文 = 主历史 +
    // 末尾 [SUGGESTION MODE:] 指令（前缀比对失败 → 存为快照）。不做内容过滤：
    // 合成指令与其响应原样呈现，主链的真实用户消息照常成轮。
    const steps = [
        {
            seq: 1, ts: 1000, msgCount: 2, status: 'ok',
            request: {
                snapshot: true, params: {},
                messages: [
                    { role: 'user', content: '你会总结对话内容吗' },
                    { role: 'assistant', content: '不会主动总结' },
                ],
            },
            response: null,
        },
        {
            // 建议生成调用（并行）：分歧快照 = 主历史 + 末尾合成指令
            seq: 2, ts: 2000, msgCount: 3, status: 'ok',
            request: {
                snapshot: true, params: {},
                messages: [
                    { role: 'user', content: '你会总结对话内容吗' },
                    { role: 'assistant', content: '不会主动总结' },
                    { role: 'user', content: '[SUGGESTION MODE: Suggest what the user might naturally type next]. FIRST: read the last few lines...' },
                ],
            },
            response: { format: 'openai', content: [{ type: 'text', text: 'suggested reply text' }], finish_reason: 'stop', usage: null },
        },
        {
            // 主调用 N+1：真实用户新消息（建议调用打断了前缀链 → 也是快照）
            seq: 3, ts: 3000, msgCount: 3, status: 'ok',
            request: {
                snapshot: true, params: {},
                messages: [
                    { role: 'user', content: '你会总结对话内容吗' },
                    { role: 'assistant', content: '不会主动总结' },
                    { role: 'user', content: '我自己问的：你会总结对话内容吗' },
                ],
            },
            response: null,
        },
    ];
    const { turns } = extractor.extractFromTrajectory(steps);
    const userTexts = turns.filter((t) => t.role === 'user').map((t) => t.text);
    assert.ok(userTexts.includes('你会总结对话内容吗'));
    assert.ok(userTexts.includes('我自己问的：你会总结对话内容吗'));
    // 合成指令与其响应不过滤，原样出现在轨迹里
    assert.ok(userTexts.some((t) => t.startsWith('[SUGGESTION MODE')));
    assert.ok(turns.some((t) => t.role === 'assistant' && t.text === 'suggested reply text'));
});

test('extractFromTrajectory shrunk-history snapshot (compaction) resets baseline without duplicate turns', () => {
    const steps = [
        {
            seq: 1, ts: 1000, msgCount: 3, status: 'ok',
            request: {
                snapshot: true, params: {},
                messages: [
                    { role: 'user', content: 'a' },
                    { role: 'assistant', content: 'b' },
                    { role: 'user', content: 'c' },
                ],
            },
            response: null,
        },
        {
            // 压缩重写：历史整体缩短 → 只重置基线，旧尾部不重复成轮
            seq: 2, ts: 2000, msgCount: 2, status: 'ok',
            request: {
                snapshot: true, params: {},
                messages: [
                    { role: 'user', content: 'summary of a/b/c' },
                    { role: 'assistant', content: 'compacted' },
                ],
            },
            response: null,
        },
        {
            seq: 3, ts: 3000, msgCount: 3, status: 'ok',
            request: {
                snapshot: false, params: {},
                messages: [{ role: 'user', content: 'after compaction' }],
            },
            response: null,
        },
    ];
    const { turns } = extractor.extractFromTrajectory(steps);
    const texts = turns.map((t) => t.text);
    // 压缩前的旧消息不因重写快照而重复
    assert.equal(texts.filter((t) => t === 'a').length, 1);
    assert.equal(texts.filter((t) => t === 'c').length, 1);
    assert.ok(texts.includes('after compaction'));
});

test('extractFromTranscript coalesces consecutive keystroke in frames into one user turn', () => {
    const store = fakeTranscriptStore([
        { seq: 1, ts: 1000, kind: 'in', data: '/' },
        { seq: 2, ts: 1100, kind: 'in', data: 'm' },
        { seq: 3, ts: 1200, kind: 'in', data: 'o' },
        { seq: 4, ts: 1300, kind: 'in', data: 'd' },
        { seq: 5, ts: 1400, kind: 'in', data: 'e' },
        { seq: 6, ts: 1500, kind: 'in', data: 'l' },
        { seq: 7, ts: 1550, kind: 'in', data: '\n' }, // Enter 提交
        { seq: 8, ts: 1600, kind: 'out', data: 'model list\n' },
        // gap > USER_GAP_MS between the previous in frame and this one → new turn
        { seq: 9, ts: 6000, kind: 'in', data: 'hello' },
        { seq: 10, ts: 6100, kind: 'in', data: ' world' },
    ]);
    const { turns } = extractor.extractFromTranscript(store, 's1');
    assert.equal(turns.length, 3);
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[0].text, '/model');
    assert.equal(turns[1].role, 'assistant');
    assert.equal(turns[1].text, 'model list');
    assert.equal(turns[2].role, 'user');
    assert.equal(turns[2].text, 'hello world');
});

test('extractFromTranscript strips caret-notation CSI in assistant output', () => {
    const store = fakeTranscriptStore([
        { seq: 1, ts: 1000, kind: 'in', data: 'hello\n' },
        { seq: 2, ts: 1100, kind: 'out', data: '^[[I^[[?1;2c^[[I' },
        { seq: 3, ts: 1200, kind: 'out', data: 'real answer' },
    ]);
    const { turns } = extractor.extractFromTranscript(store, 's1');
    const assistant = turns.find((t) => t.role === 'assistant');
    assert.equal(assistant.text, 'real answer');
});

test('extractFromTranscript ignores TUI keystroke echoes (out frames interleaved with in)', () => {
    // opencode/Claude Code 等 TUI：每敲一键，终端回显一个 out 帧。
    // 用户输入活跃期的 out 应视为回显跳过，不把输入拆成碎片。
    const store = fakeTranscriptStore([
        { seq: 1, ts: 1000, kind: 'in', data: '/' },
        { seq: 2, ts: 1010, kind: 'out', data: '/' },          // 回显
        { seq: 3, ts: 1020, kind: 'in', data: 's' },
        { seq: 4, ts: 1030, kind: 'out', data: '/s' },         // 回显
        { seq: 5, ts: 1040, kind: 'in', data: 'k' },
        { seq: 6, ts: 1050, kind: 'out', data: '/sk' },        // 回显
        { seq: 7, ts: 1100, kind: 'in', data: '\n' },          // Enter 提交
        { seq: 8, ts: 2000, kind: 'out', data: 'Skills:\n' },
        { seq: 9, ts: 2100, kind: 'out', data: '1. bash\n' },
    ]);
    const { turns } = extractor.extractFromTranscript(store, 's1');
    assert.equal(turns.length, 2);
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[0].text, '/sk');       // 逐键输入合并为一个用户轮次
    assert.equal(turns[1].role, 'assistant');
    assert.equal(turns[1].text, 'Skills:\n1. bash');
});

test('extractFromTranscript caps turns at 100 (drops oldest)', () => {
    const frames = [];
    for (let i = 1; i <= 120; i += 1) {
        // gaps > USER_GAP_MS so each in frame is its own user turn
        frames.push({ seq: i, ts: i * 5000, kind: 'in', data: `msg${i}` });
    }
    const store = fakeTranscriptStore(frames);
    const { turns } = extractor.extractFromTranscript(store, 's1');
    assert.equal(turns.length, 100);
    assert.equal(turns[0].text, 'msg21');
    assert.equal(turns[99].text, 'msg120');
});

test('extractFromTranscript maxTurns=null disables the 100-turn cap', () => {
    const frames = [];
    for (let i = 1; i <= 120; i += 1) {
        frames.push({ seq: i, ts: i * 5000, kind: 'in', data: `msg${i}` });
    }
    const store = fakeTranscriptStore(frames);
    const { turns } = extractor.extractFromTranscript(store, 's1', 0, { maxTurns: null });
    assert.equal(turns.length, 120);
    assert.equal(turns[0].text, 'msg1');
    assert.equal(turns[119].text, 'msg120');
});

test('extractFromTranscript maxTurns=N keeps only the newest N turns', () => {
    const frames = [];
    for (let i = 1; i <= 30; i += 1) {
        frames.push({ seq: i, ts: i * 5000, kind: 'in', data: `msg${i}` });
    }
    const store = fakeTranscriptStore(frames);
    const { turns } = extractor.extractFromTranscript(store, 's1', 0, { maxTurns: 10 });
    assert.equal(turns.length, 10);
    assert.equal(turns[0].text, 'msg21');
});

test('extractFromStateDir maxTurns=null keeps all turns', () => {
    const lines = [];
    for (let i = 1; i <= 120; i += 1) {
        lines.push(JSON.stringify({
            type: 'user',
            message: { role: 'user', content: `msg${i}` },
            timestamp: `2025-07-04T10:00:${String(i).padStart(2, '0')}.000Z`,
        }));
    }
    const { turns } = extractor.extractFromStateDir(lines.join('\n'), { maxTurns: null });
    assert.equal(turns.length, 120);
    assert.equal(turns[0].text, 'msg1');
});

test('extract() passes maxTurns through to each source', async () => {
    const store = fakeTranscriptStore([
        { seq: 1, ts: 1000, kind: 'in', data: 'from transcript' },
    ]);
    const viaTranscript = await extractor.extract({
        transcriptStore: store,
        streamRef: 's1',
    });
    assert.equal(viaTranscript.source, 'transcript');
    assert.equal(viaTranscript.turns.length, 1);

    // chat source honors maxTurns=null
    const viaChat = await extractor.extract({
        transcriptStore: store,
        streamRef: 's1',
        readChatHistory: async () => [
            { seq: 1, ts: 1000, role: 'user', content: 'a' },
            { seq: 2, ts: 1100, role: 'user', content: 'b' },
        ],
        maxTurns: 1,
    });
    assert.equal(viaChat.source, 'chat');
    assert.equal(viaChat.turns.length, 1);
    assert.equal(viaChat.turns[0].text, 'b');
});

test('extractFromStateDir parses Claude JSONL with tools', () => {
    const jsonl = [
        JSON.stringify({
            type: 'user',
            message: { role: 'user', content: 'fix the bug' },
            timestamp: '2025-07-04T10:00:00.000Z',
        }),
        JSON.stringify({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'I will edit the file' },
                    { type: 'tool_use', name: 'Edit', input: {} },
                    { type: 'tool_use', name: 'Bash', input: {} },
                    { type: 'tool_use', name: 'Edit', input: {} },
                ],
            },
            timestamp: '2025-07-04T10:00:05.000Z',
        }),
        JSON.stringify({ type: 'summary', message: { role: 'user', content: 'skip me' } }),
        'not json at all',
    ].join('\n');
    const { source, turns } = extractor.extractFromStateDir(jsonl);
    assert.equal(source, 'state_dir');
    assert.equal(turns.length, 2);
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[0].text, 'fix the bug');
    assert.equal(turns[1].role, 'assistant');
    assert.equal(turns[1].text, 'I will edit the file');
    assert.deepEqual(turns[1].tools, ['Edit', 'Bash']);
});

test('extractFromStateDir handles string content and missing timestamp', () => {
    const jsonl = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'plain string content' },
    });
    const { turns } = extractor.extractFromStateDir(jsonl);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, 'plain string content');
    assert.equal(turns[0].ts, null);
});

test('extract prefers state_dir when readable and non-empty', async () => {
    const store = fakeTranscriptStore([
        { seq: 1, ts: 1000, kind: 'in', data: 'from transcript' },
    ]);
    const jsonl = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'from state dir' },
        timestamp: '2025-07-04T10:00:00.000Z',
    });
    const { source, turns } = await extractor.extract({
        transcriptStore: store,
        streamRef: 's1',
        stateDirRef: '.xensemble/state/s1',
        readStateDir: async () => jsonl,
    });
    assert.equal(source, 'state_dir');
    assert.equal(turns[0].text, 'from state dir');
});

test('extract falls back to transcript when state dir read fails', async () => {
    const store = fakeTranscriptStore([
        { seq: 1, ts: 1000, kind: 'in', data: 'from transcript' },
    ]);
    const { source, turns } = await extractor.extract({
        transcriptStore: store,
        streamRef: 's1',
        stateDirRef: '.xensemble/state/s1',
        readStateDir: async () => { throw new Error('ENOENT'); },
    });
    assert.equal(source, 'transcript');
    assert.equal(turns[0].text, 'from transcript');
});

test('extract falls back to transcript when state dir is empty', async () => {
    const store = fakeTranscriptStore([
        { seq: 1, ts: 1000, kind: 'in', data: 'from transcript' },
    ]);
    const { source } = await extractor.extract({
        transcriptStore: store,
        streamRef: 's1',
        stateDirRef: '.xensemble/state/s1',
        readStateDir: async () => '',
    });
    assert.equal(source, 'transcript');
});

test('extract uses transcript when no stateDirRef', async () => {
    const store = fakeTranscriptStore([
        { seq: 1, ts: 1000, kind: 'in', data: 'hello' },
    ]);
    const { source, turns } = await extractor.extract({
        transcriptStore: store,
        streamRef: 's1',
    });
    assert.equal(source, 'transcript');
    assert.equal(turns.length, 1);
});

test('extractFromTrajectory presents injected-context user messages verbatim (no filtering)', () => {
    // 内容过滤已移除：注入标签/合成消息原样成轮，一条 user 消息 = 一轮。
    const steps = [
        {
            seq: 1, ts: 1000, msgCount: 1, status: 'ok',
            request: {
                snapshot: true, params: {},
                messages: [
                    { role: 'user', content: '<system-reminder>injected only</system-reminder>' },
                ],
            },
            response: null,
        },
        {
            seq: 2, ts: 2000, msgCount: 2, status: 'ok',
            request: {
                snapshot: false, params: {},
                messages: [
                    { role: 'user', content: 'hello <system-reminder>ctx</system-reminder> world' },
                ],
            },
            response: null,
        },
    ];
    const { turns } = extractor.extractFromTrajectory(steps, { maxTurns: null });
    const userTurns = turns.filter((t) => t.role === 'user');
    assert.equal(userTurns.length, 2);
    assert.equal(userTurns[0].text, '<system-reminder>injected only</system-reminder>');
    assert.equal(userTurns[1].text, 'hello <system-reminder>ctx</system-reminder> world');
});
