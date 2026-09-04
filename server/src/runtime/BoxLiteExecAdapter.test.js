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

test('BoxLiteExecAdapter.exec defaults to uid 1000 (setpriv injected for workspace identity)', async () => {
    const adapter = new BoxLiteExecAdapter();
    let observed = null;
    adapter.client = {
        async execForResult(...args) {
            observed = args;
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };

    await adapter.exec('npm', ['install'], {}, { runtimeRef: 'rt-x', cwd: '/workspace' });

    // execForResult 签名：(sessionName, command, args, env, working, options)
    // observed[0]=sessionName, [1]=command, [2]=args。
    // 注入后：command='setpriv'，args 数组头部是 --reuid/--regid/--clear-groups，
    // 后面跟原 command + 原 args。
    assert.equal(observed[0], 'rt-x');
    assert.equal(observed[1], 'setpriv');
    assert.deepEqual(observed[2], [
        '--reuid=1000',
        '--regid=1000',
        '--clear-groups',
        'npm',
        'install',
    ]);
});

test('BoxLiteExecAdapter.exec skips setpriv when options.uid is 0 (system ops)', async () => {
    const adapter = new BoxLiteExecAdapter();
    let observed = null;
    adapter.client = {
        async execForResult(...args) {
            observed = args;
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };

    await adapter.exec('apt-get', ['install', '-y', 'postgresql'], {}, {
        runtimeRef: 'rt-x', cwd: '/workspace', uid: 0, gid: 0,
    });

    // 系统操作必须 root：透传原 command/args，不注入 setpriv。
    assert.equal(observed[0], 'rt-x');
    assert.equal(observed[1], 'apt-get');
    assert.deepEqual(observed[2], ['install', '-y', 'postgresql']);
});

test('BoxLiteExecAdapter.exec respects custom uid/gid (non-1000)', async () => {
    const adapter = new BoxLiteExecAdapter();
    let observed = null;
    adapter.client = {
        async execForResult(...args) {
            observed = args;
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };

    await adapter.exec('sh', ['-c', 'whoami'], {}, {
        runtimeRef: 'rt-x', cwd: '/workspace', uid: 2000, gid: 2001,
    });

    assert.equal(observed[0], 'rt-x');
    assert.equal(observed[1], 'setpriv');
    assert.deepEqual(observed[2], [
        '--reuid=2000',
        '--regid=2001',
        '--clear-groups',
        'sh',
        '-c',
        'whoami',
    ]);
});
