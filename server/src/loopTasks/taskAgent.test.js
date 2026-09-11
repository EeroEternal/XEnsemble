const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TASK = { title: 'demo task', prompt: 'Say hi to the workspace.' };

function llmResponse(content) {
    return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
        text: async () => '',
    };
}

function stubRuntime() {
    const calls = [];
    return {
        calls,
        exec: {
            exec: async (cmd, args, env, opts) => {
                calls.push({ cmd, args, cwd: opts?.cwd, timeoutMs: opts?.timeoutMs });
                return { exitCode: 0, stdout: 'hello-from-sandbox', stderr: '' };
            },
        },
        fs: {
            fsRead: async (root, rel) => `content-of:${rel}`,
            fsWrite: async (root, rel, content) => ({ path: rel, size: String(content).length }),
        },
    };
}

test.before(() => {
    process.env.LLM_TASK_API_KEY = 'test-key';
    process.env.LLM_TASK_MODEL = 'test-model';
    process.env.LOOP_TASK_REPEAT_CMD_LIMIT = '4';
});

test.after(() => {
    delete process.env.LLM_TASK_API_KEY;
    delete process.env.LLM_TASK_MODEL;
    delete process.env.LOOP_TASK_REPEAT_CMD_LIMIT;
});

test('executeTask drives run_shell then succeeds on final', async () => {
    const { executeTask } = require('./taskAgent');
    const scripted = [
        JSON.stringify({ action: 'tool', tool: 'run_shell', args: { cmd: 'echo hi' } }),
        JSON.stringify({ action: 'final', ok: true, summary: 'all done' }),
    ];
    let i = 0;
    const origFetch = global.fetch;
    global.fetch = async () => llmResponse(scripted[i++]);
    const runtime = stubRuntime();
    try {
        const result = await executeTask({
            runtime, runtimeRef: 'ref-1', workspacePath: '/workspace', task: TASK,
        });
        assert.equal(result.ok, true);
        assert.equal(result.status, 'succeeded');
        assert.equal(result.rounds, 2);
        assert.equal(runtime.calls.length, 1);
        assert.equal(runtime.calls[0].cwd, '/workspace');
    } finally {
        global.fetch = origFetch;
    }
});

test('executeTask handles read_file/edit_file and failure final', async () => {
    const { executeTask } = require('./taskAgent');
    const scripted = [
        JSON.stringify({ action: 'tool', tool: 'read_file', args: { path: 'a.txt' } }),
        JSON.stringify({ action: 'tool', tool: 'edit_file', args: { path: 'b.txt', content: 'new' } }),
        JSON.stringify({ action: 'final', ok: false, summary: 'cannot proceed' }),
    ];
    let i = 0;
    const origFetch = global.fetch;
    global.fetch = async () => llmResponse(scripted[i++]);
    const runtime = stubRuntime();
    try {
        const result = await executeTask({
            runtime, runtimeRef: 'ref-1', workspacePath: '/workspace', task: TASK,
        });
        assert.equal(result.ok, false);
        assert.equal(result.status, 'failed');
        assert.equal(result.error, 'cannot proceed');
        assert.equal(result.rounds, 3);
    } finally {
        global.fetch = origFetch;
    }
});

test('executeTask blocks repeated identical commands and fails on max rounds', async () => {
    const { executeTask } = require('./taskAgent');
    const origFetch = global.fetch;
    global.fetch = async () => llmResponse(JSON.stringify({ action: 'tool', tool: 'run_shell', args: { cmd: 'npm install' } }));
    const runtime = stubRuntime();
    try {
        const result = await executeTask({
            runtime, runtimeRef: 'ref-1', workspacePath: '/workspace', task: TASK,
            maxRounds: 6,
        });
        assert.equal(result.ok, false);
        assert.equal(result.status, 'failed');
        assert.match(result.error, /max rounds/);
        // REPEAT_CMD_LIMIT=4：同命令第 4 次起被拦截，不再执行
        assert.ok(runtime.calls.length < 6);
    } finally {
        global.fetch = origFetch;
    }
});

test('executeTask survives invalid LLM JSON with a correction turn', async () => {
    const { executeTask } = require('./taskAgent');
    const scripted = [
        'sorry, I am not a JSON machine',
        '```json\n{"action":"final","ok":true,"summary":"recovered"}\n```',
    ];
    let i = 0;
    const origFetch = global.fetch;
    global.fetch = async () => llmResponse(scripted[i++]);
    const runtime = stubRuntime();
    try {
        const result = await executeTask({
            runtime, runtimeRef: 'ref-1', workspacePath: '/workspace', task: TASK,
        });
        assert.equal(result.ok, true);
        assert.equal(result.summary, 'recovered');
        assert.equal(result.rounds, 2);
    } finally {
        global.fetch = origFetch;
    }
});
