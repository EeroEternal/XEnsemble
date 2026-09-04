const sessionManager = require('./SessionManager');
const transcriptStore = require('../runtime/TranscriptStore');
const { readScrollback } = require('../runtime/LocalScrollbackBuffer');

// 断线重连 delta 重放的字节上限：超限自动回退 readTail 锚点重放（终端直接
// 落在最新画面）。必须小于客户端 writeBuffer 积压上限（8MB），保证一次有界
// 重放永远不会撑爆客户端、不会触发二次自愈循环。
const DELTA_REPLAY_MAX_BYTES = Number(process.env.TRANSCRIPT_DELTA_REPLAY_MAX_BYTES) || 4 * 1024 * 1024;

function normalizeCursor(after) {
    const value = Number(after);
    return Number.isInteger(value) && value >= 0 ? value : 0;
}

async function resolveLiveSession(sessionId, options = {}) {
    const session = sessionManager.getSession(sessionId);
    if (session && sessionManager.isAlive(sessionId)) {
        return { ok: true, session, handle: session.handle };
    }

    const sessionRecord = options.sessionRecord || session || null;

    // If the session is still pending (being provisioned), wait for it
    // to become alive. The frontend sets alive=true on session creation,
    // but the server needs 30-60s to spawn the agent.
    if (sessionRecord?.status === 'pending') {
        const maxWaitMs = 120000;
        const pollMs = 2000;
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
            await new Promise((r) => setTimeout(r, pollMs));
            const polled = sessionManager.getSession(sessionId);
            if (polled && sessionManager.isAlive(sessionId)) {
                return { ok: true, session: polled, handle: polled.handle };
            }
        }
        return { ok: false, error: 'Session is still starting. Please wait and try again.' };
    }

    const canWake = typeof options.wakeSession === 'function';
    const recoverable = sessionRecord?.recoverable === true;
    // Wake when the session is idle OR when it's in memory but not alive
    // (e.g. the handle's WebSocket died but the DB status wasn't updated to 'idle'
    // because the onExit callback's DB update failed).
    const isIdle = sessionRecord?.status === 'idle' || session?.status === 'idle';
    const inMemoryButDead = Boolean(session) && !sessionManager.isAlive(sessionId);

    if (canWake && recoverable && (isIdle || inMemoryButDead)) {
        try {
            await options.wakeSession(sessionRecord);
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            return { ok: false, error: errorMsg || 'Failed to wake session' };
        }
        const revived = sessionManager.getSession(sessionId);
        if (revived && sessionManager.isAlive(sessionId)) {
            return { ok: true, session: revived, handle: revived.handle };
        }
        return {
            ok: false,
            error: 'Session wake failed. Please try again or restart the agent.',
        };
    }

    if (!sessionRecord && !session) {
        return {
            ok: false,
            error: 'Session not found. The backend may have restarted — use Restart to reconnect.',
        };
    }

    return {
        ok: false,
        error: 'This session has ended. Launch a new agent instead of reconnecting to an old one.',
    };
}

function applyTerminalMessage(handle, msg) {
    if (msg.type === 'input') {
        handle.write(msg.data);
        return;
    }
    if (msg.type === 'resize') {
        try {
            handle.resize(msg.cols, msg.rows);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            if (!/EBADF|ENOTTY|ioctl\(2\) failed|not open|Napi::Error/.test(errorMsg)) {
                console.error('PTY Resize Error:', errorMsg);
            }
        }
    }
}

/**
 * Subscribe to PTY output/metrics/exit for a session. Used by WS and HTTP (SSE) transports.
 * @param {string} sessionId
 * @param {(payload: object) => void} send
 * @returns {{ ok: boolean, cleanup: () => void, handle?: object }}
 */
async function subscribeTerminal(sessionId, send, options = {}) {
    const resolved = await resolveLiveSession(sessionId, options);
    if (!resolved.ok) {
        send({ type: 'error', data: resolved.error });
        return { ok: false, cleanup: () => {} };
    }

    const { session, handle } = resolved;
    const transcriptRef = session.transcriptRef || session.streamRef;
    const after = normalizeCursor(options.after);
    const chatOnly = options.chatOnly === true;
    let lastSentSeq = after;
    let replaying = true;
    let cleaned = false;
    let pendingExit = null;
    let replayComplete = false;
    const pendingLiveFrames = [];
    let subscribed = false;

    const maybeSend = (payload) => {
        if (cleaned) return;
        send(payload);
    };

    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (liveFlushTimer) { clearTimeout(liveFlushTimer); liveFlushTimer = null; }
        if (subscribed) {
            sessionManager.removeTerminalSubscriber(sessionId);
            subscribed = false;
        }
        offExit();
        offOutput();
    };

    const REPLAY_CHUNK_SIZE = 512 * 1024;

    const flushFrames = (frames) => {
        let batchedData = '';
        let lastBatchSeq = null;

        for (const frame of frames) {
            if (cleaned) break;
            if (frame.seq != null && frame.seq <= lastSentSeq) {
                continue;
            }
            if (frame.kind === 'exit') {
                if (batchedData) {
                    maybeSend({ type: 'output', data: batchedData, seq: lastBatchSeq ?? undefined });
                    batchedData = '';
                }
                pendingExit = frame;
                if (frame.seq != null) {
                    lastSentSeq = frame.seq;
                }
                continue;
            }
            if (frame.kind !== 'out') {
                if (frame.seq != null) {
                    lastSentSeq = frame.seq;
                }
                continue;
            }
            batchedData += frame.data;
            if (frame.seq != null) {
                lastSentSeq = frame.seq;
                lastBatchSeq = frame.seq;
            }
            if (batchedData.length >= REPLAY_CHUNK_SIZE) {
                maybeSend({ type: 'output', data: batchedData, seq: lastBatchSeq ?? undefined });
                batchedData = '';
            }
        }
        if (batchedData) {
            maybeSend({ type: 'output', data: batchedData, seq: lastBatchSeq ?? undefined });
        }
    };

    const drainPendingLive = () => {
        if (cleaned || pendingLiveFrames.length === 0) return;
        const frames = pendingLiveFrames.splice(0, pendingLiveFrames.length);
        flushFrames(frames);
    };

    const maybeFinalizeExit = () => {
        if (cleaned || !pendingExit) return;
        if (sessionManager.isAlive(sessionId)) {
            pendingExit = null;
            return;
        }
        const exitSeq = pendingExit.seq ?? 0;
        if (transcriptRef && pendingExit.seq != null && lastSentSeq < exitSeq) {
            const tail = transcriptStore.readFrom(transcriptRef, lastSentSeq);
            if (tail.length > 0) {
                flushFrames(tail);
            }
        }
        if (pendingExit.seq != null && lastSentSeq < exitSeq) {
            return;
        }
        maybeSend({
            type: 'exit',
            data: pendingExit.data?.code ?? null,
            seq: pendingExit.seq ?? undefined,
            message: `\r\n\x1b[33m[Session ended with code ${pendingExit.data?.code ?? 'unknown'}]\x1b[0m\r\n`,
        });
        cleanup();
    };

    const replayTranscript = async () => {
        let transcriptFrames = [];
        let omittedCount = 0;

        if (transcriptRef) {
            if (after > 0) {
                transcriptFrames = transcriptStore.readFrom(transcriptRef, after);
                // Delta 重放封顶：断线期间 agent 可能已产出大量输出（实测可到
                // 92KB/s），无上限的 delta 会把恢复中的客户端 tab 再次淹没
                // （"冻结→重连洪泛→再冻结"死循环）。超限即放弃 delta，改用
                // readTail 锚点重放——对全屏重绘 TUI，正确画面由"最近一次完整
                // 重绘 + 之后增量"决定，中间字节无关紧要，终端直接落在最新状态。
                let deltaBytes = 0;
                for (const f of transcriptFrames) {
                    deltaBytes += typeof f.data === 'string' ? f.data.length : 64;
                    if (deltaBytes > DELTA_REPLAY_MAX_BYTES) break;
                }
                if (deltaBytes > DELTA_REPLAY_MAX_BYTES) {
                    console.error(`[terminalBridge] delta replay from seq=${after} exceeds ${DELTA_REPLAY_MAX_BYTES} bytes, falling back to anchored tail replay`);
                    const tail = transcriptStore.readTail(transcriptRef);
                    transcriptFrames = tail.frames;
                    omittedCount = tail.omittedCount;
                }
            } else {
                const tail = transcriptStore.readTail(transcriptRef);
                transcriptFrames = tail.frames;
                omittedCount = tail.omittedCount;
            }
        }

        if (omittedCount > 0) {
            maybeSend({
                type: 'output',
                data: `\x1b[33m[${omittedCount} earlier messages truncated. Full history is preserved.]\x1b[0m\r\n`,
            });
        }

        if (transcriptFrames.length > 0) {
            flushFrames(transcriptFrames);
        } else if (transcriptRef && !transcriptStore.hasTranscript(transcriptRef)) {
            const scrollback = readScrollback(transcriptRef);
            if (scrollback) {
                maybeSend({ type: 'output', data: scrollback });
            }
        } else if (session.history) {
            // Legacy in-memory history fallback for live sessions before the transcript store was populated.
            maybeSend({ type: 'output', data: session.history });
        }
        replaying = false;
        replayComplete = true;
        drainPendingLive();
        maybeFinalizeExit();
    };

    sessionManager.addTerminalSubscriber(sessionId);
    subscribed = true;

    let liveBatch = [];
    let liveBatchScheduled = false;
    let liveFlushTimer = null;
    // Coalesce high-frequency TUI output (spinner/progress/token streaming)
    // into fewer WS messages. 8ms is shorter than a single 60fps frame
    // (16.67ms) so it cannot batch 60fps output; 33ms caps the effective
    // output rate at ~30fps, halving client terminal writes while staying
    // smooth for text and spinners. Tunable via TERMINAL_FLUSH_DELAY_MS.
    const LIVE_FLUSH_DELAY_MS = Number(process.env.TERMINAL_FLUSH_DELAY_MS) || 33;

    const flushLiveBatch = () => {
        liveFlushTimer = null;
        liveBatchScheduled = false;
        if (liveBatch.length === 0) return;
        const frames = liveBatch;
        liveBatch = [];
        let batchedData = '';
        let lastBatchSeq = null;
        for (const frame of frames) {
            if (cleaned) break;
            if (frame.seq != null && frame.seq <= lastSentSeq) continue;
            batchedData += frame.data;
            if (frame.seq != null) {
                lastSentSeq = frame.seq;
                lastBatchSeq = frame.seq;
            }
        }
        if (batchedData) {
            maybeSend({ type: 'output', data: batchedData, seq: lastBatchSeq ?? undefined });
        }
        maybeFinalizeExit();
    };

    const offOutput = chatOnly
        ? () => {}
        : sessionManager.subscribeOutput(sessionId, (frame) => {
            if (cleaned) return;
            if (replaying) {
                pendingLiveFrames.push(frame);
                return;
            }
            if (frame.seq != null && frame.seq <= lastSentSeq) {
                return;
            }
            liveBatch.push(frame);
            if (!liveBatchScheduled) {
                liveBatchScheduled = true;
                liveFlushTimer = setTimeout(flushLiveBatch, LIVE_FLUSH_DELAY_MS);
            }
        });

    const offExit = sessionManager.onExit(sessionId, (exitCode, exitSeq) => {
        pendingExit = {
            data: { code: exitCode },
            seq: exitSeq ?? null,
        };
        if (replayComplete) {
            maybeFinalizeExit();
        }
    });

    if (chatOnly) {
        // Chat-only mode: don't replay/send terminal output; only track exit so
        // the chat view can mark the session ended. The handle stays available
        // for sending input (applyTerminalMessage) via the returned handle.
        replayComplete = true;
        replaying = false;
        return { ok: true, cleanup, handle };
    }

    replayTranscript().catch((err) => {
        maybeSend({ type: 'error', data: err?.message || 'Failed to replay terminal transcript' });
        cleanup();
    });

    return { ok: true, cleanup, handle };
}

module.exports = {
    resolveLiveSession,
    applyTerminalMessage,
    subscribeTerminal,
};
