// 进行中的一键部署注册表：供「中止部署」快速 abort 当前 auto-deploy。
// 每个 projectId 一条 { aborted }，verify agent 每轮检查；cancel 端点置 aborted + 停隧道。
const activeDeploys = new Map();

function registerDeploy(projectId) {
    activeDeploys.set(projectId, { aborted: false });
}

function unregisterDeploy(projectId) {
    activeDeploys.delete(projectId);
}

function isAborted(projectId) {
    return activeDeploys.get(projectId)?.aborted === true;
}

function abortDeploy(projectId) {
    const entry = activeDeploys.get(projectId);
    if (entry) entry.aborted = true;
}

module.exports = { registerDeploy, unregisterDeploy, isAborted, abortDeploy };
