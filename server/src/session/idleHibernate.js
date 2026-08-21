const { eq } = require('drizzle-orm');
const { terminateDetachedSessionProcess } = require('./sessionTermination');

const AGENT_EXIT_TIMEOUT_MS = 5000;

async function waitForAgentExit(runtime, runtimeRef, agentId) {
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

    // Linux: iterate /proc to find and gracefully terminate agent processes.
    // macOS/other: fall back to pkill, which is the best available mechanism.
    const maxTries = 10;
    const script = isLinux
        ? [
            'for f in /proc/[0-9]*/cmdline; do',
            '  p=${f#/proc/}; p=${p%/cmdline}',
            '  [ "$p" = "$$" ] && continue',
            '  cat "$f" 2>/dev/null | tr "\\0" " " | grep -q "$1" && kill -TERM "$p" 2>/dev/null',
            'done',
            'i=0',
            `while [ $i -lt ${maxTries} ]; do`,
            '  found=0',
            '  for f in /proc/[0-9]*/cmdline; do',
            '    p=${f#/proc/}; p=${p%/cmdline}',
            '    [ "$p" = "$$" ] && continue',
            '    cat "$f" 2>/dev/null | tr "\\0" " " | grep -q "$1" && { found=1; break; }',
            '  done',
            '  [ "$found" = "0" ] && exit 0',
            '  sleep 0.5',
            '  i=$((i+1))',
            'done',
            'for f in /proc/[0-9]*/cmdline; do',
            '  p=${f#/proc/}; p=${p%/cmdline}',
            '  [ "$p" = "$$" ] && continue',
            '  cat "$f" 2>/dev/null | tr "\\0" " " | grep -q "$1" && kill -KILL "$p" 2>/dev/null',
            'done',
        ].join('\n')
        : [
            // macOS / non-Linux fallback: use pkill (matches by process name).
            // pkill exits 1 when no process matches, which is fine.
            `pkill -TERM -x "$1" 2>/dev/null || pkill -TERM -f "$1" 2>/dev/null || true`,
            'i=0',
            `while [ $i -lt ${maxTries} ]; do`,
            `  pgrep -x "$1" >/dev/null 2>&1 || pgrep -f "$1" >/dev/null 2>&1 || exit 0`,
            '  sleep 0.5',
            '  i=$((i+1))',
            'done',
            `pkill -KILL -x "$1" 2>/dev/null || pkill -KILL -f "$1" 2>/dev/null || true`,
        ].join('\n');

    try {
        await runtime.exec.exec('sh', ['-c', script, 'sh', agentCmd], {}, { runtimeRef, cwd: '/' });
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

async function maybeAutoCheckpointProject({ project, sessionId, fastifyLog, runtimeId }) {
    if (!project || project.workspaceMode !== 'git') return;
    try {
        const { GitOperationService } = require('../github/GitOperationService');
        const gitOps = new GitOperationService({ getToken: () => null, runtimeId });
        await gitOps.commitAll(project, `chore(xensemble): auto-checkpoint session ${sessionId}`);
    } catch (err) {
        fastifyLog?.warn?.(err, 'Failed to auto-checkpoint idle session');
    }
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
            const runtimeRef = live?.runtimeRef || live?.runtimeId || null;
            if (runtimeRef) {
                await waitForAgentExit(runtime, runtimeRef, live.agentId);
            }
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
        const projectRows = await db.select().from(schema.projects).where(eq(schema.projects.id, session.projectId));
        await maybeAutoCheckpointProject({ project: projectRows[0] || null, sessionId, fastifyLog, runtimeId: session.runtimeId });
    }

    const liveAfter = sessionManager.getSession(sessionId);
    try {
        await db.update(schema.sessions)
            .set({
                status: 'idle',
                streamRef: liveAfter?.streamRef || session.streamRef || null,
                stateDirRef: liveAfter?.stateDirRef || session.stateDirRef || null,
            })
            .where(eq(schema.sessions.id, sessionId));
    } catch (err) {
        fastifyLog?.warn?.(err, '[sessions] failed to persist idle status');
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
