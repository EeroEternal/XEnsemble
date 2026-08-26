// 进行中的一键部署注册表：供「中止部署」快速 abort 当前 auto-deploy，
// 并统计每个用户"进行中的部署任务"数（配合 preview 配额做并发闸门）。
// 部署与 session 强绑定：每个 (projectId, sessionId) 一条 { userId, aborted, startedAt }，
// 多 session 并发部署时各自独立（同 project 不同 session 的部署互不干扰 abort）。
// 部署结束（finally）必须注销释放名额。
const activeDeploys = new Map();

function deployKey(projectId, sessionId) {
    return sessionId ? `${projectId}:${sessionId}` : projectId;
}

function registerDeploy(projectId, userId, sessionId) {
    activeDeploys.set(deployKey(projectId, sessionId), { userId, aborted: false, startedAt: Date.now() });
}

function unregisterDeploy(projectId, sessionId) {
    activeDeploys.delete(deployKey(projectId, sessionId));
}

function isAborted(projectId, sessionId) {
    return activeDeploys.get(deployKey(projectId, sessionId))?.aborted === true;
}

function abortDeploy(projectId, sessionId) {
    const entry = activeDeploys.get(deployKey(projectId, sessionId));
    if (entry) entry.aborted = true;
}

// 统计某用户当前进行中的部署任务数（用于 per-user 并发闸门）
function countByUser(userId) {
    let count = 0;
    for (const entry of activeDeploys.values()) {
        if (entry.userId === userId) count += 1;
    }
    return count;
}

// 该用户当前进行中的部署所属 projectId 列表（用于超限时提示"占用"哪些项目）
function listProjectIdsByUser(userId) {
    const ids = [];
    for (const [key, entry] of activeDeploys.entries()) {
        if (entry.userId === userId) {
            // key = projectId:sessionId 或 projectId
            const projectId = key.split(':')[0];
            if (projectId && !ids.includes(projectId)) ids.push(projectId);
        }
    }
    return ids;
}

// 该用户当前进行中的部署明细（projectId + sessionId），用于前端标记"占用并发额度"的会话
function listByUser(userId) {
    const items = [];
    for (const [key, entry] of activeDeploys.entries()) {
        if (entry.userId !== userId) continue;
        const parts = key.split(':');
        items.push({ projectId: parts[0], sessionId: parts[1] || null });
    }
    return items;
}

// 清理超过 maxAgeMs 仍残留的"进行中部署" entry。
// 正常部署结束会 finally 注销；部署进程异常退出（卡死/被杀）时 finally 可能不执行，
// 残留会导致 countByUser 偏大 → 并发闸门误报超限。由 lifecycle 定期调用。
function cleanupStale(maxAgeMs) {
    const now = Date.now();
    for (const [key, entry] of [...activeDeploys.entries()]) {
        if (now - (entry.startedAt || now) > maxAgeMs) activeDeploys.delete(key);
    }
}

module.exports = { registerDeploy, unregisterDeploy, isAborted, abortDeploy, countByUser, listProjectIdsByUser, listByUser, cleanupStale };
