const fs = require('fs');
const path = require('path');
const { eq } = require('drizzle-orm');

const { WORKSPACE_ROOT } = require('../workspace');
const schema = require('../db/schema');

const VALID_KINDS = new Set(['out', 'in', 'resize', 'exit']);
const META_UPDATE_INTERVAL_MS = Number(process.env.TRANSCRIPT_META_UPDATE_INTERVAL_MS) || 2000;
const META_UPDATE_INTERVAL_SEQ = Number(process.env.TRANSCRIPT_META_UPDATE_INTERVAL_SEQ) || 50;
const FLUSH_INTERVAL_MS = Number(process.env.TRANSCRIPT_FLUSH_INTERVAL_MS) || 100;
const FLUSH_SIZE_BYTES = Number(process.env.TRANSCRIPT_FLUSH_SIZE_BYTES) || 65536;
const MAX_FRAMES = Number(process.env.TRANSCRIPT_MAX_FRAMES) || 50000;
const TAIL_BYTES = Number(process.env.TRANSCRIPT_TAIL_BYTES) || 1048576;
const ALT_SCREEN_TAIL_BYTES = Number(process.env.TRANSCRIPT_ALT_SCREEN_TAIL_BYTES) || 20971520;
const TAIL_READ_THRESHOLD = Number(process.env.TRANSCRIPT_TAIL_READ_THRESHOLD) || 67108864; // 64MB
const MAX_FILE_SIZE = Number(process.env.TRANSCRIPT_MAX_FILE_SIZE) || 134217728; // 128MB
const ROTATE_TAIL_BYTES = Number(process.env.TRANSCRIPT_ROTATE_TAIL_BYTES) || 33554432; // 32MB — keep last 32MB when rotating
const TUI_ENTER_RE = /\x1b\[\?(?:1049|47|1047)h|\x1b\[\?2026h/;

function safeRef(ref) {
    return String(ref || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function now() {
    return Date.now();
}

function bytesFor(kind, data) {
    if (typeof data === 'string') return Buffer.byteLength(data);
    if (kind === 'resize' || kind === 'exit') {
        return Buffer.byteLength(JSON.stringify(data ?? {}));
    }
    if (data == null) return 0;
    return Buffer.byteLength(String(data));
}

class TranscriptStore {
    constructor(options = {}) {
        this.workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
        this.db = options.db === undefined ? require('../db/index').db : options.db;
        this.schema = options.schema || schema;
        this.states = new Map();
    }

    transcriptDir() {
        return path.join(this.workspaceRoot, '.transcript');
    }

    transcriptPath(streamRef) {
        if (!streamRef) return null;
        return path.join(this.transcriptDir(), `${safeRef(streamRef)}.ndjson`);
    }

    ensureTranscriptDir() {
        const dir = this.transcriptDir();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * Read the last `maxBytes` of a file and parse NDJSON lines.
     * Used when the full file exceeds TAIL_READ_THRESHOLD to avoid
     * ERR_STRING_TOO_LONG on files > 512MB.
     */
    _readTailLines(file, maxBytes) {
        const stat = fs.statSync(file);
        const readSize = Math.min(stat.size, maxBytes);
        const offset = stat.size - readSize;
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(readSize);
            fs.readSync(fd, buf, 0, readSize, offset);
            let text = buf.toString('utf8');
            // First line may be incomplete (we started reading mid-line).
            const firstNewline = text.indexOf('\n');
            if (firstNewline >= 0 && offset > 0) {
                text = text.slice(firstNewline + 1);
            }
            const frames = [];
            for (const line of text.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const frame = JSON.parse(line);
                    if (!frame || typeof frame.seq !== 'number' || !VALID_KINDS.has(frame.kind)) continue;
                    frames.push(frame);
                } catch (_) { /* ignore malformed lines */ }
            }
            return frames;
        } finally {
            fs.closeSync(fd);
        }
    }

    _state(streamRef) {
        if (!streamRef) return null;
        let state = this.states.get(streamRef);
        if (state) return state;

        const file = this.transcriptPath(streamRef);
        const frames = [];
        let headSeq = 0;
        let bytes = 0;

        if (file && fs.existsSync(file)) {
            try {
                const stat = fs.statSync(file);
                if (stat.size > TAIL_READ_THRESHOLD) {
                    const tailFrames = this._readTailLines(file, TAIL_READ_THRESHOLD);
                    for (const frame of tailFrames) {
                        frames.push(frame);
                        headSeq = Math.max(headSeq, frame.seq);
                        bytes += Number(frame.bytes) || bytesFor(frame.kind, frame.data);
                    }
                } else {
                    const contents = fs.readFileSync(file, 'utf8');
                    for (const line of contents.split('\n')) {
                        if (!line.trim()) continue;
                        try {
                            const frame = JSON.parse(line);
                            if (!frame || typeof frame.seq !== 'number' || !VALID_KINDS.has(frame.kind)) continue;
                            frames.push(frame);
                            headSeq = Math.max(headSeq, frame.seq);
                            bytes += Number(frame.bytes) || bytesFor(frame.kind, frame.data);
                        } catch (_) {
                            // ignore malformed legacy lines
                        }
                    }
                }
                if (frames.length > MAX_FRAMES) {
                    const trimmed = frames.length - MAX_FRAMES;
                    frames.splice(0, trimmed);
                }
            } catch (_) {
                // treat unreadable files as empty
            }
        }

        state = {
            streamRef,
            file,
            frames,
            headSeq,
            bytes,
            nextSeq: headSeq + 1,
            sessionId: null,
            lastMetaWriteAt: 0,
            lastMetaWriteSeq: headSeq,
            dirtyMeta: false,
            exited: false,
            exitSeq: null,
            exitCode: null,
            _writeQueue: [],
            _flushTimer: null,
            _pendingBytes: 0,
        };
        this.states.set(streamRef, state);
        return state;
    }

    bindSession(sessionId, streamRef) {
        const state = this._state(streamRef);
        if (!state) return;
        state.sessionId = sessionId;
        this._writeSessionMeta(state, true);
    }

    append(streamRef, frame) {
        const state = this._state(streamRef);
        if (!state) {
            return null;
        }
        if (!VALID_KINDS.has(frame?.kind)) {
            throw new Error(`Unsupported transcript kind: ${frame?.kind}`);
        }
        const seq = state.nextSeq++;
        const stored = {
            seq,
            ts: now(),
            kind: frame.kind,
            data: frame.data,
            bytes: bytesFor(frame.kind, frame.data),
        };
        if (frame.kind === 'out' && Number.isInteger(frame.rseq) && frame.rseq >= 0) {
            stored.rseq = frame.rseq;
        }
        state.frames.push(stored);
        state.headSeq = seq;
        state.bytes += stored.bytes;
        if (state.frames.length > MAX_FRAMES) {
            state.frames.splice(0, state.frames.length - MAX_FRAMES);
        }
        if (frame.kind === 'exit') {
            state.exited = true;
            state.exitSeq = seq;
            state.exitCode = frame?.data?.code ?? null;
        }
        this._enqueueWrite(state, stored);
        this._maybeWriteSessionMeta(state, frame.kind === 'exit');
        return stored;
    }

    _syncFromFile(state) {
        if (!state?.file || !fs.existsSync(state.file)) return;
        try {
            let fileFrames;
            const stat = fs.statSync(state.file);
            if (stat.size > TAIL_READ_THRESHOLD) {
                fileFrames = this._readTailLines(state.file, TAIL_READ_THRESHOLD);
            } else {
                const contents = fs.readFileSync(state.file, 'utf8');
                fileFrames = [];
                for (const line of contents.split('\n')) {
                    if (!line.trim()) continue;
                    try {
                        const frame = JSON.parse(line);
                        if (!frame || typeof frame.seq !== 'number' || !VALID_KINDS.has(frame.kind)) continue;
                        fileFrames.push(frame);
                    } catch (_) { /* ignore malformed lines */ }
                }
            }
            const newFrames = fileFrames.filter((f) => f.seq > state.headSeq);
            if (newFrames.length === 0) return;
            for (const frame of newFrames) {
                state.frames.push(frame);
                state.headSeq = Math.max(state.headSeq, frame.seq);
                state.bytes += Number(frame.bytes) || bytesFor(frame.kind, frame.data);
                if (frame.kind === 'exit') {
                    state.exited = true;
                    state.exitSeq = frame.seq;
                    state.exitCode = frame?.data?.code ?? null;
                }
            }
            if (state.frames.length > MAX_FRAMES) {
                state.frames.splice(0, state.frames.length - MAX_FRAMES);
            }
            state.nextSeq = state.headSeq + 1;
        } catch (_) { /* best-effort */ }
    }

    readFrom(streamRef, afterSeq = 0) {
        const state = this._state(streamRef);
        if (!state) return [];
        this._syncFromFile(state);
        const cursor = Number(afterSeq) || 0;
        return state.frames.filter((frame) => frame.seq > cursor);
    }

    /**
     * Return frames for initial-load replay.
     *
     * TUI agents (opencode/cline/qwen) use alt screen (\x1b[?1049h) or
     * sync-term (\x1b[?2026h) for screen rendering. The replay must include
     * a TUI enter so the client enters the correct buffer mode.
     *
     * When the transcript spans multiple resume cycles (same storage_ref
     * reused across resumes), there are multiple TUI enters. We find the
     * LAST one — this ensures the replay ends at the latest terminal state
     * rather than an ancient session cycle. For full-screen redraw agents
     * (sync-term, e.g. qwen), each block is self-contained, so the last
     * block is the current screen. For incremental agents (alt-screen),
     * the last enter starts a fresh rendering session.
     *
     * Uses a generous byte cap (20MB) to prevent unbounded memory. When
     * trimming is needed, we trim from the FRONT (keep newest) so the
     * replay always ends at the latest terminal state.
     *
     * CLI agents (claude code) have neither — use byte-capped tail (1MB).
     *
     * Returns { frames, omittedCount }.
     */
    readTail(streamRef, maxBytes = TAIL_BYTES) {
        const state = this._state(streamRef);
        if (!state) return { frames: [], omittedCount: 0 };
        this._syncFromFile(state);
        if (state.frames.length === 0) {
            return { frames: [], omittedCount: 0 };
        }

        // Find the LAST TUI enter (alt-screen or sync-term).
        // Using the LAST instead of the FIRST ensures the replay includes
        // the latest terminal state when the transcript is large.
        let lastTuiEnterIdx = -1;
        for (let i = state.frames.length - 1; i >= 0; i--) {
            const f = state.frames[i];
            if (f.kind === 'out' && typeof f.data === 'string' && TUI_ENTER_RE.test(f.data)) {
                lastTuiEnterIdx = i;
                break;
            }
        }

        if (lastTuiEnterIdx >= 0) {
            return this._readTailFromIndex(state, lastTuiEnterIdx, ALT_SCREEN_TAIL_BYTES);
        }

        return this._readTailFromIndex(state, 0, maxBytes);
    }

    _readTailFromIndex(state, startIdx, maxBytes) {
        const tail = state.frames.slice(startIdx);
        let totalBytes = 0;
        for (const f of tail) {
            if (f.kind === 'out' && typeof f.data === 'string') totalBytes += f.data.length;
        }
        const omittedCount = startIdx;
        if (totalBytes <= maxBytes) {
            return { frames: tail, omittedCount };
        }
        // Trim from the FRONT to keep the newest content (latest terminal
        // state). Always keep the first frame (TUI enter) so the terminal
        // enters the correct buffer mode.
        let trimStart = 1;
        let keptBytes = totalBytes;
        while (trimStart < tail.length - 1 && keptBytes > maxBytes) {
            const f = tail[trimStart];
            if (f.kind === 'out' && typeof f.data === 'string') keptBytes -= f.data.length;
            trimStart++;
        }
        const trimmed = [tail[0]].concat(tail.slice(trimStart));
        return { frames: trimmed, omittedCount: omittedCount + trimStart - 1 };
    }

    head(streamRef) {
        const state = this._state(streamRef);
        if (!state) return 0;
        this._syncFromFile(state);
        return state.headSeq;
    }

    /**
     * Synchronously flush pending writes to disk for the given stream.
     * Useful for tests that need to read the transcript file immediately.
     */
    flushSync(streamRef) {
        const state = this._state(streamRef);
        if (state) {
            if (state._flushTimer) {
                clearTimeout(state._flushTimer);
                state._flushTimer = null;
            }
            this._flushWrites(state);
        }
    }

    bytes(streamRef) {
        const state = this._state(streamRef);
        return state ? state.bytes : 0;
    }

    hasTranscript(streamRef) {
        return this.head(streamRef) > 0;
    }

    exitInfo(streamRef) {
        const state = this._state(streamRef);
        if (!state || !state.exited) return null;
        return { code: state.exitCode, seq: state.exitSeq };
    }

    reattachCursor(streamRef) {
        const state = this._state(streamRef);
        if (!state) return 0;
        this._syncFromFile(state);

        // If the agent process has already exited (onExit appended an exit
        // frame), there is nothing to reattach to: attachSession would open a
        // WebSocket to a dead execution and immediately fire exit, so resume
        // would report running with no live process. Fall back to a fresh spawn.
        if (state.exited) return null;
        for (const frame of state.frames) {
            if (frame.kind === 'exit') return null;
        }

        let cursor = 0;
        let sawOut = false;
        for (const frame of state.frames) {
            if (frame.kind !== 'out') continue;
            if (!Number.isInteger(frame.rseq) || frame.rseq < 0) {
                return null;
            }
            sawOut = true;
            cursor = Math.max(cursor, frame.rseq);
        }

        return sawOut ? cursor : 0;
    }

    remove(streamRef) {
        const state = this.states.get(streamRef);
        if (state?._flushTimer) {
            clearTimeout(state._flushTimer);
            state._flushTimer = null;
        }
        if (state && state._writeQueue.length > 0) {
            this._flushWrites(state);
        }
        const file = state?.file || this.transcriptPath(streamRef);
        if (file && fs.existsSync(file)) {
            try {
                fs.unlinkSync(file);
            } catch (_) {
                // ignore
            }
        }
        if (state?.sessionId && this.db?.delete && this.schema?.sessionStreams) {
            void this.db.delete(this.schema.sessionStreams)
                .where(eq(this.schema.sessionStreams.sessionId, state.sessionId))
                .catch(() => {});
        }
        this.states.delete(streamRef);
    }

    _enqueueWrite(state, frame) {
        if (!state.file) return;
        state._writeQueue.push(frame);
        state._pendingBytes += frame.bytes;
        if (state._pendingBytes >= FLUSH_SIZE_BYTES) {
            this._flushWrites(state);
        } else if (!state._flushTimer) {
            this._scheduleFlush(state);
        }
    }

    _scheduleFlush(state) {
        if (state._flushTimer) return;
        state._flushTimer = setTimeout(() => {
            state._flushTimer = null;
            this._flushWrites(state);
        }, FLUSH_INTERVAL_MS);
    }

    _flushWrites(state) {
        if (!state.file || state._writeQueue.length === 0) return;
        if (!this.states.has(state.streamRef)) return;
        this.ensureTranscriptDir();
        const lines = state._writeQueue.map((frame) => `${JSON.stringify(frame)}\n`).join('');
        const count = state._writeQueue.length;
        state._writeQueue = [];
        state._pendingBytes = 0;
        try {
            fs.appendFileSync(state.file, lines);
        } catch (_) {
            // best-effort; retry on next flush
            state._writeQueue = state._writeQueue.concat(
                lines.split('\n').filter(Boolean).map((line) => JSON.parse(line))
            );
            state._pendingBytes = lines.length;
            this._scheduleFlush(state);
            return;
        }
        this._maybeRotateFile(state);
    }

    /**
     * When the file exceeds MAX_FILE_SIZE, rewrite it keeping only the
     * last ROTATE_TAIL_BYTES. Frames are re-sequenced starting from 1 so
     * seq numbers stay monotonic and never collide across resume cycles.
     * The in-memory `state.frames` array is rebuilt from the same tail.
     */
    _maybeRotateFile(state) {
        if (!state.file) return;
        let stat;
        try { stat = fs.statSync(state.file); } catch (_) { return; }
        if (stat.size < MAX_FILE_SIZE) return;

        const tailFrames = this._readTailLines(state.file, ROTATE_TAIL_BYTES);
        if (tailFrames.length === 0) return;

        // Re-sequence from 1
        const resequenced = [];
        for (let i = 0; i < tailFrames.length; i++) {
            const old = tailFrames[i];
            const frame = { ...old, seq: i + 1 };
            resequenced.push(frame);
        }
        const lines = resequenced.map((f) => `${JSON.stringify(f)}\n`).join('');

        try {
            const tmp = `${state.file}.rotate`;
            fs.writeFileSync(tmp, lines);
            fs.renameSync(tmp, state.file);
        } catch (_) { return; }

        // Rebuild in-memory state
        state.frames = resequenced;
        state.headSeq = resequenced.length;
        state.nextSeq = resequenced.length + 1;
        state.bytes = resequenced.reduce((sum, f) => sum + (Number(f.bytes) || bytesFor(f.kind, f.data)), 0);
        if (state.frames.length > MAX_FRAMES) {
            state.frames.splice(0, state.frames.length - MAX_FRAMES);
        }
    }

    _flushAllStates() {
        for (const state of this.states.values()) {
            if (state._flushTimer) {
                clearTimeout(state._flushTimer);
                state._flushTimer = null;
            }
            this._flushWrites(state);
        }
    }

    flushAllSync() {
        this._flushAllStates();
    }

    _maybeWriteSessionMeta(state, force) {
        if (!state.sessionId || !this.db) return;
        const shouldWrite = force
            || state.lastMetaWriteAt === 0
            || (now() - state.lastMetaWriteAt) >= META_UPDATE_INTERVAL_MS
            || (state.headSeq - state.lastMetaWriteSeq) >= META_UPDATE_INTERVAL_SEQ;
        if (!shouldWrite) return;
        this._writeSessionMeta(state, force);
    }

    _writeSessionMeta(state, force = false) {
        if (!state.sessionId || !this.db) return;
        state.lastMetaWriteAt = now();
        state.lastMetaWriteSeq = state.headSeq;
        const { sessionStreams } = this.schema;
        if (!sessionStreams) return;
        const payload = {
            sessionId: state.sessionId,
            headSeq: state.headSeq,
            bytes: state.bytes,
            storageRef: state.streamRef,
            updatedAt: state.lastMetaWriteAt,
        };
        const query = this.db
            .insert(sessionStreams)
            .values(payload)
            .onConflictDoUpdate({
                target: sessionStreams.sessionId,
                set: {
                    headSeq: payload.headSeq,
                    bytes: payload.bytes,
                    storageRef: payload.storageRef,
                    updatedAt: payload.updatedAt,
                },
            });
        void query.catch((err) => {
            console.error(`Transcript meta write failed: ${err.message}`);
        });
    }
}

const transcriptStore = new TranscriptStore();

process.on('beforeExit', () => {
    transcriptStore._flushAllStates();
});

module.exports = transcriptStore;
module.exports.TranscriptStore = TranscriptStore;
