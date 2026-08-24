const { readScrollback, removeScrollback } = require('../runtime/LocalScrollbackBuffer');
const transcriptStore = require('../runtime/TranscriptStore');
const titleService = require('./titleService');

const TITLE_HISTORY_THRESHOLD = Number(process.env.SESSION_TITLE_HISTORY_THRESHOLD) || 2000;
const TITLE_DEBOUNCE_MS = Number(process.env.SESSION_TITLE_DEBOUNCE_MS) || 5000;
const TITLE_EXIT_MIN_HISTORY = 30;
const TITLE_FIRST_DELAY_MS = Number(process.env.SESSION_TITLE_FIRST_DELAY_MS) || 60000;
const TITLE_INPUT_COUNT_THRESHOLD = Number(process.env.SESSION_TITLE_INPUT_COUNT_THRESHOLD) || 10;
const MAX_OUTPUT_LISTENERS = Number(process.env.SESSION_MAX_OUTPUT_LISTENERS) || 5;

/**
 * SessionManager — 管理活跃 agent session 的 bridge handle 与转发缓存。
 *
 * handle 为 StreamHandle（见 runtime/interfaces.js），不再假设 node-pty；
 * 进程清理、平台差异等均由 handle.kill() 内部处理。
 * history 仅为控制面易失缓存，事实来源在 runtime 侧（见 Architecture.md 3.2）。
 */
class SessionManager {
    constructor() {
        this.sessions = new Map();
    }

    createSession(sessionId, handle, agentId, options = {}) {
        const prev = this.sessions.get(sessionId);
        // Detach the old session's exit listener so its onExit callback
        // (which closes over the NEW session object after replacement)
        // does not fire the full exit path and kill the new session.
        if (prev) {
            prev.hibernating = true;
            prev.status = 'exited';
            prev.exitListeners = new Set();
            prev.outputListeners = new Set();
        }
        const transcriptRef = options.transcriptRef || handle?.transcriptRef || handle?.streamRef || null;
        const session = {
            id: sessionId,
            handle,
            agentId,
            projectId: options.projectId || null,
            runtimeId: options.runtimeId || null,
            runtimeRef: options.runtimeRef || null,
            stateDirRef: options.stateDirRef || null,
            userId: options.userId || null,
            streamRef: handle?.streamRef || null,
            transcriptRef,
            createdAt: Date.now(),
            spawnedAt: Date.now(),
            crashCount: prev?.crashCount || 0,
            history: '',
            status: 'running',
            exitCode: null,
            exitSeq: null,
            exitListeners: new Set(),
            outputListeners: new Set(),
            activeTerminalSubscribers: 0,
            lastActivityAt: Date.now(),
            lastOutputAt: null,
            lastInputAt: null,
            lastAttachAt: null,
            hibernating: false,
            titleGenerated: false,
            titleTimeout: null,
            inputCount: 0,
        };

        transcriptStore.bindSession(sessionId, session.transcriptRef);
        session.history = this._loadInitialHistory(session.transcriptRef, session.streamRef);

        handle.onData((data, rseq) => {
            const now = Date.now();
            session.lastOutputAt = now;
            session.lastActivityAt = now;
            const frame = session.transcriptRef
                ? transcriptStore.append(session.transcriptRef, { kind: 'out', data, rseq })
                : null;
            session.history += data;
            // Keep only the most recent 32 KB in memory. The TranscriptStore
            // is the durable source of truth; this buffer only serves title
            // generation and short-lived initial-history loads.
            if (session.history.length > 32768) {
                session.history = session.history.slice(-32768);
            }
            if (session.outputListeners.size > 0) {
                const payload = { data, seq: frame?.seq ?? null, rseq: frame?.rseq ?? (rseq ?? null), kind: 'out' };
                const listeners = [...session.outputListeners];
                queueMicrotask(() => {
                    for (const listener of listeners) {
                        try { listener(payload); } catch (_) { /* ignore */ }
                    }
                });
            }
            this._scheduleTitleGeneration(sessionId);
        });

        handle.onExit(({ exitCode, signal }) => {
            if (session.hibernating) {
                session.handle = null;
                return;
            }
            session.status = 'exited';
            session.exitCode = exitCode ?? signal ?? null;
            const exitFrame = session.transcriptRef
                ? transcriptStore.append(session.transcriptRef, { kind: 'exit', data: { code: session.exitCode } })
                : null;
            session.exitSeq = exitFrame ? exitFrame.seq : null;
            this._maybeGenerateTitleOnExit(sessionId);
            for (const listener of session.exitListeners) {
                try { listener(session.exitCode, session.exitSeq); } catch (_) { /* ignore */ }
            }
            session.exitListeners.clear();
            session.outputListeners.clear();
        });

        this.sessions.set(sessionId, session);
        return session;
    }

    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }

    listSessions() {
        return [...this.sessions.values()];
    }

    isAlive(sessionId) {
        const session = this.sessions.get(sessionId);
        return Boolean(session && session.status === 'running' && session.handle);
    }

    onExit(sessionId, listener) {
        const session = this.sessions.get(sessionId);
        if (!session) return () => {};
        if (session.status === 'exited') {
            listener(session.exitCode, session.exitSeq);
            return () => {};
        }
        session.exitListeners.add(listener);
        return () => session.exitListeners.delete(listener);
    }

    subscribeOutput(sessionId, listener) {
        const session = this.sessions.get(sessionId);
        if (!session) return () => {};
        if (session.status !== 'running') return () => {};
        if (session.outputListeners.size >= MAX_OUTPUT_LISTENERS) return () => {};
        session.outputListeners.add(listener);
        return () => session.outputListeners.delete(listener);
    }

    touchActivity(sessionId, kind = 'activity', at = Date.now()) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        if (kind === 'input') {
            session.lastInputAt = at;
            session.inputCount = (session.inputCount || 0) + 1;
        } else if (kind === 'attach') {
            session.lastAttachAt = at;
        } else if (kind === 'output') {
            session.lastOutputAt = at;
        }
        session.lastActivityAt = Math.max(
            session.lastActivityAt || 0,
            session.lastOutputAt || 0,
            session.lastInputAt || 0,
            session.lastAttachAt || 0,
            at,
        );
        return session;
    }

    addTerminalSubscriber(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        session.activeTerminalSubscribers = (session.activeTerminalSubscribers || 0) + 1;
        this.touchActivity(sessionId, 'attach');
        return session.activeTerminalSubscribers;
    }

    removeTerminalSubscriber(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return 0;
        session.activeTerminalSubscribers = Math.max(0, (session.activeTerminalSubscribers || 0) - 1);
        return session.activeTerminalSubscribers;
    }

    hasTerminalSubscribers(sessionId) {
        const session = this.sessions.get(sessionId);
        return Boolean(session && (session.activeTerminalSubscribers || 0) > 0);
    }

    beginHibernate(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        session.hibernating = true;
        return session;
    }

    completeHibernate(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        session.status = 'idle';
        session.handle = null;
        session.exitListeners.clear();
        session.outputListeners.clear();
        session.activeTerminalSubscribers = 0;
        return session;
    }

    cancelHibernate(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        session.hibernating = false;
        session.status = 'running';
        return session;
    }

    forceClear(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        session.status = 'idle';
        session.handle = null;
        session.hibernating = false;
        session.exitListeners.clear();
        session.outputListeners.clear();
        session.activeTerminalSubscribers = 0;
        return session;
    }

    deleteSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            if (session.titleTimeout) {
                clearTimeout(session.titleTimeout);
                session.titleTimeout = null;
            }
            if (session.handle) {
                try {
                    session.handle.kill();
                } catch (e) {
                    console.error(`Kill process error: ${e.message}`);
                }
            }
            try {
                const transcriptRef = session.transcriptRef;
                if (transcriptRef && typeof transcriptRef === 'string') {
                    transcriptStore.remove(transcriptRef);
                }
                const scrollbackRefs = new Set([
                    session.handle?.streamRef,
                    session.streamRef,
                    transcriptRef,
                ]);
                for (const ref of scrollbackRefs) {
                    if (ref && typeof ref === 'string' && ref.startsWith('local:')) {
                        removeScrollback(ref);
                    }
                }
            } catch (e) {
                console.error(`Remove transcript error: ${e.message}`);
            }
        }
        this.sessions.delete(sessionId);
    }

    _loadInitialHistory(transcriptRef, legacyStreamRef) {
        if (!transcriptRef && !legacyStreamRef) return '';
        const transcriptFrames = transcriptRef ? transcriptStore.readFrom(transcriptRef, 0) : [];
        if (transcriptFrames.length > 0) {
            return transcriptFrames
                .filter((frame) => frame.kind === 'out' || frame.kind === 'in')
                .map((frame) => (typeof frame.data === 'string' ? frame.data : ''))
                .join('');
        }
        if (typeof legacyStreamRef === 'string' && legacyStreamRef.startsWith('local:')) {
            return readScrollback(legacyStreamRef);
        }
        return '';
    }

    _scheduleTitleGeneration(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session || session.titleGenerated) return;
        const elapsed = Date.now() - (session.createdAt || 0);
        if (elapsed < TITLE_FIRST_DELAY_MS) return;
        const historyEnough = session.history.length >= TITLE_HISTORY_THRESHOLD;
        const inputEnough = (session.inputCount || 0) >= TITLE_INPUT_COUNT_THRESHOLD;
        if (!historyEnough && !inputEnough) return;

        if (session.titleTimeout) {
            clearTimeout(session.titleTimeout);
        }
        session.titleTimeout = setTimeout(() => {
            session.titleTimeout = null;
            titleService.generateSessionTitle(sessionId)
                .then((title) => {
                    if (title) session.titleGenerated = true;
                })
                .catch((err) => {
                    console.error(`Generate session title error: ${err.message}`);
                });
        }, TITLE_DEBOUNCE_MS);
    }

    _maybeGenerateTitleOnExit(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session || session.titleGenerated) return;
        const elapsed = Date.now() - (session.createdAt || 0);
        if (elapsed < TITLE_FIRST_DELAY_MS) return;
        if ((session.history || '').length < TITLE_EXIT_MIN_HISTORY) return;

        titleService.generateSessionTitle(sessionId)
            .then((title) => {
                if (title) session.titleGenerated = true;
            })
            .catch((err) => {
                console.error(`Generate session title on exit error: ${err.message}`);
            });
    }
}

module.exports = new SessionManager();
