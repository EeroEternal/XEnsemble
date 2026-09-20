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

// 回归：exec WS 断开重连期间（reattach 窗口）输入曾被静默丢弃——用户侧
// 表现为 TUI 输入框「打字无反应，刷新无效，重启会话才恢复」。现在输入
// 有界排队，重连成功后按序补发；无法送达时 write() 返回 false 供上层反馈。
test('BoxLiteStreamHandle.write queues input during reattach and flushes on reconnect', () => {
    const deadWs = makeWs();
    deadWs.readyState = 3; // CLOSED — reattach in flight
    const handle = new BoxLiteStreamHandle(deadWs, 'boxlite:p_proj:exec_3', { preferSeqFrames: true });

    const sent = [];
    const reconnected = makeWs();
    reconnected.readyState = 1;
    reconnected.send = (buf) => sent.push(Buffer.from(buf).toString());

    // While the exec WS is down, keystrokes are queued (not silently dropped).
    assert.equal(handle.write('a'), true);
    assert.equal(handle.write('\x1b[B'), true);
    assert.equal(sent.length, 0);

    handle._ws = reconnected;
    handle._flushPendingInput();
    assert.deepEqual(sent, ['a', '\x1b[B']);

    // After the flush the queue is empty; writes on the live socket go direct.
    assert.equal(handle.write('b'), true);
    assert.deepEqual(sent, ['a', '\x1b[B', 'b']);
    handle.kill();
});

test('BoxLiteStreamHandle.write returns false when input must be dropped', () => {
    // Closed handle: input can never be delivered.
    const ws = makeWs();
    const handle = new BoxLiteStreamHandle(ws, 'boxlite:p_proj:exec_4', { preferSeqFrames: true });
    handle.kill();
    assert.equal(handle.write('x'), false);

    // Bounded queue: overflowing the limit drops the chunk and reports it.
    const deadWs = makeWs();
    deadWs.readyState = 3;
    const handle2 = new BoxLiteStreamHandle(deadWs, 'boxlite:p_proj:exec_5', {
        preferSeqFrames: true,
        pendingInputLimitBytes: 8,
    });
    assert.equal(handle2.write('12345678'), true);
    assert.equal(handle2.write('9'), false);
    handle2.kill();
});

test('BoxLiteStreamHandle detects a half-open exec channel in 60s (not 10 min)', () => {
    const ws = makeWs();
    const handle = new BoxLiteStreamHandle(ws, 'boxlite:p_proj:exec_6', { preferSeqFrames: true });
    assert.equal(handle._heartbeatTimeoutMs, 60000);
    handle.kill();
});
