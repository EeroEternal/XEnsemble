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
