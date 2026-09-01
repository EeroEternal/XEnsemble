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
        { seq: 1, ts: 1000, kind: 'in', data: 'fix the login bug' },
        { seq: 2, ts: 1500, kind: 'out', data: 'Looking at auth.js\n' },
        { seq: 3, ts: 1600, kind: 'out', data: 'Found the issue\n' },
        { seq: 4, ts: 5000, kind: 'in', data: 'what was it?' },
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
        { seq: 1, ts: 1000, kind: 'in', data: 'go' },
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
        { seq: 1, ts: 1000, kind: 'in', data: 'run tests' },
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

test('extractFromChat maps user/assistant/tool_call and skips tool_result', () => {
    const history = [
        { seq: 1, ts: 1000, role: 'user', content: 'fix the login bug' },
        { seq: 2, ts: 1100, role: 'tool_call', tool: 'Edit', content: '{"path":"auth.js"}' },
        { seq: 3, ts: 1200, role: 'tool_result', tool: 'Edit', content: 'ok' },
        { seq: 4, ts: 1300, role: 'assistant', content: 'Done, edited auth.js' },
    ];
    const { source, turns, headSeq } = extractor.extractFromChat(history);
    assert.equal(source, 'chat');
    assert.equal(headSeq, 4);
    assert.equal(turns.length, 3);
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[0].text, 'fix the login bug');
    assert.equal(turns[1].role, 'assistant');
    assert.deepEqual(turns[1].tools, ['Edit']);
    assert.equal(turns[2].text, 'Done, edited auth.js');
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

test('extractFromTranscript coalesces consecutive keystroke in frames into one user turn', () => {
    const store = fakeTranscriptStore([
        { seq: 1, ts: 1000, kind: 'in', data: '/' },
        { seq: 2, ts: 1100, kind: 'in', data: 'm' },
        { seq: 3, ts: 1200, kind: 'in', data: 'o' },
        { seq: 4, ts: 1300, kind: 'in', data: 'd' },
        { seq: 5, ts: 1400, kind: 'in', data: 'e' },
        { seq: 6, ts: 1500, kind: 'in', data: 'l' },
        { seq: 7, ts: 1600, kind: 'out', data: 'model list\n' },
        // gap > USER_GAP_MS between the previous in frame and this one → new turn
        { seq: 8, ts: 6000, kind: 'in', data: 'hello' },
        { seq: 9, ts: 6100, kind: 'in', data: ' world' },
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
        { seq: 1, ts: 1000, kind: 'in', data: 'hello' },
        { seq: 2, ts: 1100, kind: 'out', data: '^[[I^[[?1;2c^[[I' },
        { seq: 3, ts: 1200, kind: 'out', data: 'real answer' },
    ]);
    const { turns } = extractor.extractFromTranscript(store, 's1');
    const assistant = turns.find((t) => t.role === 'assistant');
    assert.equal(assistant.text, 'real answer');
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
