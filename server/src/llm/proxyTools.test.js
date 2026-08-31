const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractUserMessage, extractAssistantMessage, extractToolCalls, extractToolResults } = require('./proxy');

describe('LLM proxy chat transcript extraction', () => {
    it('extracts the last user message from request body', () => {
        const body = Buffer.from(JSON.stringify({
            messages: [
                { role: 'system', content: 'be brief' },
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'hi' },
                { role: 'user', content: '  fix the bug  ' },
            ],
        }));
        assert.equal(extractUserMessage(body), 'fix the bug');
    });

    it('returns null when no user message present', () => {
        const body = Buffer.from(JSON.stringify({ messages: [{ role: 'assistant', content: 'x' }] }));
        assert.equal(extractUserMessage(body), null);
    });

    it('extracts assistant text from non-streaming JSON', () => {
        const body = Buffer.from(JSON.stringify({
            choices: [{ message: { content: '  the answer  ' } }],
        }));
        assert.equal(extractAssistantMessage(body, 'application/json'), 'the answer');
    });

    it('extracts assistant text from SSE stream', () => {
        const sse = [
            'data: {"choices":[{"delta":{"content":"Hel"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"lo"}}]}',
            '',
            'data: [DONE]',
            '',
        ].join('\n');
        assert.equal(extractAssistantMessage(Buffer.from(sse), 'text/event-stream'), 'Hello');
    });

    it('aggregates fragmented SSE tool_calls by index', () => {
        const sse = [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"src/a"}}]}}]}',
            '',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"pp.js\\"}"}}]}}]}',
            '',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"name":"grep","arguments":"{\\"q\\":\\"x\\"}"}}]}}]}',
            '',
            'data: [DONE]',
            '',
        ].join('\n');
        const calls = extractToolCalls(Buffer.from(sse), 'text/event-stream');
        assert.equal(calls.length, 2);
        const read = calls.find((c) => c.name === 'read_file');
        assert.ok(read);
        assert.equal(read.args, '{"path":"src/app.js"}');
        assert.ok(calls.some((c) => c.name === 'grep'));
    });

    it('extracts tool_calls from non-streaming JSON', () => {
        const body = Buffer.from(JSON.stringify({
            choices: [{ message: { tool_calls: [
                { id: 'c1', function: { name: 'grep', arguments: '{"q":"x"}' } },
            ] } }],
        }));
        const calls = extractToolCalls(body, 'application/json');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'grep');
        assert.equal(calls[0].args, '{"q":"x"}');
    });

    it('extracts tool_result messages from request body', () => {
        const body = Buffer.from(JSON.stringify({
            messages: [
                { role: 'user', content: 'hi' },
                { role: 'tool', tool_call_id: 'c1', name: 'grep', content: 'found 3 lines' },
                { role: 'tool', tool_call_id: 'c2', name: 'read_file', content: '// src\n' },
            ],
        }));
        const results = extractToolResults(body);
        assert.equal(results.length, 2);
        assert.deepEqual(results[0], { callId: 'c1', name: 'grep', content: 'found 3 lines' });
    });
});
