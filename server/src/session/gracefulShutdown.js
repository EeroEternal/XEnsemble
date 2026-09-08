const transcriptStore = require('../runtime/TranscriptStore');
const { stopSession } = require('./idleHibernate');

/**
 * Best-effort graceful shutdown for control-plane process exit.
 * Memory handles are stopped; durable session rows stay recoverable via DB.
 */
async function gracefulShutdownSessions({
    db,
    schema,
    runtime,
    sessionManager,
    workspaceShellManager,
    fastifyLog,
    activeWebSockets = new Set(),
    closeCode = 1001,
}) {
    for (const ws of [...activeWebSockets]) {
        try {
            if (ws.readyState === 1 /* OPEN */) ws.close(closeCode, 'server shutting down');
        } catch (_) { /* ignore */ }
    }

    if (typeof workspaceShellManager?.deleteAll === 'function') {
        try {
            workspaceShellManager.deleteAll();
        } catch (_) { /* ignore */ }
    } else if (workspaceShellManager?.shells) {
        for (const shellId of [...workspaceShellManager.shells.keys()]) {
            try {
                workspaceShellManager.delete?.(shellId);
            } catch (_) { /* ignore */ }
        }
    }

    const live = typeof sessionManager?.listSessions === 'function'
        ? sessionManager.listSessions()
        : [];
    // 每 session 的 stop 限时：boxlite stopSession 可能等待沙箱 hibernate/操作长时间未返回，
    // 导致 SIGTERM 后 shutdown 超时被强制 process.exit(1)（部署脚本 restart server 时
    // 实测 16:13:14 SIGTERM → 16:13:24 forcing exit，opencode 子进程被 SIGKILL，正在跑的
    // preview 部署直接中断）。限时后 shutdown 快速优雅退出（exit 0），部署/会话仍可断点续修。
    //
    // 持久化安全权衡：
    // - stopSession 第一步就先把 session 的 DB status 置 'idle'（idleHibernate.js），
    //   这是"可恢复"的关键状态，毫秒级完成，在 3s 限时内必然落库；waitForAgentExit/
    //   hibernate（15s/35s）即使被截断，恢复靠 DB idle + recoverRunningSessions，不丢状态。
    // - 对话记录 transcript 由下方 flushAllSync 在 stopSession 全部结束后同步落盘（不在
    //   限时内），且总超时已提到 30s（installProcessShutdownHooks 默认值），多个 session
    //   的 stop 限时不会挤占 transcript/close 的预算。
    const stopTimeoutMs = Number(process.env.SHUTDOWN_SESSION_STOP_TIMEOUT_MS || 3000);
    await Promise.all(live.map(async (session) => {
        try {
            await Promise.race([
                stopSession({
                    db,
                    schema,
                    runtime,
                    sessionManager,
                    session,
                    fastifyLog,
                }),
                new Promise((resolve) => setTimeout(resolve, stopTimeoutMs)),
            ]);
        } catch (err) {
            fastifyLog?.warn?.(err, `[shutdown] failed to stop session ${session?.id}`);
        }
    }));

    try {
        if (typeof transcriptStore.flushAllSync === 'function') {
            transcriptStore.flushAllSync();
        } else if (typeof transcriptStore._flushAllStates === 'function') {
            transcriptStore._flushAllStates();
        }
    } catch (err) {
        fastifyLog?.warn?.(err, '[shutdown] transcript flush failed');
    }
}

function installProcessShutdownHooks(fastify, { timeoutMs = 30_000, onShutdown } = {}) {
    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        fastify.log?.info?.(`[shutdown] received ${signal}, closing`);
        const timer = setTimeout(() => {
            fastify.log?.error?.('[shutdown] timed out; forcing exit');
            process.exit(1);
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        try {
            // Run optional pre-close shutdown work (e.g. graceful session stop)
            // before fastify.close() so the timeout covers the full sequence.
            if (typeof onShutdown === 'function') {
                await onShutdown();
            }
            await fastify.close();
            process.exit(0);
        } catch (err) {
            fastify.log?.error?.(err, '[shutdown] close failed');
            process.exit(1);
        }
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
    gracefulShutdownSessions,
    installProcessShutdownHooks,
};
