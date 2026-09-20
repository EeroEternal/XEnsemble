const { ExecAdapter, AgentSpawnError, StreamHandle } = require('./interfaces');
const BoxLiteClient = require('./BoxLiteClient');
const { decodeExecutionFrameRaw } = BoxLiteClient;

function quotePosixArg(input) {
    const s = String(input ?? '');
    if (s.length === 0) return "''";
    if (!/[\s'"\\$`\n\r\t;&|<>(){}[\]*?!]/.test(s)) return s;
    return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Find the byte index of the last complete UTF-8 character boundary.
 * Returns the length of the complete portion (may be < buf.length if
 * the buffer ends with an incomplete multi-byte sequence).
 */
function completeUtf8Length(buf) {
    if (buf.length === 0) return 0;
    // Scan backwards to find the start of the last character
    let i = buf.length - 1;
    // Skip continuation bytes (10xxxxxx = 0x80-0xBF)
    while (i >= 0 && (buf[i] & 0xC0) === 0x80) i--;
    if (i < 0) return 0; // all continuation bytes, can't decode
    const byte = buf[i];
    let expectedLen;
    if (byte < 0x80) expectedLen = 1;           // 0xxxxxxx
    else if ((byte & 0xE0) === 0xC0) expectedLen = 2;  // 110xxxxx
    else if ((byte & 0xF0) === 0xE0) expectedLen = 3;  // 1110xxxx
    else if ((byte & 0xF8) === 0xF0) expectedLen = 4;  // 11110xxx
    else return buf.length; // invalid leading byte, decode everything
    const remaining = buf.length - i;
    if (remaining < expectedLen) return i; // incomplete, cut here
    return buf.length; // complete
}

class BoxLiteStreamHandle extends StreamHandle {
    constructor(ws, streamRef, options = {}) {
        super();
        this._ws = ws;
        this._streamRef = streamRef;
        this._preferSeqFrames = options.preferSeqFrames !== false;
        this._dataCbs = [];
        this._exitCbs = [];
        this._closed = false;
        this._exited = false;
        this._exitCode = null;
        this._decoders = {};
        this._trailingFffd = {}; // per-channel: true if last output ended with stripped FFFD
        this._lastRseq = 0;
        this._reattaching = false;
        this._client = options.client || null;
        this._reattachDelayMs = options.reattachDelayMs || 1000;
        this._reattachMaxAttempts = options.reattachMaxAttempts || 3;
        this._reattachAttempts = 0;
        this._heartbeatTimer = null;
        // 半开连接检测窗口。此前默认 600000（10 分钟）：boxlite exec WS 僵死
        // （对端丢失但 TCP 未断）时，输入最长静默丢失 10 分钟才被发现，用户
        // 侧表现即「输入框打字无反应，刷新无效，重启会话才恢复」。ping 每
        // 10s 一次，60s 无 pong 即判定链路死亡并走重连/exit 流程。
        this._heartbeatTimeoutMs = options.heartbeatTimeoutMs || 60000;
        // Reattach 窗口内的输入缓冲（有界）：exec WS 断开重连期间（1~15s）
        // 键盘输入不再静默丢弃，重连成功后按序补发；超限丢弃并让 write()
        // 返回 false，由 terminalBridge → server 向客户端发 input_stalled。
        this._pendingInput = [];
        this._pendingInputBytes = 0;
        this._pendingInputLimit = options.pendingInputLimitBytes || 64 * 1024;

        this._setupWsListeners(ws);
    }

    _startHeartbeat(ws) {
        this._stopHeartbeat();
        let lastDataAt = Date.now();
        this._lastDataAt = lastDataAt;
        const check = () => {
            if (this._closed || this._reattaching) return;
            const elapsed = Date.now() - this._lastDataAt;
            if (elapsed > this._heartbeatTimeoutMs) {
                try { ws.close(); } catch (_) {}
                return;
            }
            try { ws.ping(); } catch (_) {}
        };
        this._heartbeatTimer = setInterval(check, 10000);
    }

    _stopHeartbeat() {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    }

    _setupWsListeners(ws) {
        this._lastDataAt = Date.now();
        this._startHeartbeat(ws);

        ws.on('pong', () => { this._lastDataAt = Date.now(); });
        ws.on('ping', () => { this._lastDataAt = Date.now(); });

        ws.on('message', (data, isBinary) => {
            this._lastDataAt = Date.now();
            if (isBinary) {
                const buf = Buffer.from(data);
                const decoded = decodeExecutionFrameRaw(buf, this._preferSeqFrames);
                const ch = decoded.channel;
                if (ch !== undefined) {
                    if (!this._decoders[ch]) this._decoders[ch] = new TextDecoder('utf-8');
                    let payload = this._decoders[ch].decode(decoded.payload, { stream: true });
                    // Workaround: blink server chunks PTY output at ~1024 bytes and
                    // replaces incomplete multi-byte sequences at chunk boundaries with
                    // U+FFFD. This produces visible garbage (��) at every chunk boundary.
                    // Pattern: frame N ends with FFFD, frame N+1 starts with FFFD.
                    // Fix: strip trailing FFFD from frame N and leading FFFD from frame N+1.
                    if (this._trailingFffd[ch]) {
                        payload = payload.replace(/^\uFFFD+/, '');
                        this._trailingFffd[ch] = false;
                    }
                    if (payload.endsWith('\uFFFD')) {
                        payload = payload.replace(/\uFFFD+$/, '');
                        this._trailingFffd[ch] = true;
                    }
                    if (decoded.rseq && decoded.rseq > this._lastRseq) {
                        this._lastRseq = decoded.rseq;
                    }
                    for (const cb of this._dataCbs) {
                        try { cb(payload, decoded.rseq, ch); } catch (_) {}
                    }
                }
            } else {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === 'exit') {
                        this._fireExit(msg.exit_code ?? 0);
                    } else if (msg.type === 'error') {
                        for (const cb of this._dataCbs) {
                            try { cb('\r\n[error: ' + (msg.message || '') + ']\r\n'); } catch (_) {}
                        }
                    }
                } catch (_) {}
            }
        });

        ws.on('close', () => {
            if (this._closed || this._reattaching) return;
            this._tryReattach();
        });

        ws.on('error', () => {
            if (this._closed || this._reattaching) return;
            this._tryReattach();
        });
    }

    _fireExit(exitCode) {
        if (this._exited) return;
        this._exited = true;
        this._exitCode = exitCode;
        this._stopHeartbeat();
        this._pendingInput = [];
        this._pendingInputBytes = 0;
        for (const cb of this._exitCbs) {
            try { cb({ exitCode }); } catch (_) {}
        }
    }

    _tryReattach() {
        if (this._closed || !this._client) {
            return;
        }
        this._reattaching = true;
        this._reattachAttempts++;
        if (this._reattachAttempts > this._reattachMaxAttempts) {
            this._reattaching = false;
            this._fireExit(-1);
            return;
        }

        const delay = this._reattachDelayMs * this._reattachAttempts;
        setTimeout(() => {
            if (this._closed) {
                this._reattaching = false;
                return;
            }
            try {
                const parsed = this._client.parseExecutionStreamRef(this._streamRef);
                if (!parsed) {
                    this._reattaching = false;
                    this._fireExit(-1);
                    return;
                }
                const newWs = this._client.createExecutionAttachWebSocket(
                    parsed.sessionName, parsed.execId,
                    { seq: 1, after: this._lastRseq },
                );
                const timer = setTimeout(() => {
                    try { newWs.close(); } catch (_) {}
                    this._reattaching = false;
                    this._tryReattach();
                }, 5000);
                newWs.once('open', () => {
                    clearTimeout(timer);
                    this._ws = newWs;
                    this._reattaching = false;
                    this._reattachAttempts = 0;
                    // 补发重连窗口内排队的键盘输入。
                    this._flushPendingInput();
                    // Don't clear _decoders: TextDecoder internal buffer may hold
                    // incomplete multi-byte bytes from the last frame before disconnect.
                    // Clearing would lose them and cause FFFD on the next frame.
                    this._setupWsListeners(newWs);
                });
                newWs.once('error', () => {
                    clearTimeout(timer);
                    this._reattaching = false;
                    this._tryReattach();
                });
            } catch {
                this._reattaching = false;
                this._fireExit(-1);
            }
        }, delay);
    }

    onData(callback) {
        this._dataCbs.push(callback);
        return { dispose: () => { this._dataCbs = this._dataCbs.filter((c) => c !== callback); } };
    }

    onExit(callback) {
        if (this._exited) {
            try { callback({ exitCode: this._exitCode }); } catch (_) {}
            return { dispose: () => {} };
        }
        this._exitCbs.push(callback);
        return { dispose: () => { this._exitCbs = this._exitCbs.filter((c) => c !== callback); } };
    }

    // 返回 true = 输入已送达（或已在重连窗口内排队）；false = 被丢弃。此前
    // WS 非 OPEN 时输入被静默丢弃、无任何反馈，TUI 输入框表现为「打字无
    // 反应」。返回值供 terminalBridge → server 向客户端发 input_stalled 提示。
    write(data) {
        if (this._closed || this._exited) return false;
        if (this._ws && this._ws.readyState === 1) {
            const payload = (typeof data === 'string' || data instanceof Uint8Array)
                ? Buffer.from(data)
                : data;
            try {
                this._ws.send(payload);
                return true;
            } catch (_) {
                return false;
            }
        }
        // WS 非 OPEN（正在重连）：有界排队，重连成功后按序补发。
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
        if (buf.length === 0) return true;
        if (this._pendingInputBytes + buf.length > this._pendingInputLimit) {
            return false;
        }
        this._pendingInput.push(buf);
        this._pendingInputBytes += buf.length;
        return true;
    }

    _flushPendingInput() {
        if (!this._ws || this._ws.readyState !== 1 || this._pendingInput.length === 0) return;
        const pending = this._pendingInput.splice(0);
        for (const buf of pending) {
            try {
                this._ws.send(buf);
            } catch (_) {
                // 发送中途新连接又断了：剩余部分（含当前帧）退回队列。
                const idx = pending.indexOf(buf);
                this._pendingInput = pending.slice(idx);
                break;
            }
        }
        this._pendingInputBytes = this._pendingInput.reduce((n, b) => n + b.length, 0);
    }

    resize(cols, rows) {
        if (this._ws && this._ws.readyState === 1) {
            try {
                this._ws.send(JSON.stringify({ type: 'resize', rows: Number(rows), cols: Number(cols) }));
            } catch (_) {}
        }
    }

    kill() {
        this._stopHeartbeat();
        try {
            if (this._ws && this._ws.readyState === 1) {
                this._ws.send(JSON.stringify({ type: 'signal', signal: 2 }));
            }
        } catch (_) {}
        // Do NOT close the WebSocket here — blink may terminate the exec
        // process (SIGHUP) when the control WS closes, preventing opencode
        // from running its graceful shutdown (SQLite WAL checkpoint).
        // waitForAgentExit (VM exec kill -INT) handles process termination.
        this._closed = true;
        this._pendingInput = [];
        this._pendingInputBytes = 0;
    }

    get pid() { return null; }
    get streamRef() { return this._streamRef; }
    async getMetrics() { return { cpu: 0, memory: 0 }; }
}

class BoxLiteExecAdapter extends ExecAdapter {
    constructor() {
        super();
        this.client = new BoxLiteClient();
    }

    async spawn(cmd, args, env, options = {}) {
        const blinkName = options.runtimeRef || null;
        if (!blinkName) {
            throw new AgentSpawnError('BoxLite spawn requires runtimeRef (blink session name)');
        }
        const working = options.cwd || '/workspace';
        const rawCmd = String(cmd || 'sh');
        const rawArgs = Array.isArray(args) ? args : [];
        const spec = {
            command: rawCmd,
            args: rawArgs,
            env: {
                LANG: 'C.UTF-8',
                LC_ALL: 'C.UTF-8',
                TERM: 'xterm-256color',
                COLUMNS: '120',
                LINES: '32',
                // boxlite 沙箱内 agent 以 root 运行：无此标记时 Claude Code 等 CLI
                // 会因「--dangerously-skip-permissions cannot be used with
                // root/sudo privileges」直接退出码 1（LoopTask headless 全挂的根因）。
                // IS_SANDBOX=1 是官方容器/VM 豁免标记；boxlite 为会话级 libkrun VM，
                // 满足其隔离前提。放在 ...env 之前，用户/网关侧仍可显式覆盖。
                IS_SANDBOX: '1',
                ...env,
            },
            tty: true,
            rows: 32,
            cols: 120,
            working_dir: working,
        };
        let spawned;
        try {
            spawned = await this.client.spawn(blinkName, spec);
        } catch (e) {
            throw new AgentSpawnError('BoxLite spawn failed: ' + e.message);
        }
        const execId = spawned.execution_id;
        const ws = this.client.createExecutionAttachWebSocket(blinkName, execId, { seq: 1, after: 0 });
        const streamRef = `boxlite:${blinkName}:${execId}`;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('boxlite attach timeout')), 15000);
            ws.once('open', () => { clearTimeout(timer); resolve(); });
            ws.once('error', (e) => { clearTimeout(timer); reject(e); });
        });
        return new BoxLiteStreamHandle(ws, streamRef, { preferSeqFrames: true, client: this.client });
    }

    async reattach(streamRef, options = {}) {
        const parsed = this.client.parseExecutionStreamRef(streamRef);
        if (!parsed) {
            throw new AgentSpawnError(`BoxLite reattach requires boxlite:<name>:<execId> streamRef, got ${streamRef}`);
        }
        const after = Number.isInteger(options.after) && options.after >= 0 ? options.after : 0;
        const ws = this.client.createExecutionAttachWebSocket(parsed.sessionName, parsed.execId, { seq: 1, after });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('boxlite attach timeout')), 15000);
            ws.once('open', () => { clearTimeout(timer); resolve(); });
            ws.once('error', (e) => { clearTimeout(timer); reject(e); });
        });
        return new BoxLiteStreamHandle(ws, streamRef, { preferSeqFrames: true, client: this.client });
    }

    async exec(cmd, args, env, options = {}) {
        const blinkName = options.runtimeRef || null;
        if (!blinkName) {
            throw new AgentSpawnError('BoxLite exec requires runtimeRef');
        }
        const working = options.cwd || '/workspace';
        return this.client.execForResult(
            blinkName,
            String(cmd || 'sh'),
            Array.isArray(args) ? args : [],
            env || {},
            working,
            {
                maxBuffer: options.maxBuffer,
                timeoutMs: options.timeoutMs,
            },
        );
    }
}

module.exports = BoxLiteExecAdapter;
module.exports.BoxLiteStreamHandle = BoxLiteStreamHandle;
