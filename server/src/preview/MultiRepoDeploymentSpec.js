/**
 * MultiRepoDeploymentSpec — 多仓库 deployment spec 的 preview 配置解析（纯函数）
 *
 * spec.previews: [{ repoId, name, port, path }] — 多仓库部署的多 preview 入口。
 * - buildMultiRepoSpec: 旧 spec.preview（单对象）→ previews[] 归一化（向后兼容）
 * - resolvePreviewByPath: 按路径前缀最长匹配选择 preview 入口；
 *   未匹配返回 null（不静默回退第一个，避免 /assets 等绝对路径打到错误应用），
 *   由调用方（preview gateway）决定回退 isPrimary repo 的 preview 或 404。
 *
 * 注意：gateway/twoStage 的多实例注册联动为后续任务（依赖 twoStage 为每 repo
 * 启动 dev server 并注册多端口）；本模块仅负责 spec 归一化与路由判定。
 */

function buildMultiRepoSpec(repos, baseSpec = {}) {
    if (!Array.isArray(baseSpec.previews) || baseSpec.previews.length === 0) {
        if (baseSpec.preview) {
            return { ...baseSpec, previews: [{ name: 'default', ...baseSpec.preview }] };
        }
        return { ...baseSpec, previews: [] };
    }
    return baseSpec;
}

function resolvePreviewByPath(previews, requestPath) {
    if (!Array.isArray(previews) || previews.length === 0) return null;
    // 按前缀长度倒序匹配（最长优先）
    const sorted = [...previews].sort((a, b) => (b.name?.length || 0) - (a.name?.length || 0));
    for (const p of sorted) {
        const prefix = `/${p.name}`;
        if (requestPath === prefix || requestPath.startsWith(`${prefix}/`)) {
            return p;
        }
    }
    return null;
}

/** 未命中前缀时的回退：primary repo 的 preview（无 primary 标记则取第一个）。 */
function resolveDefaultPreview(previews) {
    if (!Array.isArray(previews) || previews.length === 0) return null;
    return previews.find((p) => p.isPrimary) || previews[0] || null;
}

module.exports = { buildMultiRepoSpec, resolvePreviewByPath, resolveDefaultPreview };
