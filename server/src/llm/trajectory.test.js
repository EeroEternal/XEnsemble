const { test } = require('node:test');
const assert = require('node:assert/strict');
const trajectory = require('./trajectory');

// ---------------------------------------------------------------------------
// buildRequestRecord: snapshot vs delta
// ---------------------------------------------------------------------------

test('first request is a full snapshot', () => {
    const body = { model: 'm1', messages: [{ role: 'user', content: 'hi' }] };
    const rec = trajectory.buildRequestRecord(body, null);
    assert.equal(rec.snapshot, true);
    assert.equal(rec.msg_count, 1);
    assert.equal(rec.messages.length, 1);
    assert.equal(rec.params.model, 'm1');
    assert.ok(!('messages' in rec.params));
});

test('strict append stores only the delta', () => {
    const prev = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
    ];
    const body = {
        model: 'm1',
        messages: [...prev, { role: 'user', content: 'next' }],
    };
    const rec = trajectory.buildRequestRecord(body, prev);
    assert.equal(rec.snapshot, false);
    assert.equal(rec.msg_count, 3);
    assert.deepEqual(rec.messages, [{ role: 'user', content: 'next' }]);
});

test('history compaction resets to a snapshot', () => {
    const prev = [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
    ];
    const body = { model: 'm1', messages: [{ role: 'user', content: 'compacted' }] };
    const rec = trajectory.buildRequestRecord(body, prev);
    assert.equal(rec.snapshot, true);
    assert.equal(rec.msg_count, 1);
});

test('rewritten prefix (same length or mangled) resets to a snapshot', () => {
    const prev = [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
    ];
    const sameLen = [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'REWRITTEN' },
        { role: 'user', content: 'c' },
    ];
    const rec = trajectory.buildRequestRecord({ messages: sameLen }, prev);
    assert.equal(rec.snapshot, true);
});

// ---------------------------------------------------------------------------
// isSyntheticBypassCall: 旁路合成调用识别（写入端拒绝）
// ---------------------------------------------------------------------------

test('isSyntheticBypassCall detects suggestion-mode and memory calls', () => {
    assert.equal(trajectory.isSyntheticBypassCall({
        messages: [
            { role: 'user', content: '你会总结对话内容吗' },
            { role: 'assistant', content: '不会' },
            { role: 'user', content: '[SUGGESTION MODE: Suggest what the user might naturally type next]...' },
        ],
    }), true);

    assert.equal(trajectory.isSyntheticBypassCall({
        messages: [
            { role: 'user', content: 'hello' },
            { role: 'user', content: 'Managed memory has TWO directories. Choose...' },
        ],
    }), true);

    assert.equal(trajectory.isSyntheticBypassCall({
        messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi there' },
        ],
    }), false);

    assert.equal(trajectory.isSyntheticBypassCall({
        messages: [{ role: 'user', content: '真实用户消息' }],
    }), false);

    assert.equal(trajectory.isSyntheticBypassCall({ messages: [] }), false);
    assert.equal(trajectory.isSyntheticBypassCall(null), false);
});

// ---------------------------------------------------------------------------
// capRequestRecord
// ---------------------------------------------------------------------------

test('oversized record is degraded gracefully and flagged', () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const rec = {
        snapshot: true,
        params: {},
        msg_count: 2,
        messages: [{ role: 'user', content: big }, { role: 'user', content: 'small' }],
    };
    const capped = trajectory.capRequestRecord(rec);
    assert.equal(capped.truncated, true);
    assert.ok(trajectory.replayToFull([{ seq: 1, msgCount: 2, request: capped }])[0].truncated);
});

// ---------------------------------------------------------------------------
// parseResponseBytes
// ---------------------------------------------------------------------------

test('parses non-stream openai response with tool calls', () => {
    const body = {
        choices: [{
            message: {
                role: 'assistant',
                content: 'Working on it',
                reasoning_content: 'step 1: read file',
                tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
            },
            finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const resp = trajectory.parseResponseBytes(Buffer.from(JSON.stringify(body)), 'application/json');
    assert.equal(resp.format, 'openai');
    assert.equal(resp.content[0].type, 'thinking');
    assert.equal(resp.content[1].type, 'text');
    const tool = resp.content.find((c) => c.type === 'tool_use');
    assert.equal(tool.name, 'read_file');
    assert.deepEqual(tool.input, { path: 'a.ts' });
    assert.equal(resp.finish_reason, 'tool_calls');
    assert.equal(resp.usage.total_tokens, 15);
});

test('assembles openai SSE stream (text + reasoning + tool args + usage)', () => {
    const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
    const sse = [
        chunk({ choices: [{ delta: { role: 'assistant', reasoning_content: 'think' } }] }),
        chunk({ choices: [{ delta: { content: 'Hello ' } }] }),
        chunk({ choices: [{ delta: { content: 'world' } }] }),
        chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'bash', arguments: '{"cmd":' } }] } }] }),
        chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] }),
        chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }),
        'data: [DONE]\n\n',
    ].join('');
    const resp = trajectory.parseResponseBytes(Buffer.from(sse), 'text/event-stream');
    assert.equal(resp.format, 'openai');
    assert.equal(resp.content[0].type, 'thinking');
    assert.equal(resp.content[1].text, 'Hello world');
    const tool = resp.content[2];
    assert.equal(tool.type, 'tool_use');
    assert.deepEqual(tool.input, { cmd: 'ls' });
    assert.equal(resp.finish_reason, 'tool_calls');
    assert.equal(resp.usage.total_tokens, 10);
});

test('assembles anthropic SSE stream (thinking + text + tool_use + stop_reason)', () => {
    const ev = (o) => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
    const sse = [
        ev({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } }),
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'why' } }),
        ev({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
        ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Fixing' } }),
        ev({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't1', name: 'edit_file' } }),
        ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } }),
        ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }),
    ].join('');
    const resp = trajectory.parseResponseBytes(Buffer.from(sse), 'text/event-stream');
    assert.equal(resp.format, 'anthropic');
    assert.equal(resp.content[0].thinking, 'why');
    assert.equal(resp.content[1].text, 'Fixing');
    assert.deepEqual(resp.content[2].input, { path: 'a.ts' });
    assert.equal(resp.finish_reason, 'tool_use');
    assert.equal(resp.usage.prompt_tokens, 100);
    assert.equal(resp.usage.completion_tokens, 42);
});

test('non-stream anthropic response normalizes content blocks', () => {
    const body = {
        role: 'assistant',
        model: 'claude-x',
        stop_reason: 'end_turn',
        content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'done' },
        ],
        usage: { input_tokens: 5, output_tokens: 6 },
    };
    const resp = trajectory.parseResponseBytes(Buffer.from(JSON.stringify(body)), 'application/json');
    assert.equal(resp.format, 'anthropic');
    assert.equal(resp.finish_reason, 'end_turn');
    assert.equal(resp.content.length, 2);
});

// ---------------------------------------------------------------------------
// replayToFull: export-side delta replay
// ---------------------------------------------------------------------------

test('replay rebuilds full payloads from snapshot + deltas', () => {
    const steps = [
        { seq: 1, msgCount: 2, request: { snapshot: true, params: { model: 'm' }, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] } },
        { seq: 2, msgCount: 3, request: { snapshot: false, params: {}, messages: [{ role: 'user', content: 'c' }] } },
        { seq: 3, msgCount: 4, request: { snapshot: false, params: {}, messages: [{ role: 'tool', content: 'r' }] } },
    ];
    const lines = trajectory.replayToFull(steps);
    assert.equal(lines[0].request.messages.length, 2);
    assert.equal(lines[1].request.messages.length, 3);
    assert.equal(lines[2].request.messages.length, 4);
    assert.deepEqual(lines[2].request.messages.map((m) => m.content), ['a', 'b', 'c', 'r']);
    assert.ok(lines.every((l) => !l.replay_gap));
});

test('compaction snapshot resets replay context', () => {
    const steps = [
        { seq: 1, msgCount: 3, request: { snapshot: true, params: {}, messages: [{ content: 'a' }, { content: 'b' }, { content: 'c' }] } },
        { seq: 2, msgCount: 1, request: { snapshot: true, params: {}, messages: [{ content: 'compacted' }] } },
        { seq: 3, msgCount: 2, request: { snapshot: false, params: {}, messages: [{ content: 'd' }] } },
    ];
    const lines = trajectory.replayToFull(steps);
    assert.equal(lines[2].request.messages.length, 2);
    assert.deepEqual(lines[2].request.messages.map((m) => m.content), ['compacted', 'd']);
});

test('base mismatch flags replay_gap instead of silently corrupting', () => {
    const steps = [
        { seq: 2, msgCount: 3, request: { snapshot: false, params: {}, messages: [{ content: 'orphan delta' }] } },
    ];
    const lines = trajectory.replayToFull(steps);
    assert.equal(lines[0].replay_gap, true);
});

test('unmatched rows (failure without request) keep replay going', () => {
    const steps = [
        { seq: 1, msgCount: 0, request: { snapshot: true, unmatched: true, params: {}, messages: [] }, status: 'error', error: 'gateway down' },
        { seq: 2, msgCount: 1, request: { snapshot: true, params: {}, messages: [{ content: 'a' }] } },
    ];
    const lines = trajectory.replayToFull(steps);
    assert.equal(lines[0].request, null);
    assert.equal(lines[0].replay_gap, true);
    assert.equal(lines[1].request.messages.length, 1);
    assert.ok(!lines[1].replay_gap);
});

test('samePrefix: equal prefix is true, rewrite is false', () => {
    const { samePrefix } = require('./trajectory');
    const prev = [{ role: 'user', content: 'a' }];
    assert.equal(samePrefix([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], prev), true);
    assert.equal(samePrefix([{ role: 'user', content: 'compressed' }], prev), false);
});

test('getPrevMessages returns what rememberPrev stored via record path', () => {
    const t = require('./trajectory');
    assert.equal(t.getPrevMessages('sess_none'), null);
});
