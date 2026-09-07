const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractUpstreamErrorText, extractSseErrorText, recordLlmErrorEvent } = require('./proxy');
const chatTranscript = require('./chatTranscript');

describe('LLM proxy upstream error text extraction', () => {
    it('pulls a short message from OpenAI-style JSON error bodies', () => {
        const body = Buffer.from(JSON.stringify({ error: { message: 'rate limit exceeded, please retry' } }));
        assert.equal(extractUpstreamErrorText(body, 'application/json'), 'rate limit exceeded, please retry');
    });

    it('falls back to top-level message / detail fields', () => {
        assert.equal(extractUpstreamErrorText(Buffer.from(JSON.stringify({ message: 'quota exceeded' })), 'application/json'), 'quota exceeded');
        assert.equal(extractUpstreamErrorText(Buffer.from(JSON.stringify({ detail: 'bad model' })), 'application/json'), 'bad model');
    });

    it('falls back to plain text and handles empty bodies', () => {
        assert.equal(extractUpstreamErrorText(Buffer.from('  too many requests\n'), 'text/plain'), 'too many requests');
        assert.equal(extractUpstreamErrorText(Buffer.alloc(0), 'application/json'), '');
    });
});

describe('LLM proxy in-stream SSE error detection (200-status streams)', () => {
    it('extracts the gateway error event from a failed OpenAI-style SSE stream', () => {
        const body = Buffer.from(
            'data: {"error":{"message":"core execution exhausted all attempts: upstream http error 401 from endpoint Tokens","type":"gateway_error"}}\n\n',
        );
        assert.equal(
            extractSseErrorText(body),
            'core execution exhausted all attempts: upstream http error 401 from endpoint Tokens',
        );
    });

    it('extracts Anthropic-style type:error events', () => {
        const body = Buffer.from('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"boom"}}\n\n');
        assert.equal(extractSseErrorText(body), 'boom');
    });

    it('ignores healthy streams and non-SSE bodies', () => {
        const healthy = Buffer.from('data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
        assert.equal(extractSseErrorText(healthy), '');
        assert.equal(extractSseErrorText(Buffer.from('plain error text')), '');
        assert.equal(extractSseErrorText(Buffer.alloc(0)), '');
    });
});

describe('LLM proxy chat error events', () => {
    it('records role:error events, throttling identical retries but recording new ones', async () => {
        const sid = `sess_llm_err_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        // The dialog view receives these via the live subscriber → WS
        // chat_event path, so assert on that (history persistence is covered
        // by the DB-backed suites). Subscriber callbacks fire after the async
        // seq seeding in chatTranscript.append, so wait for them to land.
        const seen = [];
        const off = chatTranscript.subscribe(sid, (entry) => seen.push(entry));
        recordLlmErrorEvent(sid, 429, 'rate limit exceeded');
        recordLlmErrorEvent(sid, 429, 'rate limit exceeded'); // identical retry → throttled
        recordLlmErrorEvent(sid, 429, 'quota exceeded');      // different content → recorded
        await new Promise((resolve) => setTimeout(resolve, 150));
        off();
        assert.deepEqual(seen.map((e) => e.content), ['429: rate limit exceeded', '429: quota exceeded']);
        assert.ok(seen.every((e) => e.role === 'error' && typeof e.seq === 'number' && typeof e.ts === 'number'));
    });
});
