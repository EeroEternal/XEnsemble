const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const client = require('./analyzeClient');

const origFetch = global.fetch;

function mockFetchOnce(handler) {
    global.fetch = async (...args) => handler(...args);
}

beforeEach(() => {
    process.env.LLM_ANALYZE_API_KEY = 'test-key';
    delete process.env.LLM_ANALYZE_API_URL;
    delete process.env.LLM_ANALYZE_MODEL;
    delete process.env.LLM_ANALYZE_TIMEOUT_MS;
});

afterEach(() => {
    global.fetch = origFetch;
    delete process.env.LLM_ANALYZE_API_KEY;
});

test('isConfigured reflects env presence', () => {
    assert.equal(client.isConfigured(), true);
    delete process.env.LLM_ANALYZE_API_KEY;
    assert.equal(client.isConfigured(), false);
});

test('chat sends auth header and returns content', async () => {
    let captured;
    mockFetchOnce(async (url, init) => {
        captured = { url, init };
        return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
        };
    });
    const out = await client.chat({ system: 'sys', user: 'usr' });
    assert.equal(out, 'hello');
    assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(captured.init.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.model, 'deepseek-chat');
    assert.deepEqual(body.messages, [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
    ]);
});

test('chat throws LlmNotConfiguredError without key', async () => {
    delete process.env.LLM_ANALYZE_API_KEY;
    await assert.rejects(
        () => client.chat({ system: 's', user: 'u' }),
        (err) => err.code === 'llm_not_configured',
    );
});

test('chat throws LlmRequestError on HTTP error with status', async () => {
    mockFetchOnce(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }));
    await assert.rejects(
        () => client.chat({ system: 's', user: 'u' }),
        (err) => err.code === 'llm_request_failed' && err.status === 429,
    );
});

test('chat throws LlmRequestError on network failure', async () => {
    mockFetchOnce(async () => { throw new Error('ECONNREFUSED'); });
    await assert.rejects(
        () => client.chat({ system: 's', user: 'u' }),
        (err) => err.code === 'llm_request_failed' && /ECONNREFUSED/.test(err.message),
    );
});

test('chat throws LlmRequestError on timeout', async () => {
    process.env.LLM_ANALYZE_TIMEOUT_MS = '50';
    mockFetchOnce((url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
        });
    }));
    await assert.rejects(
        () => client.chat({ system: 's', user: 'u' }),
        (err) => err.code === 'llm_request_failed' && /timed out/.test(err.message),
    );
});

test('chat throws when response has no content', async () => {
    mockFetchOnce(async () => ({ ok: true, json: async () => ({ choices: [] }) }));
    await assert.rejects(
        () => client.chat({ system: 's', user: 'u' }),
        (err) => err.code === 'llm_request_failed' && /missing message content/.test(err.message),
    );
});

test('chatJson parses plain JSON', async () => {
    mockFetchOnce(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"a":1}' } }] }),
    }));
    assert.deepEqual(await client.chatJson({ system: 's', user: 'u' }), { a: 1 });
});

test('chatJson strips fenced code blocks', async () => {
    mockFetchOnce(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] }),
    }));
    assert.deepEqual(await client.chatJson({ system: 's', user: 'u' }), { a: 1 });
});

test('chatJson throws on invalid JSON', async () => {
    mockFetchOnce(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }),
    }));
    await assert.rejects(
        () => client.chatJson({ system: 's', user: 'u' }),
        (err) => err.code === 'llm_request_failed' && /invalid JSON/.test(err.message),
    );
});

test('chat passes responseFormat json option', async () => {
    let captured;
    mockFetchOnce(async (url, init) => {
        captured = JSON.parse(init.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
    });
    await client.chat({ system: 's', user: 'u', options: { responseFormat: 'json' } });
    assert.deepEqual(captured.response_format, { type: 'json_object' });
});
