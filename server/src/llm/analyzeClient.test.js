const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const client = require('./analyzeClient');

const origFetch = global.fetch;

// 0043：所有内置调用必须携带 metering；测试统一用这一份。
const METERING = { feature: 'test_feature', userId: 'user-1', sessionId: 'sess-1', projectId: 'proj-1' };

function mockFetchOnce(handler) {
    global.fetch = async (...args) => handler(...args);
}

// 等待 fire-and-forget 的 usage 落库微任务执行完
function flushMicrotasks() {
    return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
    process.env.LLM_ANALYZE_API_KEY = 'test-key';
    delete process.env.LLM_ANALYZE_API_URL;
    delete process.env.LLM_ANALYZE_MODEL;
    delete process.env.LLM_ANALYZE_TIMEOUT_MS;
    delete process.env.LLM_NO_THINKING_MODELS;
    delete process.env.LLM_ANALYZE_DISABLE_THINKING;
});

afterEach(() => {
    global.fetch = origFetch;
    delete process.env.LLM_ANALYZE_API_KEY;
    client.__setUsageSink(null);
});

test('isConfigured reflects env presence', () => {
    assert.equal(client.isConfigured(), true);
    delete process.env.LLM_ANALYZE_API_KEY;
    assert.equal(client.isConfigured(), false);
});

// ---- 0043：归属 fail-fast ----

test('chat without metering throws LlmAttributionError', async () => {
    await assert.rejects(
        () => client.chat({ system: 's', user: 'u' }),
        (err) => err.name === 'LlmAttributionError' && err.code === 'llm_attribution_missing',
    );
    await assert.rejects(
        () => client.chatRaw({ messages: [{ role: 'user', content: 'u' }] }),
        (err) => err.code === 'llm_attribution_missing',
    );
});

test('metering must include feature and userId', async () => {
    await assert.rejects(
        () => client.chat({ system: 's', user: 'u', metering: { userId: 'u1' } }),
        (err) => /metering.feature is required/.test(err.message),
    );
    await assert.rejects(
        () => client.chat({ system: 's', user: 'u', metering: { feature: 'f' } }),
        (err) => /metering.userId is required/.test(err.message) && /feature=f/.test(err.message),
    );
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
    const out = await client.chat({ system: 'sys', user: 'usr', metering: METERING });
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
        () => client.chat({ system: 's', user: 'u', metering: METERING }),
        (err) => err.code === 'llm_not_configured',
    );
});

test('chat throws LlmRequestError on HTTP error with status', async () => {
    mockFetchOnce(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }));
    await assert.rejects(
        () => client.chat({ system: 's', user: 'u', metering: METERING }),
        (err) => err.code === 'llm_request_failed' && err.status === 429,
    );
});

test('chat throws LlmRequestError on network failure', async () => {
    mockFetchOnce(async () => { throw new Error('ECONNREFUSED'); });
    await assert.rejects(
        () => client.chat({ system: 's', user: 'u', metering: METERING }),
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
        () => client.chat({ system: 's', user: 'u', metering: METERING }),
        (err) => err.code === 'llm_request_failed' && /timed out/.test(err.message),
    );
});

test('chat throws when response has no content', async () => {
    mockFetchOnce(async () => ({ ok: true, json: async () => ({ choices: [] }) }));
    await assert.rejects(
        () => client.chat({ system: 's', user: 'u', metering: METERING }),
        (err) => err.code === 'llm_request_failed' && /missing message content/.test(err.message),
    );
});

test('chatJson parses plain JSON', async () => {
    mockFetchOnce(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"a":1}' } }] }),
    }));
    assert.deepEqual(await client.chatJson({ system: 's', user: 'u', metering: METERING }), { a: 1 });
});

test('chatJson strips fenced code blocks', async () => {
    mockFetchOnce(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] }),
    }));
    assert.deepEqual(await client.chatJson({ system: 's', user: 'u', metering: METERING }), { a: 1 });
});

test('chatJson throws on invalid JSON', async () => {
    mockFetchOnce(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }),
    }));
    await assert.rejects(
        () => client.chatJson({ system: 's', user: 'u', metering: METERING }),
        (err) => err.code === 'llm_request_failed' && /invalid JSON/.test(err.message),
    );
});

test('chat passes responseFormat json option', async () => {
    let captured;
    mockFetchOnce(async (url, init) => {
        captured = JSON.parse(init.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
    });
    await client.chat({ system: 's', user: 'u', metering: METERING, options: { responseFormat: 'json' } });
    assert.deepEqual(captured.response_format, { type: 'json_object' });
});

// ---- 0043：usage 落库（source='internal'）----

test('successful response records usage with internal attribution', async () => {
    const rows = [];
    client.__setUsageSink(async (row) => { rows.push(row); });
    mockFetchOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
            choices: [{ message: { content: 'hello' } }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 64 } },
        }),
    }));
    const out = await client.chat({ system: 'sys', user: 'usr', metering: METERING });
    assert.equal(out, 'hello');
    await flushMicrotasks();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.source, 'internal');
    assert.equal(row.feature, 'test_feature');
    assert.equal(row.userId, 'user-1');
    assert.equal(row.sessionId, 'sess-1');
    assert.equal(row.projectId, 'proj-1');
    assert.equal(row.agentId, null);
    assert.equal(row.model, 'deepseek-chat');
    assert.equal(row.promptTokens, 100);
    assert.equal(row.completionTokens, 20);
    assert.equal(row.totalTokens, 120);
    assert.equal(row.cachedTokens, 64);
    assert.equal(row.statusCode, 200);
    assert.equal(typeof row.latencyMs, 'number');
    assert.equal(typeof row.createdAt, 'number');
    // agent 会话流量专属字段保持空
    assert.equal(row.requestedModel, null);
    assert.equal(row.trigger, null);
    assert.equal(row.seq, null);
});

test('response without usage is not recorded (漏计优于错计)', async () => {
    const rows = [];
    client.__setUsageSink(async (row) => { rows.push(row); });
    mockFetchOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
    }));
    await client.chat({ system: 's', user: 'u', metering: METERING });
    await flushMicrotasks();
    assert.equal(rows.length, 0);
});

test('usage insert failure does not break the caller', async () => {
    client.__setUsageSink(async () => { throw new Error('db down'); });
    mockFetchOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    }));
    const out = await client.chat({ system: 's', user: 'u', metering: METERING });
    assert.equal(out, 'hello');
    await flushMicrotasks();
});

test('failed requests are not recorded', async () => {
    const rows = [];
    client.__setUsageSink(async (row) => { rows.push(row); });
    mockFetchOnce(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    await assert.rejects(() => client.chat({ system: 's', user: 'u', metering: METERING }));
    await flushMicrotasks();
    assert.equal(rows.length, 0);
});

// ---- chatRaw / options ----

test('chatRaw returns full response and honours options', async () => {
    let captured;
    mockFetchOnce(async (url, init) => {
        captured = { url, body: JSON.parse(init.body) };
        return {
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 5, completion_tokens: 2 },
            }),
        };
    });
    const data = await client.chatRaw({
        messages: [{ role: 'user', content: 'hi' }],
        metering: METERING,
        options: {
            model: 'glm-5.3-flash',
            maxTokens: 16000,
            temperature: 0.2,
            timeoutMs: 1234,
            responseFormat: 'json',
            reasoningEffort: 'low',
            disableThinking: true,
        },
    });
    assert.equal(data.choices[0].message.content, 'x');
    assert.equal(captured.body.model, 'glm-5.3-flash');
    assert.equal(captured.body.max_tokens, 16000);
    assert.equal(captured.body.temperature, 0.2);
    assert.deepEqual(captured.body.response_format, { type: 'json_object' });
    assert.equal(captured.body.reasoning_effort, 'low');
    assert.deepEqual(captured.body.thinking, { type: 'disabled' });
});

test('chatRaw links external abort signal', async () => {
    const controller = new AbortController();
    mockFetchOnce((url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
        });
    }));
    const pending = client.chatRaw({
        messages: [{ role: 'user', content: 'hi' }],
        metering: METERING,
        options: { signal: controller.signal, timeoutMs: 60000 },
    });
    controller.abort();
    await assert.rejects(
        () => pending,
        (err) => err.code === 'llm_request_failed' && /aborted/.test(err.message),
    );
});

test('chatCompletionsUrl normalizes base and full URLs', () => {
    assert.equal(client.chatCompletionsUrl('https://x/api/v1'), 'https://x/api/v1/chat/completions');
    assert.equal(client.chatCompletionsUrl('https://x/api/v1/'), 'https://x/api/v1/chat/completions');
    assert.equal(client.chatCompletionsUrl('https://x/chat/completions'), 'https://x/chat/completions');
    assert.equal(client.chatCompletionsUrl('https://x/chat/completions/'), 'https://x/chat/completions');
});

// ---- 与主干 d5a932d 的融合接缝：strict 截断 / chatJson 放大重试 / 400 剥离重试 ----

test('chat strict throws llm_truncated on finish_reason=length', async () => {
    mockFetchOnce(async () => ({
        ok: true,
        json: async () => ({
            choices: [{ message: { content: '{"partial' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
    }));
    await assert.rejects(
        () => client.chat({ system: 's', user: 'u', metering: METERING, options: { strict: true } }),
        (err) => err.code === 'llm_truncated' && err.maxTokens === 1024 && err.content === '{"partial',
    );
});

test('chatJson retries with bumped maxTokens after truncation', async () => {
    const bodies = [];
    mockFetchOnce(async (url, init) => {
        bodies.push(JSON.parse(init.body));
        if (bodies.length === 1) {
            return {
                ok: true,
                json: async () => ({
                    choices: [{ message: { content: '{"cut' }, finish_reason: 'length' }],
                    usage: { prompt_tokens: 10, completion_tokens: 1024, total_tokens: 1034 },
                }),
            };
        }
        return {
            ok: true,
            json: async () => ({
                choices: [{ message: { content: '{"ok": true}' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
            }),
        };
    });
    const result = await client.chatJson({ system: 's', user: 'u', metering: METERING });
    assert.deepEqual(result, { ok: true });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].max_tokens, 1024);
    // 1024*4=4096（未超 MAX_RETRY_TOKENS=8192）
    assert.equal(bodies[1].max_tokens, 4096);
});

test('chatRaw strips optional fields once on 400', async () => {
    process.env.LLM_ANALYZE_DISABLE_THINKING = '1';
    const bodies = [];
    mockFetchOnce(async (url, init) => {
        bodies.push(JSON.parse(init.body));
        if (bodies.length === 1) {
            return { ok: false, status: 400, text: async () => 'thinking not supported' };
        }
        return {
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
        };
    });
    const rows = [];
    client.__setUsageSink((row) => rows.push(row));
    const data = await client.chatRaw({
        messages: [{ role: 'user', content: 'u' }],
        metering: METERING,
        options: { responseFormat: 'json' },
    });
    assert.equal(data.choices[0].message.content, 'hi');
    assert.equal(bodies.length, 2);
    assert.ok(bodies[0].thinking);
    assert.ok(bodies[0].response_format);
    assert.equal(bodies[1].thinking, undefined);
    assert.equal(bodies[1].response_format, undefined);
    // 成功的那次请求仍计量一次
    await flushMicrotasks();
    assert.equal(rows.length, 1);
    delete process.env.LLM_ANALYZE_DISABLE_THINKING;
});
