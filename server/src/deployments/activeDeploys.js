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

module.exports = { registerDeploy, unregisterDeploy, isAborted, abortDeploy, countByUser };
