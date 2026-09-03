const WebSocket = require('ws');
const fs = require('fs');

// 宿主控制面在 preview 就绪后写入沙箱的 blink 代理配置（BLINK_API_URL + BLINK_AUTH_TOKEN）。
// 沙箱后端进程通常在 preview 就绪前就已启动，无法用环境变量注入，改为每次请求前读该文件。
const BLINK_ENV_FILES = [
    '/workspace/server/.blink.env',
    '/workspace/.blink.env',
];

function readBlinkEnvFile() {
    for (const file of BLINK_ENV_FILES) {
        try {
            const text = fs.readFileSync(file, 'utf8');
            const out = {};
            for (const line of text.split('\n')) {
                const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
                if (m) out[m[1]] = m[2].trim();
            }
            return out;
        } catch {
            /* try next */
        }
    }
    return {};
}

function completeUtf8Length(buf) {
    if (buf.length === 0) return 0;
    let i = buf.length - 1;
    while (i >= 0 && (buf[i] & 0xC0) === 0x80) i--;
    if (i < 0) return 0;
    const byte = buf[i];
    let expectedLen;
    if (byte < 0x80) expectedLen = 1;
    else if ((byte & 0xE0) === 0xC0) expectedLen = 2;
    else if ((byte & 0xF0) === 0xE0) expectedLen = 3;
    else if ((byte & 0xF8) === 0xF0) expectedLen = 4;
    else return buf.length;
    const remaining = buf.length - i;
    if (remaining < expectedLen) return i;
    return buf.length;
}

function decodeExecutionFrameRaw(buf, seqFramed = true) {
    const channel = buf.length > 0 ? buf[0] : undefined;
    if (!seqFramed) {
        return {
            channel,
            payload: buf.length > 1 ? buf.slice(1) : Buffer.alloc(0),
            rseq: undefined,
        };
    }

    if (buf.length < 9) {
        return {
            channel,
            payload: Buffer.alloc(0),
            rseq: undefined,
        };
    }

    return {
        channel,
        payload: buf.slice(9),
        rseq: Number(buf.readBigUInt64BE(1)),
    };
}

function decodeExecutionFrame(buf, seqFramed = true) {
    const { channel, payload, rseq } = decodeExecutionFrameRaw(buf, seqFramed);
    return {
        channel,
        payload: payload.toString('utf8'),
        rseq,
    };
}

class BoxLiteClient {
    constructor() {
        // 优先读环境变量；未设置时回退到部署注入的 .blink.env 文件（宿主控制面在 preview 就绪后写入，
        // 使沙箱后端无需重启即可经宿主反向代理访问 blink-server，保持 boxlite 隔离）。
        const fileEnv = readBlinkEnvFile();
        this._base = (process.env.BLINK_API_URL || fileEnv.BLINK_API_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
        // 经宿主控制面反向代理访问 blink-server 时，附带 scoped token 供网关鉴权。
        // 宿主直连（无代理）时该变量为空，不附加任何头。
        this.authToken = (process.env.BLINK_AUTH_TOKEN || fileEnv.BLINK_AUTH_TOKEN || '').trim();
    }

    // base 用 getter 懒解析：沙箱后端进程在 preview 就绪前就已启动（.blink.env 尚未写入），
    // 每次拼 URL 前读一次文件，确保进程启动后才注入的代理配置能生效，无需重启后端。
    get base() {
        this._refreshFromFile();
        return this._base;
    }

    set base(value) {
        this._base = value;
    }

    // 懒刷新：环境变量未配置时，重读 .blink.env（文件在进程启动后才由宿主写入）。
    // 带 1s 缓存，避免宿主每次 blink 请求都同步读两个不存在的文件（宿主无 .blink.env）。
    _refreshFromFile() {
        if (process.env.BLINK_API_URL && process.env.BLINK_AUTH_TOKEN) return;
        const now = Date.now();
        if (this._lastFileReadAt && now - this._lastFileReadAt < 1000) return;
        this._lastFileReadAt = now;
        const fileEnv = readBlinkEnvFile();
        if (!process.env.BLINK_API_URL && fileEnv.BLINK_API_URL) {
            this._base = String(fileEnv.BLINK_API_URL).replace(/\/$/, '');
        }
        if (!process.env.BLINK_AUTH_TOKEN && fileEnv.BLINK_AUTH_TOKEN) {
            this.authToken = String(fileEnv.BLINK_AUTH_TOKEN).trim();
        }
    }

    _authHeaders() {
        return this.authToken ? { 'x-blink-token': this.authToken } : {};
    }

    /**
     * fetch wrapper with timeout. Prevents a single blink-server request
     * from blocking indefinitely when the server's worker threads are
     * exhausted (e.g. multiple VMs failing guest_connect with 30s timeout).
     *
     * Default timeout: 35s (covers blink's 30s guest_connect + overhead).
     * openSession uses 60s to allow for VM boot + init.
     */
    async _fetch(url, options = {}, timeoutMs = 35000) {
        this._refreshFromFile();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                ...options,
                headers: { ...this._authHeaders(), ...(options.headers || {}) },
                signal: controller.signal,
            });
            return res;
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error(`blink request timeout after ${timeoutMs}ms: ${url}`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    parseExecutionStreamRef(streamRef) {
        const match = /^boxlite:([^:]+):([^:]+)$/.exec(String(streamRef || ''));
        if (!match) return null;
        return { sessionName: match[1], execId: match[2] };
    }

    buildExecutionAttachUrl(sessionName, execId, options = {}) {
        const url = new URL(
            `${this.base}/api/sessions/${encodeURIComponent(sessionName)}/executions/${encodeURIComponent(execId)}/attach`
        );
        if (options.seq != null) {
            url.searchParams.set('seq', String(options.seq));
        }
        if (options.after != null) {
            url.searchParams.set('after', String(options.after));
        }
        return `${url.pathname}${url.search}`;
    }

    createExecutionAttachWebSocket(sessionName, execId, options = {}) {
        this._refreshFromFile();
        const attachUrl = this.buildExecutionAttachUrl(sessionName, execId, options);
        // attachUrl 是含 /preview/<id>/__blink 前缀的相对 pathname；这里只取 origin 再拼接，
        // 避免 base 本身也带 /preview/<id>/__blink 时前缀重复（嵌套部署 attach 404 的根因）。
        const baseUrl = new URL(this.base);
        const wsOrigin = `${baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${baseUrl.host}`;
        const wsUrl = wsOrigin + attachUrl;
        return new WebSocket(wsUrl, this.authToken ? { headers: this._authHeaders() } : undefined);
    }

    createExecutionAttachWebSocketFromStreamRef(streamRef, options = {}) {
        const parsed = this.parseExecutionStreamRef(streamRef);
        if (!parsed) {
            throw new Error(`Invalid BoxLite streamRef: ${streamRef}`);
        }
        return this.createExecutionAttachWebSocket(parsed.sessionName, parsed.execId, options);
    }

    async health() {
        const res = await this._fetch(`${this.base}/api/health`, {}, 5000);
        if (!res.ok) throw new Error(`blink health ${res.status}`);
        return res.json();
    }

    async product() {
        const res = await this._fetch(`${this.base}/api/product`, {}, 5000);
        if (!res.ok) return {};
        return res.json();
    }

    async openSession(name, image, warm = false, options = {}) {
        const body = { name };
        if (image) body.image = image;
        if (warm) body.warm = true;
        if (Array.isArray(options.volumes) && options.volumes.length > 0) {
            body.volumes = options.volumes.map((volume) => ({
                host_path: volume.host_path,
                guest_path: volume.guest_path,
                read_only: !!volume.read_only,
            }));
        }
        if (options.network) {
            body.network = {
                mode: options.network.mode || 'enabled',
                allow_net: Array.isArray(options.network.allow_net) ? options.network.allow_net : [],
            };
        }
        if (options.resources && Object.keys(options.resources).length > 0) {
            body.resources = options.resources;
        }
        const res = await this._fetch(`${this.base}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, 60000);
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`open session failed: ${res.status} ${t}`);
        }
        return res.json();
    }

    async getSessionStatus(name) {
        const res = await this._fetch(`${this.base}/api/sessions/${encodeURIComponent(name)}`, {}, 10000);
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        return data?.session || null;
    }

    async deleteSession(name) {
        if (!name) return;
        await this.stopSession(name).catch(() => {});
        const res = await this._fetch(`${this.base}/api/sessions/${encodeURIComponent(name)}`, {
            method: 'DELETE',
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`delete session failed: ${res.status} ${t}`);
        }
    }

    async stopSession(name) {
        if (!name) return;
        const res = await this._fetch(`${this.base}/api/sessions/${encodeURIComponent(name)}/stop`, {
            method: 'POST',
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`stop session failed: ${res.status} ${t}`);
        }
        return res.json().catch(() => ({}));
    }

    async spawn(sessionName, spec) {
        const res = await this._fetch(`${this.base}/api/sessions/${encodeURIComponent(sessionName)}/spawn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(spec || {}),
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`spawn failed: ${res.status} ${t}`);
        }
        return res.json();
    }

    createAttachWebSocket(attachUrl) {
        this._refreshFromFile();
        const wsUrl = this.base.replace(/^http/, 'ws') + attachUrl;
        return new WebSocket(wsUrl, this.authToken ? { headers: this._authHeaders() } : undefined);
    }

    async execForResult(sessionName, command, args = [], env = {}, workingDir = null, options = {}) {
        const spec = {
            command,
            args: args || [],
            env: env || {},
            tty: false,
            working_dir: workingDir || undefined,
        };
        const spawned = await this.spawn(sessionName, spec);
        const ws = this.createExecutionAttachWebSocket(sessionName, spawned.execution_id, { seq: 1, after: 0 });
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let outputBytes = 0;
            let settled = false;
            const maxBuffer = options.maxBuffer || 2 * 1024 * 1024;
            const timeoutMs = options.timeoutMs || 120000;
            const decoders = { 0x01: new TextDecoder('utf-8'), 0x02: new TextDecoder('utf-8') };
            const fail = (error) => {
                if (settled) return;
                settled = true;
                try { ws.send(JSON.stringify({ type: 'signal', signal: 15 })); } catch (_) {}
                try { ws.close(); } catch (_) {}
                reject(error);
            };
            const done = (code) => {
                if (settled) return;
                settled = true;
                stdout += decoders[0x01].decode();
                stderr += decoders[0x02].decode();
                try { ws.close(); } catch (_) {}
                resolve({ exitCode: code ?? 0, stdout, stderr });
            };
            ws.on('message', (data, isBinary) => {
                if (isBinary) {
                    const buf = Buffer.from(data);
                    const decoded = decodeExecutionFrameRaw(buf, true);
                    if (decoded.channel === 0x01 || decoded.channel === 0x02) {
                        const str = decoders[decoded.channel].decode(decoded.payload, { stream: true });
                        outputBytes += Buffer.byteLength(str);
                        if (outputBytes > maxBuffer) {
                            const error = new Error('Command output exceeded maxBuffer');
                            error.statusCode = 504;
                            fail(error);
                            return;
                        }
                        if (decoded.channel === 0x01) stdout += str;
                        else stderr += str;
                    }
                } else {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.type === 'exit') {
                            done(msg.exit_code);
                        } else if (msg.type === 'error') {
                            fail(new Error(msg.message || 'blink exec error'));
                        }
                    } catch (_) {}
                }
            });
            ws.on('error', (e) => {
                fail(e);
            });
            ws.on('close', () => done(-1));
            setTimeout(() => {
                if (!settled) {
                    const error = new Error(`Command timed out after ${timeoutMs}ms`);
                    error.statusCode = 504;
                    fail(error);
                }
            }, timeoutMs);
        });
    }

    async createCheckpoint(name, snapshot) {
        const res = await this._fetch(`${this.base}/api/sessions/${encodeURIComponent(name)}/checkpoints`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ snapshot: snapshot || `snap_${Date.now()}` }),
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`checkpoint failed: ${res.status} ${t}`);
        }
        return res.json();
    }

    async restoreCheckpoint(name, snapshot) {
        const res = await this._fetch(`${this.base}/api/sessions/${encodeURIComponent(name)}/checkpoints/${encodeURIComponent(snapshot)}/restore`, {
            method: 'POST',
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`restore failed: ${res.status} ${t}`);
        }
        return res.json();
    }

    async exportSession(name) {
        const res = await this._fetch(`${this.base}/api/sessions/${encodeURIComponent(name)}/export`, { method: 'POST' });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`export failed: ${res.status} ${t}`);
        }
        return res.json();
    }

    async importSession(archiveBuffer, suggestedName = null) {
        const form = new FormData();
        const fname = suggestedName || 'import.boxlite';
        const blob = new Blob([Buffer.from(archiveBuffer)]);
        form.append('archive', blob, fname);
        if (suggestedName) {
            form.append('name', suggestedName);
        }
        const res = await this._fetch(`${this.base}/api/import`, {
            method: 'POST',
            body: form,
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`import failed: ${res.status} ${t}`);
        }
        return res.json();
    }
}

module.exports = BoxLiteClient;
module.exports.decodeExecutionFrame = decodeExecutionFrame;
module.exports.decodeExecutionFrameRaw = decodeExecutionFrameRaw;
