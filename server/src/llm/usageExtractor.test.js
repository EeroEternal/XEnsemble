const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractUsage, extractUsageFromSse, normalizeUsage } = require('./usageExtractor');

test('extractUsage: OpenAI 非流式 JSON 携带 usage', () => {
    const body = Buffer.from(JSON.stringify({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
    }));
    assert.deepEqual(extractUsage(body, 'application/json'), {
        promptTokens: 120, completionTokens: 45, totalTokens: 165,
    });
});

test('extractUsage: OpenAI JSON 无 usage → null', () => {
    const body = Buffer.from(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }));
    assert.equal(extractUsage(body, 'application/json'), null);
});

test('extractUsage: OpenAI SSE 最终 usage chunk（include_usage）', () => {
    const sse = [
        'data: {"choices":[{"delta":{"content":"he"},"usage":null}]}',
        '',
        'data: {"choices":[{"delta":{"content":"llo"}}]}',
        '',
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
        '',
        'data: [DONE]',
        '',
    ].join('\n');
    assert.deepEqual(extractUsage(Buffer.from(sse), 'text/event-stream'), {
        promptTokens: 10, completionTokens: 5, totalTokens: 15,
    });
});

test('extractUsage: OpenAI SSE 无 usage → null', () => {
    const sse = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n';
    assert.equal(extractUsage(Buffer.from(sse), 'text/event-stream'), null);
});

test('extractUsage: Anthropic SSE message_start + message_delta 累加', () => {
    const sse = [
        'event: message_start',
        'data: {"type":"message_start","usage":{"input_tokens":100,"output_tokens":1}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","usage":{"output_tokens":42}}',
        '',
    ].join('\n');
    assert.deepEqual(extractUsage(Buffer.from(sse), 'text/event-stream'), {
        promptTokens: 100, completionTokens: 42, totalTokens: 142,
    });
});

test('extractUsage: SSE 截断残行不崩溃且能解析完整块', () => {
    const complete = 'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n';
    const truncated = 'data: {"usage":{"prompt_tok'; // 残行
    const result = extractUsage(Buffer.from(complete + truncated), 'text/event-stream');
    assert.deepEqual(result, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
});

test('extractUsage: 非法 JSON → null', () => {
    assert.equal(extractUsage(Buffer.from('not json'), 'application/json'), null);
});

test('extractUsage: 空 buffer → null', () => {
    assert.equal(extractUsage(Buffer.alloc(0), 'application/json'), null);
});

test('normalizeUsage: Anthropic 非流式 input/output_tokens 命名', () => {
    assert.deepEqual(normalizeUsage({ input_tokens: 7, output_tokens: 3 }), {
        promptTokens: 7, completionTokens: 3, totalTokens: 10,
    });
});

test('normalizeUsage: 全 0 → null', () => {
    assert.equal(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 }), null);
});

test('extractUsageFromSse: Anthropic 仅 message_start（无 delta）', () => {
    const sse = 'data: {"type":"message_start","usage":{"input_tokens":50}}\n\n';
    const result = extractUsageFromSse(Buffer.from(sse));
    assert.deepEqual(result, { promptTokens: 50, completionTokens: 0, totalTokens: 50 });
});
