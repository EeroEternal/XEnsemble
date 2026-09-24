const { eq } = require('drizzle-orm');
const { terminateDetachedSessionProcess } = require('./sessionTermination');
const { parseLocalPid } = require('./reconcileRunningSessions');

const AGENT_EXIT_TIMEOUT_MS = 15000;

function isSharedHostRuntime(runtimeRef, streamRef) {
    if (runtimeRef === 'local') return true;
    return typeof streamRef === 'string' && streamRef.startsWith('local:pty:');
}

function pidExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err && err.code === 'EPERM';
    }
}

function signalPid(pid, signal) {
    try {
        process.kill(-pid, signal);
    } catch (_) {
        try { process.kill(pid, signal); } catch (__) { /* ESRCH / EPERM */ }
    }
}

async function waitForLocalPidExit(pid, timeoutMs = AGENT_EXIT_TIMEOUT_MS) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (!pidExists(pid)) return;
    signalPid(pid, 'SIGINT');
    const start = Date.now();
    let sentTerm = false;
    let sentKill = false;
    while (Date.now() - start < timeoutMs) {
        if (!pidExists(pid)) return;
        const elapsed = Date.now() - start;
        if (!sentTerm && elapsed >= 3000) {
            signalPid(pid, 'SIGTERM');
            sentTerm = true;
        }
        if (!sentKill && elapsed >= 8000) {
            signalPid(pid, 'SIGKILL');
            sentKill = true;
        }
        await new Promise((r) => setTimeout(r, 150));
    }
    if (pidExists(pid)) signalPid(pid, 'SIGKILL');
}

async function waitForAgentExit(runtime, runtimeRef, agentId, options = {}) {
    const streamRef = options.streamRef || null;
    const localPid = options.localPid || parseLocalPid(streamRef);
    if (localPid) {
        await waitForLocalPidExit(localPid, options.timeoutMs || AGENT_EXIT_TIMEOUT_MS);
        return;
    }
    // Local runtime shares the host with every other session. Name-based
    // pkill/grep would terminate sibling sessions running the same CLI
    // (their PTY exits → recoverable sessions flip to idle/"paused").
    if (isSharedHostRuntime(runtimeRef, streamRef)) {
        return;
    }
    if (!runtime?.exec?.exec || !runtimeRef || !agentId) {
        await new Promise((r) => setTimeout(r, 3000));
        return;
    }
    let agentCmd = agentId;
    try {
        const { DEFAULT_AGENTS } = require('../agents/defaultAgents');
        const agent = DEFAULT_AGENTS.find((a) => a.id === agentId);
        if (agent?.cmd) agentCmd = agent.cmd;
    } catch (_) {}

    const isLinux = (process.platform === 'linux');

    // Signal escalation: SIGINT (Ctrl+C, TUI graceful shutdown + DB checkpoint)
    // → SIGTERM → SIGKILL.  TUI agents like opencode only checkpoint their
    // SQLite state on SIGINT; SIGTERM kills them immediately and loses
    // uncommitted conversation history.
    // After the process exits, `sync` waits for all pending filesystem
    // writes (including SQLite WAL) to be flushed to disk before returning.
    const maxTries = 10;
    const script = isLinux
        ? [
            'for f in /proc/[0-9]*/cmdline; do',
            '  p=${f#/proc/}; p=${p%/cmdline}',
            '  [ "$p" = "$$" ] && continue',
            '  cat "$f" 2>/dev/null | tr "\\0" " " | grep -q "$1" && kill -INT "$p" 2>/dev/null',
            'done',
            'sleep 1',
            'i=0',
            `while [ $i -lt ${maxTries} ]; do`,
            '  found=0',
            '  for f in /proc/[0-9]*/cmdline; do',
            '    p=${f#/proc/}; p=${p%/cmdline}',
            '    [ "$p" = "$$" ] && continue',
            '    cat "$f" 2>/dev/null | tr "\\0" " " | grep -q "$1" && { found=1; break; }',
            '  done',
            `  [ "$found" = "0" ] && timeout 5 sync && exit 0`,
            '  sleep 0.5',
            '  i=$((i+1))',
            'done',
            'for f in /proc/[0-9]*/cmdline; do',
            '  p=${f#/proc/}; p=${p%/cmdline}',
            '  [ "$p" = "$$" ] && continue',
            '  cat "$f" 2>/dev/null | tr "\\0" " " | grep -q "$1" && kill -TERM "$p" 2>/dev/null',
            'done',
            'sleep 1',
            'for f in /proc/[0-9]*/cmdline; do',
            '  p=${f#/proc/}; p=${p%/cmdline}',
            '  [ "$p" = "$$" ] && continue',
            '  cat "$f" 2>/dev/null | tr "\\0" " " | grep -q "$1" && kill -KILL "$p" 2>/dev/null',
            'done',
            'timeout 5 sync',
        ].join('\n')
        : [
            `pkill -INT -x "$1" 2>/dev/null || pkill -INT -f "$1" 2>/dev/null || true`,
            'sleep 1',
            'i=0',
            `while [ $i -lt ${maxTries} ]; do`,
            `  pgrep -x "$1" >/dev/null 2>&1 || pgrep -f "$1" >/dev/null 2>&1 || { timeout 5 sync; exit 0; }`,
            '  sleep 0.5',
            '  i=$((i+1))',
            'done',
            `pkill -TERM -x "$1" 2>/dev/null || pkill -TERM -f "$1" 2>/dev/null || true`,
            'sleep 1',
            `pkill -KILL -x "$1" 2>/dev/null || pkill -KILL -f "$1" 2>/dev/null || true`,
            'timeout 5 sync',
        ].join('\n');

    try {
        await runtime.exec.exec('sh', ['-c', script, 'sh', agentCmd], {}, {
            runtimeRef, cwd: '/', timeoutMs: options.timeoutMs || AGENT_EXIT_TIMEOUT_MS,
        });
    } catch (_) {
        await new Promise((r) => setTimeout(r, 3000));
    }
}

function shouldHibernateSession(session, now, thresholdMs, supportsHibernate) {
    if (!supportsHibernate || thresholdMs <= 0) return false;
    if (!session || session.status !== 'running' || !session.handle) return false;
    if ((session.activeTerminalSubscribers || 0) > 0) return false;
    const lastActivityAt = Number(session.lastActivityAt || session.lastOutputAt || session.lastAttachAt || session.createdAt || 0);
    if (!Number.isFinite(lastActivityAt)) return false;
    return (now - lastActivityAt) > thresholdMs;
}

async function maybeAutoCheckpointProject() {
    // Auto-commit on session disconnect was removed — uncommitted changes
    // persist in the worktree and are available when the session resumes.
    // Pre-restore safety snapshots (LocalGitService.restoreCheckpoint) still
    // protect against destructive git reset --hard.
}

async function stopSession({
    db,
    schema,
    runtime,
    sessionManager,
    session,
    fastifyLog,
    requireRuntimeHibernate = false,
}) {
    if (!session) return { stopped: false, reason: 'missing' };

    const sessionId = session.id;
    const liveSession = sessionManager.getSession(sessionId);

    if (liveSession?.status === 'idle') {
        return { stopped: true, alreadyIdle: true, status: 'idle' };
    }

    if (requireRuntimeHibernate && !runtime?.provider?.supportsHibernate?.()) {
        return { stopped: false, reason: 'unsupported' };
    }

    if (!sessionManager.isAlive(sessionId)) {
        if (session.status === 'running' || session.status === 'idle') {
            let runtimeRef = session.runtimeRef || null;
            if (!runtimeRef && session.runtimeId && db && schema?.runtimes) {
                try {
                    const runtimeRows = await db.select().from(schema.runtimes)
                        .where(eq(schema.runtimes.id, session.runtimeId));
                    runtimeRef = runtimeRows[0]?.runtimeRef || null;
                } catch (_) { /* best-effort */ }
            }
            await terminateDetachedSessionProcess({
                session: { ...session, runtimeRef },
                runtime,
                waitForAgentExit,
                fastifyLog,
            });
            if (runtime?.provider?.supportsHibernate?.() && runtimeRef) {
                try {
                    await runtime.provider.hibernate(runtimeRef);
                } catch (err) {
                    fastifyLog?.warn?.(err, '[sessions] failed to hibernate detached runtime');
                }
            }
            if (session.status === 'running') {
                try {
                    await db.update(schema.sessions)
                        .set({
                            status: 'idle',
                            streamRef: session.streamRef || null,
                            stateDirRef: session.stateDirRef || null,
                            updatedAt: Date.now(),
                        })
                        .where(eq(schema.sessions.id, sessionId));
                } catch (err) {
                    fastifyLog?.warn?.(err, '[sessions] failed to persist idle status');
                }
            }
            return { stopped: true, detached: true, status: 'idle' };
        }
        return { stopped: false, reason: 'not_alive' };
    }

    sessionManager.beginHibernate(sessionId);
    try {
        const live = sessionManager.getSession(sessionId);
        if (live?.handle) {
            try {
                live.handle.kill();
            } catch (err) {
                fastifyLog?.warn?.(err, '[sessions] failed to kill session handle during stop');
            }
        }

        // Persist DB status to 'idle' BEFORE waitForAgentExit/hibernate.
        // gracefulShutdown's 10s timeout may fire process.exit(1) while
        // waitForAgentExit (15s) or hibernate (35s) is still running.
        // If DB stays 'running', recoverRunningSessions will reattach to
        // a dead execution and the exit event may be lost, leaving the
        // session in a false-alive state (display works, input silently dropped).
        // Updating DB first ensures the session is always recoverable as 'idle'.
        const liveBefore = sessionManager.getSession(sessionId);
        try {
            await db.update(schema.sessions)
                .set({
                    status: 'idle',
                    streamRef: liveBefore?.streamRef || session.streamRef || null,
                    stateDirRef: liveBefore?.stateDirRef || session.stateDirRef || null,
                    updatedAt: Date.now(),
                })
                .where(eq(schema.sessions.id, sessionId));
        } catch (err) {
            fastifyLog?.warn?.(err, '[sessions] failed to persist idle status');
        }

        const runtimeRef = live?.runtimeRef || live?.runtimeId || null;
        if (runtimeRef) {
            await waitForAgentExit(runtime, runtimeRef, live.agentId, {
                streamRef: live?.streamRef || session.streamRef || null,
            });
        }
        const rtRef = live?.runtimeRef || live?.runtimeId || live?.handle?.runtimeRef
            || session.runtimeRef || session.runtimeId || session.streamRef || null;
        if (runtime?.provider?.supportsHibernate?.() && rtRef) {
            await runtime.provider.hibernate(rtRef);
        }
    } catch (err) {
        if (fastifyLog?.warn) fastifyLog.warn(err, '[sessions] failed to stop session runtime');
        sessionManager.cancelHibernate(sessionId);
        return { stopped: false, reason: 'provider_failed', error: err };
    }

    if (session.projectId) {
        await maybeAutoCheckpointProject();
    }

    sessionManager.completeHibernate(sessionId);

    return { stopped: true, status: 'idle' };
}

async function hibernateSession(args) {
    const { session, sessionManager, runtime } = args;
    if (!session || !sessionManager.isAlive(session.id)) return { hibernated: false, reason: 'not_alive' };
    if (!runtime?.provider?.supportsHibernate?.()) return { hibernated: false, reason: 'unsupported' };
    const runtimeRef = session.runtimeRef || session.runtimeId || session.handle?.runtimeRef || session.streamRef;
    if (!runtimeRef) return { hibernated: false, reason: 'missing_runtime_ref' };

    const result = await stopSession({ ...args, requireRuntimeHibernate: true });
    if (!result.stopped) {
        return { hibernated: false, reason: result.reason, error: result.error };
    }
    return { hibernated: true };
}

function createIdleHibernateMonitor({
    db,
    schema,
    runtime,
    sessionManager,
    fastifyLog,
    idleThresholdMs,
    sweepIntervalMs,
    now = () => Date.now(),
}) {
    let timer = null;
    let stopped = false;
    const threshold = Number(idleThresholdMs);
    const interval = Number(sweepIntervalMs);
    const enabled = Number.isFinite(threshold) && threshold > 0;

    async function sweepOnce() {
        if (!enabled || stopped) {
            return { enabled, hibernated: 0 };
        }
        if (!runtime?.provider?.supportsHibernate?.()) {
            return { enabled, hibernated: 0, supported: false };
        }
        let hibernated = 0;
        const sessions = sessionManager.listSessions();
        for (const session of sessions) {
            if (!shouldHibernateSession(session, now(), threshold, true)) continue;
            const result = await hibernateSession({
                db,
                schema,
                runtime,
                sessionManager,
                session,
                fastifyLog,
            });
            if (result.hibernated) hibernated += 1;
        }
        return { enabled, hibernated, supported: true };
    }

    function start() {
        if (!enabled || timer || stopped) return;
        timer = setInterval(() => {
            sweepOnce().catch((err) => fastifyLog?.warn?.(err, '[sessions] idle hibernate sweep failed'));
        }, Number.isFinite(interval) && interval > 0 ? interval : 60000);
        if (typeof timer.unref === 'function') timer.unref();
    }

    function stop() {
        stopped = true;
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { start, stop, sweepOnce, enabled };
}

module.exports = {
    shouldHibernateSession,
    waitForAgentExit,
    stopSession,
    hibernateSession,
    createIdleHibernateMonitor,
};
