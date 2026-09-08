/**
 * multiRepoStatus — 聚合多仓库 git status
 *
 * 接收一个 repos 数组和 svcFactory (subPath → GitOperationService)，
 * 并发获取每个 repo 的 status 并附上 repo meta。
 *
 * 纯函数式封装，便于单测。
 */

/**
 * @param {Array<{id: string, subPath: string, role: string, isPrimary: boolean}>} repos
 * @param {(subPath: string) => Promise<{getStatus: () => Promise<object>}>} svcFactory
 * @returns {Promise<Array<{repoId, subPath, role, isPrimary, status: object}>>}
 */
async function getMultiRepoStatus(repos, svcFactory) {
  if (!Array.isArray(repos)) {
    throw new Error('repos must be an array');
  }
  if (typeof svcFactory !== 'function') {
    throw new Error('svcFactory must be a function');
  }
  return Promise.all(
    repos.map(async (repo) => {
      const svc = svcFactory(repo.subPath);
      const status = await svc.getStatus();
      return {
        repoId: repo.id,
        subPath: repo.subPath,
        role: repo.role,
        isPrimary: !!repo.isPrimary,
        status,
      };
    }),
  );
}

module.exports = { getMultiRepoStatus };
