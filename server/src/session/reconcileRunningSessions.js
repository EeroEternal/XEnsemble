const { eq, inArray } = require('drizzle-orm');
const { isSessionRecoverable } = require('../agents/agentResume');

function parseLocalPid(streamRef) {
    if (typeof streamRef !== 'string' || !streamRef.startsWith('local:pty:')) {
        return null;
    }
    const idx = streamRef.lastIndexOf('_');
    if (idx === -1) return null;
    const pid = Number(streamRef.slice(idx + 1));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function defaultProcessExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM means the process exists but we lack permission to signal it.
        return err.code === 'EPERM';
    }
}

/**
 * Reconcile sessions whose DB status is still 'running' but whose underlying
 * process is no longer alive (or cannot be verified). Local Runtime stores the
 * PTY pid inside stream_ref as `local:pty:<ts>_<rand>_<pid>`; if the pid is
 * dead, the row is stale. BoxLite-backed `boxlite:` sessions are skipped here
 * because boot recovery is responsible for reattaching them. Rows without a
 * verifiable local stream_ref are treated as stale.
 *
 * @param {import('drizzle-orm/postgres-js').PostgresJsDatabase} db
 * @param {object} schema
 * @param {{ processExists?: (pid: number) => boolean }} [opts]
 * @returns {Promise<{ reconciled: number, ids: string[] }>}
 */
async function reconcileRunningSessions(db, schema, opts = {}) {
    const processExists = opts.processExists ?? defaultProcessExists;

    const running = await db
        .select({
            id: schema.sessions.id,
            agentId: schema.sessions.agentId,
            streamRef: schema.sessions.streamRef,
            stateDirRef: schema.sessions.stateDirRef,
            recoverable: schema.sessions.recoverable,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.status, 'running'));

    const staleIdleIds = [];
    const staleExitedIds = [];
    for (const row of running) {
        if (typeof row.streamRef === 'string' && row.streamRef.startsWith('boxlite:')) {
            continue;
        }
        const pid = parseLocalPid(row.streamRef);
        const alive = pid != null && processExists(pid);
        if (!alive) {
            if (isSessionRecoverable(row)) staleIdleIds.push(row.id);
            else staleExitedIds.push(row.id);
        }
    }

    if (staleIdleIds.length > 0) {
        await db
            .update(schema.sessions)
            .set({ status: 'idle' })
            .where(inArray(schema.sessions.id, staleIdleIds));
    }
    if (staleExitedIds.length > 0) {
        await db
            .update(schema.sessions)
            .set({ status: 'exited', exitedAt: Date.now() })
            .where(inArray(schema.sessions.id, staleExitedIds));
    }

    const ids = [...staleIdleIds, ...staleExitedIds];
    return { reconciled: ids.length, ids };
}

module.exports = { reconcileRunningSessions, parseLocalPid, defaultProcessExists };
