import { describe, it, expect } from 'vitest';
import { buildEntries } from '@/components/trajectory/TrajectoryViewer';

// 组件内 buildEntries 的 t 仅用于把 i18n key 写进 label，测试里直接透传
const t = (key) => key;
const toolCalls = (entries) => entries.filter((e) => e.kind === 'tool' && e.name != null);
const toolResults = (entries) => entries.filter((e) => e.kind === 'tool' && e.name == null);

describe('trajectory buildEntries: tool call + result merge', () => {
    it('merges a tool_result into its tool_use and drops the replayed duplicate call', () => {
        const steps = [
            {
                seq: 1, ts: 1000, msgCount: 2, snapshot: true, status: 'ok', latencyMs: 500,
                request: { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] },
                response: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
            },
            {
                seq: 2, ts: 2000, msgCount: 4, snapshot: false, status: 'ok', latencyMs: 300,
                request: {
                    messages: [
                        { role: 'assistant', content: [{ type: 'text', text: 'run' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
                        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.js b.js' }] },
                    ],
                },
                response: { content: [{ type: 'text', text: 'done' }] },
            },
        ];

        const entries = buildEntries(steps, t);

        // 只有一次调用（请求侧重放的 tool_use 被去重）
        expect(toolCalls(entries)).toHaveLength(1);
        // 结果不再单独成行，而是挂到调用条目上
        expect(toolResults(entries)).toHaveLength(0);
        const call = toolCalls(entries)[0];
        expect(call.name).toBe('Bash');
        expect(call.text).toBe('{"command":"ls"}');
        expect(call.result?.text).toBe('a.js b.js');
    });

    it('pairs parallel tool calls with their results by id', () => {
        const steps = [
            {
                seq: 1, ts: 1, msgCount: 1, snapshot: true, status: 'ok',
                request: { messages: [{ role: 'user', content: 'go' }] },
                response: {
                    content: [
                        { type: 'tool_use', id: 'a', name: 'Read', input: { path: 'x' } },
                        { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'pwd' } },
                    ],
                },
            },
            {
                seq: 2, ts: 2, msgCount: 3, snapshot: false, status: 'ok',
                request: {
                    messages: [
                        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { path: 'x' } }, { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'pwd' } }] },
                        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'file content' }, { type: 'tool_result', tool_use_id: 'b', content: '/home' }] },
                    ],
                },
                response: { content: [{ type: 'text', text: 'ok' }] },
            },
        ];

        const entries = buildEntries(steps, t);
        const calls = toolCalls(entries);
        expect(calls.map((c) => c.name)).toEqual(['Read', 'Bash']);
        expect(calls.find((c) => c.name === 'Read').result.text).toBe('file content');
        expect(calls.find((c) => c.name === 'Bash').result.text).toBe('/home');
    });

    it('attaches OpenAI role:tool results via tool_call_id', () => {
        const steps = [
            {
                seq: 1, ts: 1, msgCount: 1, snapshot: true, status: 'ok',
                request: { messages: [{ role: 'user', content: 'go' }] },
                response: { content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }] },
            },
            {
                seq: 2, ts: 2, msgCount: 3, snapshot: false, status: 'ok',
                request: {
                    messages: [
                        { role: 'assistant', content: [], tool_calls: [{ id: 'call_1', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] },
                        { role: 'tool', tool_call_id: 'call_1', content: 'output text' },
                    ],
                },
                response: { content: [{ type: 'text', text: 'ok' }] },
            },
        ];

        const entries = buildEntries(steps, t);
        const calls = toolCalls(entries);
        expect(calls).toHaveLength(1);
        expect(calls[0].result?.text).toBe('output text');
    });

    it('keeps an orphan tool_result as a standalone entry (paged / no matching call)', () => {
        const steps = [
            {
                seq: 1, ts: 1, msgCount: 1, snapshot: true, status: 'ok',
                request: { messages: [{ role: 'user', content: 'go' }] },
                response: { content: [{ type: 'text', text: 'ok' }] },
            },
            {
                seq: 2, ts: 2, msgCount: 2, snapshot: false, status: 'ok',
                request: { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'orphan' }] }] },
                response: { content: [{ type: 'text', text: 'ok' }] },
            },
        ];

        const entries = buildEntries(steps, t);
        expect(toolCalls(entries)).toHaveLength(0);
        expect(toolResults(entries)).toHaveLength(1);
        expect(toolResults(entries)[0].text).toBe('orphan');
    });
});

describe('trajectory buildEntries: thinking belongs to the assistant turn', () => {
    it('merges thinking + reply into one assistant entry (no standalone thinking row)', () => {
        const steps = [
            {
                seq: 1, ts: 1, msgCount: 1, snapshot: true, status: 'ok',
                request: { messages: [{ role: 'user', content: 'go' }] },
                response: {
                    content: [
                        { type: 'thinking', thinking: 'let me think' },
                        { type: 'text', text: 'here is the answer' },
                        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
                    ],
                },
            },
        ];

        const entries = buildEntries(steps, t);
        expect(entries.some((e) => e.kind === 'thinking')).toBe(false);
        const assistant = entries.find((e) => e.kind === 'assistant');
        expect(assistant.text).toBe('here is the answer');
        expect(assistant.thinking).toBe('let me think');
    });

    it('keeps a thinking-only response as an assistant entry with an empty reply', () => {
        const steps = [
            {
                seq: 1, ts: 1, msgCount: 1, snapshot: true, status: 'ok',
                request: { messages: [{ role: 'user', content: 'go' }] },
                response: {
                    content: [
                        { type: 'thinking', thinking: 'only thinking' },
                        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
                    ],
                },
            },
        ];

        const entries = buildEntries(steps, t);
        const assistant = entries.find((e) => e.kind === 'assistant');
        expect(assistant.thinking).toBe('only thinking');
        expect(assistant.text).toBe('');
        // 工具调用与助手同属一个用户轮次
        expect(assistant.round).toBe(1);
        expect(entries.find((e) => e.kind === 'tool').round).toBe(1);
    });
});

describe('trajectory buildEntries: user turn boundaries', () => {
    it('counts one turn per user message even with injected context between texts', () => {
        const steps = [
            {
                seq: 1, ts: 1, msgCount: 1, snapshot: true, status: 'ok',
                request: { messages: [{ role: 'user', content: 'hello <system-reminder>x</system-reminder> world' }] },
                response: { content: [{ type: 'text', text: 'ok' }] },
            },
        ];
        const entries = buildEntries(steps, t);
        expect(entries.filter((e) => e.kind === 'user')).toHaveLength(2);
        expect(entries.reduce((m, e) => Math.max(m, e.round), 0)).toBe(1);
    });

    it('does not open a turn for an injected-context-only message', () => {
        const steps = [
            {
                seq: 1, ts: 1, msgCount: 1, snapshot: true, status: 'ok',
                request: { messages: [{ role: 'user', content: '<system-reminder>only</system-reminder>' }] },
                response: { content: [{ type: 'text', text: 'ok' }] },
            },
        ];
        const entries = buildEntries(steps, t);
        expect(entries.filter((e) => e.kind === 'user')).toHaveLength(0);
        expect(entries.reduce((m, e) => Math.max(m, e.round), 0)).toBe(0);
    });

    it('keeps all tool calls of one user turn in the same round', () => {
        const mk = (seq, prevIds, ids) => ({
            seq, ts: seq, msgCount: 1, snapshot: seq === 1, status: 'ok',
            request: {
                snapshot: seq === 1, params: {},
                messages: seq === 1
                    ? [{ role: 'user', content: 'go' }]
                    : [
                        { role: 'assistant', content: prevIds.map((id) => ({ type: 'tool_use', id, name: 'T', input: {} })) },
                        { role: 'user', content: prevIds.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'r' })) },
                    ],
            },
            response: {
                content: [
                    { type: 'thinking', thinking: `th${seq}` },
                    ...ids.map((id) => ({ type: 'tool_use', id, name: 'T', input: {} })),
                ],
            },
        });
        const entries = buildEntries([mk(1, [], ['a1', 'a2']), mk(2, ['a1', 'a2'], ['b1', 'b2']), mk(3, ['b1', 'b2'], ['c1', 'c2'])], t);
        const rounds = new Set(entries.filter((e) => e.kind === 'tool').map((e) => e.round));
        expect(rounds.size).toBe(1);
        expect([...rounds][0]).toBe(1);
    });
});

// 跨端 parity：server 端 conversationExtractor.test.js 读同一份 fixtures 断言
// userTurns / 剥离文本，这里断言 buildEntries 的 round 数一致。
import injectedFixtures from '../../../shared/injectedContext.fixtures.json';

describe('user turn parity (web, shared fixtures)', () => {
    for (const c of injectedFixtures.cases) {
        it(c.name, () => {
            const steps = [
                {
                    seq: 1, ts: 1000, msgCount: 1, status: 'ok',
                    request: { snapshot: true, params: {}, messages: [{ role: 'user', content: c.blocks ?? c.content }] },
                    response: null,
                },
            ];
            const entries = buildEntries(steps, t);
            expect(entries.reduce((m, e) => Math.max(m, e.round), 0)).toBe(c.userTurns);
        });
    }
});
