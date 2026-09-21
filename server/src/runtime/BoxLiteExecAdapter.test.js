const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const BoxLiteExecAdapter = require('./BoxLiteExecAdapter');
const BoxLiteClient = require('./BoxLiteClient');
const { BoxLiteStreamHandle } = BoxLiteExecAdapter;
const { decodeExecutionFrame } = BoxLiteClient;

function makeWs() {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.send = () => {};
    ws.close = () => {};
    return ws;
}

test('BoxLiteStreamHandle decodes seq-framed and legacy binary output', () => {
    const seqWs = makeWs();
    const seqHandle = new BoxLiteStreamHandle(seqWs, 'boxlite:p_proj:exec_1', { preferSeqFrames: true });
    const seqFrames = [];
    seqHandle.onData((payload, rseq) => {
        seqFrames.push({ payload, rseq });
    });

    const seqBuf = Buffer.alloc(8);
    seqBuf.writeBigUInt64BE(42n, 0);
    seqWs.emit('message', Buffer.concat([Buffer.from([0x01]), seqBuf, Buffer.from('hello\n')]), true);

    assert.deepEqual(seqFrames, [{ payload: 'hello\n', rseq: 42 }]);

    const legacyWs = makeWs();
    const legacyHandle = new BoxLiteStreamHandle(legacyWs, 'boxlite:p_proj:exec_2', { preferSeqFrames: false });
    const legacyFrames = [];
    legacyHandle.onData((payload, rseq) => {
        legacyFrames.push({ payload, rseq });
    });

    legacyWs.emit('message', Buffer.concat([Buffer.from([0x01]), Buffer.from('legacy\n')]), true);
    assert.deepEqual(legacyFrames, [{ payload: 'legacy\n', rseq: undefined }]);
});

test('decodeExecutionFrame deterministically parses seq-framed payloads', () => {
    const printablePrefix = Buffer.from('ABCDEFGH');
    const rseqBuf = Buffer.alloc(8);
    rseqBuf.writeBigUInt64BE(99n, 0);
    const payload = Buffer.from('ansi-\u001b[31mred\u001b[0m\n');
    const frame = Buffer.concat([Buffer.from([0x01]), rseqBuf, payload, printablePrefix]);

    const decoded = decodeExecutionFrame(frame, true);
    assert.equal(decoded.channel, 0x01);
    assert.equal(decoded.rseq, 99);
    assert.equal(decoded.payload, 'ansi-\u001b[31mred\u001b[0m\nABCDEFGH');
});

test('BoxLiteExecAdapter forwards command output and timeout limits', async () => {
    const adapter = new BoxLiteExecAdapter();
    let observed = null;
    adapter.client = {
        async execForResult(...args) {
            observed = args;
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };

    await adapter.exec('git', ['diff'], {}, {
        runtimeRef: 'runtime-1',
        cwd: '/workspace',
        maxBuffer: 1024,
        timeoutMs: 5000,
    });

    assert.deepEqual(observed[5], { maxBuffer: 1024, timeoutMs: 5000 });
});

test('BoxLiteExecAdapter.spawn injects IS_SANDBOX=1 and lets caller env override', async () => {
    const adapter = new BoxLiteExecAdapter();
    let captured = null;
    adapter.client = {
        async spawn(_name, spec) {
            captured = spec;
            return { execution_id: 'exec_1' };
        },
        createExecutionAttachWebSocket() {
            const ws = makeWs();
            setImmediate(() => ws.emit('open'));
            return ws;
        },
    };

    await adapter.spawn('claude', ['-p', 'hi', '--dangerously-skip-permissions'], { FOO: 'bar' }, {
        runtimeRef: 'runtime-1',
        cwd: '/workspace',
    });

    assert.equal(captured.env.IS_SANDBOX, '1');
    assert.equal(captured.env.FOO, 'bar');
    assert.equal(captured.tty, true);

    // caller-provided IS_SANDBOX wins over the injected default
    await adapter.spawn('sh', ['-c', 'true'], { IS_SANDBOX: '0' }, {
        runtimeRef: 'runtime-1',
        cwd: '/workspace',
    });
    assert.equal(captured.env.IS_SANDBOX, '0');
});

// 输出面半死（WS 仍 OPEN、pong 正常，但 output 帧不再投递）时，发出输入后长时间
// 收不到任何 output 帧应触发主动重连 attach，以 _lastRseq 为游标重放补回输出。
test('BoxLiteStreamHandle reattaches when output goes silent after input', async () => {
    const ws = makeWs();
    const attachArgs = [];
    const client = {
        parseExecutionStreamRef: () => ({ sessionName: 'p_proj', execId: 'exec_1' }),
        createExecutionAttachWebSocket: (sessionName, execId, options) => {
            attachArgs.push({ sessionName, execId, options });
            const newWs = makeWs();
            setImmediate(() => newWs.emit('open'));
            return newWs;
        },
    };
    const handle = new BoxLiteStreamHandle(ws, 'boxlite:p_proj:exec_1', {
        preferSeqFrames: true,
        client,
        silenceTimeoutMs: 30,
        heartbeatIntervalMs: 10,
    });

    handle.write('hi\r');
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(attachArgs.length >= 1, 'expected an active attach to recover the channel');
    assert.equal(attachArgs[0].options.after, 0);
    handle.kill();
});

test('BoxLiteStreamHandle does not reattach while output keeps arriving', async () => {
    const ws = makeWs();
    let attachCalls = 0;
    const client = {
        parseExecutionStreamRef: () => ({ sessionName: 'p_proj', execId: 'exec_1' }),
        createExecutionAttachWebSocket: () => {
            attachCalls += 1;
            const newWs = makeWs();
            setImmediate(() => newWs.emit('open'));
            return newWs;
        },
    };
    const handle = new BoxLiteStreamHandle(ws, 'boxlite:p_proj:exec_1', {
        preferSeqFrames: true,
        client,
        silenceTimeoutMs: 30,
        heartbeatIntervalMs: 10,
    });

    handle.write('hi\r');
    // 持续有 output 帧到达（TUI 回显/流式输出）→ 不应判定为半死。
    const iv = setInterval(() => {
        const rseqBuf = Buffer.alloc(8);
        rseqBuf.writeBigUInt64BE(1n, 0);
        ws.emit('message', Buffer.concat([Buffer.from([0x01]), rseqBuf, Buffer.from('x')]), true);
    }, 10);
    await new Promise((r) => setTimeout(r, 100));
    clearInterval(iv);

    assert.equal(attachCalls, 0);
    handle.kill();
});

test('BoxLiteStreamHandle stays idle without input (no false-positive recovery)', async () => {
    const ws = makeWs();
    let attachCalls = 0;
    const client = {
        parseExecutionStreamRef: () => ({ sessionName: 'p_proj', execId: 'exec_1' }),
        createExecutionAttachWebSocket: () => {
            attachCalls += 1;
            return makeWs();
        },
    };
    const handle = new BoxLiteStreamHandle(ws, 'boxlite:p_proj:exec_1', {
        preferSeqFrames: true,
        client,
        silenceTimeoutMs: 30,
        heartbeatIntervalMs: 10,
    });

    // 没有任何输入：agent 长时间不产出属正常空闲，不得误判为链路故障。
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(attachCalls, 0);
    handle.kill();
});

// cline 会话 91.5% 的输入帧是鼠标事件；TUI 在 agent 思考期间不产生输出，
// 这类帧不期待回显，绝不能被当作「输出面半死」而反复触发重连。
test('BoxLiteStreamHandle ignores mouse/escape input (no false-positive recovery)', async () => {
    const ws = makeWs();
    let attachCalls = 0;
    const client = {
        parseExecutionStreamRef: () => ({ sessionName: 'p_proj', execId: 'exec_1' }),
        createExecutionAttachWebSocket: () => {
            attachCalls += 1;
            return makeWs();
        },
    };
    const handle = new BoxLiteStreamHandle(ws, 'boxlite:p_proj:exec_1', {
        preferSeqFrames: true,
        client,
        silenceTimeoutMs: 30,
        heartbeatIntervalMs: 10,
    });

    // SGR 鼠标事件 / X10 鼠标 / 方向键 / 翻页键：均不期待回显。
    handle.write('\x1b[<35;77;20M');
    handle.write('\x1b[M !!');
    handle.write('\x1b[O');
    handle.write('\x1b[6~');
    handle.write('\x1b[2~');
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(attachCalls, 0, 'mouse/escape input must not be treated as awaiting output');
    handle.kill();
});

test('expectsEcho classifies printable text vs escape sequences', () => {
    const { expectsEcho } = BoxLiteExecAdapter;
    assert.equal(expectsEcho('hello'), true);
    assert.equal(expectsEcho('hi\r'), true);
    assert.equal(expectsEcho('啊'), true);
    assert.equal(expectsEcho('\x1b[<35;77;20M'), false);
    assert.equal(expectsEcho('\x1b[M !!'), false);
    assert.equal(expectsEcho('\x1b[O'), false);
    assert.equal(expectsEcho('\x1b'), false);
    assert.equal(expectsEcho(''), false);
    assert.equal(expectsEcho(Buffer.from('abc')), true);
    assert.equal(expectsEcho(Buffer.from([0x1b, 0x5b, 0x41])), false);
});
