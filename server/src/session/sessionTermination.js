const { parseLocalPid } = require('./reconcileRunningSessions');

/**
 * Best-effort cleanup of a session's underlying agent process when the
 * in-memory handle is missing (control-plane restart, orphaned DB row, etc.).
 */
async function terminateDetachedSessionProcess({
    session,
    runtime,
    waitForAgentExit,
    fastifyLog,
    signal = 'SIGTERM',
}) {
    if (!session) return { killed: false, reason: 'missing' };

    const streamRef = session.streamRef || null;
    const localPid = parseLocalPid(streamRef);
    if (localPid) {
        let signaled = false;
        try {
            process.kill(-localPid, signal);
            signaled = true;
        } catch (_) {
            try {
                process.kill(localPid, signal);
                signaled = true;
            } catch (err) {
                if (err.code !== 'ESRCH') {
                    fastifyLog?.warn?.(err, '[sessions] failed to signal detached local pid');
                }
            }
        }
        if (signaled && signal === 'SIGTERM') {
            await new Promise((r) => setTimeout(r, 500));
            try {
                process.kill(localPid, 0);
                try { process.kill(-localPid, 'SIGKILL'); } catch (_) {
                    try { process.kill(localPid, 'SIGKILL'); } catch (__) { /* ignore */ }
                }
            } catch (_) {
                // process already gone
            }
        }
        return { killed: signaled, reason: signaled ? 'local_pid' : 'pid_missing', pid: localPid };
    }

    const runtimeRef = session.runtimeRef || session.runtimeId || null;
    const agentId = session.agentId || null;
    if (runtimeRef && agentId && typeof waitForAgentExit === 'function' && runtime) {
        try {
            await waitForAgentExit(runtime, runtimeRef, agentId, { streamRef });
            return { killed: true, reason: 'runtime_pkill' };
        } catch (err) {
            fastifyLog?.warn?.(err, '[sessions] failed runtime agent cleanup');
            return { killed: false, reason: 'runtime_failed', error: err };
        }
    }

    return { killed: false, reason: 'no_process_ref' };
}

module.exports = {
    terminateDetachedSessionProcess,
};
