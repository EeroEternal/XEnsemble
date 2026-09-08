/**
 * ProjectRepoService — project_repos 表 CRUD (多仓库项目)
 *
 * 依赖注入 db (drizzle) 与 schema 以便单测 stub。
 * 业务规则：
 *   - 同一 project 的 sub_path 唯一
 *   - isPrimary=true 时自动取消同 project 其他 repo 的 isPrimary
 *   - removeRepo 删除 isPrimary=true 时自动把最早创建的剩余 repo 升级为 primary
 */

const crypto = require('crypto');
const { eq, and, asc } = require('drizzle-orm');

// subPath 校验：1+ 段、'/' 分隔，禁止特殊字符与 . / ..
// （多仓库挂载点为 /workspace/<subPath>，典型值如 'frontend'、'backend'）
const INVALID_SEGMENT_CHARS = /[\\:*?"<>|\x00-\x1f]/;

function normalizeSubPath(subPath) {
    if (typeof subPath !== 'string') return null;
    const trimmed = subPath.trim().replace(/^\/+|\/+$/g, '');
    if (!trimmed) return null;
    const segs = trimmed.split('/').filter(Boolean);
    if (segs.length === 0) return null;
    for (const s of segs) {
        if (INVALID_SEGMENT_CHARS.test(s) || s === '.' || s === '..') return null;
    }
    return segs.join('/');
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

class ProjectRepoService {
  /**
   * @param {object} deps
   * @param {object} deps.db - drizzle db instance
   * @param {object} [deps.schema] - { projectRepos: pgTable } schema module (optional if projectReposTable provided)
   * @param {object} [deps.projectReposTable] - 直接传 pgTable 实例
   */
  constructor(deps = {}) {
    if (!deps.db) throw new Error('db is required');
    const table = deps.projectReposTable || (deps.schema && deps.schema.projectRepos);
    if (!table) {
      throw new Error('projectReposTable (or schema.projectRepos) is required');
    }
    this.db = deps.db;
    this.projectRepos = table;
  }

  /**
   * 添加一个 repo 到 project
   * @param {object} input
   * @param {string} input.projectId
   * @param {string} input.role
   * @param {string} input.subPath - 路径 (如 'a/b/c')
   * @param {string} input.repoProvider
   * @param {string} input.repoUrl
   * @param {string} [input.repoDefaultBranch='main']
   * @param {boolean} [input.isPrimary=false]
   * @param {string} [input.remoteRepoId]
   * @param {string} [input.remoteFullName]
   * @param {string} [input.repoInstallationRef]
   * @param {string} [input.repoTokenSecretRef]
   * @returns {Promise<object>}
   */
  async addRepo(input) {
    const { projectId, role, subPath: subPathInput, repoProvider, repoUrl } = input || {};
    if (!projectId || !role || !subPathInput || !repoProvider || !repoUrl) {
      throw new Error('projectId, role, subPath, repoProvider, repoUrl are required');
    }
    const subPath = normalizeSubPath(subPathInput);
    if (!subPath) {
      throw new Error(`Invalid subPath: "${subPathInput}". Must be 1+ segments separated by "/" with no special characters`);
    }
    const now = Date.now();
    const isPrimary = !!input.isPrimary;
    if (isPrimary) {
      await this.db.update(this.projectRepos)
        .set({ isPrimary: false, updatedAt: now })
        .where(eq(this.projectRepos.projectId, projectId));
    }
    const row = {
      id: newId('pr'),
      projectId,
      role,
      subPath,
      repoProvider,
      repoUrl,
      repoDefaultBranch: input.repoDefaultBranch || 'main',
      repoInstallationRef: input.repoInstallationRef || null,
      repoTokenSecretRef: input.repoTokenSecretRef || null,
      isPrimary,
      currentBranch: input.currentBranch || null,
      cloneStatus: 'pending',
      cloneError: null,
      remoteRepoId: input.remoteRepoId || null,
      remoteFullName: input.remoteFullName || null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(this.projectRepos).values(row);
    return row;
  }

  async listByProject(projectId) {
    return this.db.select().from(this.projectRepos)
      .where(eq(this.projectRepos.projectId, projectId))
      .orderBy(asc(this.projectRepos.createdAt));
  }

  async getById(id) {
    const rows = await this.db.select().from(this.projectRepos)
      .where(eq(this.projectRepos.id, id));
    return rows[0] || null;
  }

  async getBySubPath(projectId, subPath) {
    const rows = await this.db.select().from(this.projectRepos)
      .where(and(
        eq(this.projectRepos.projectId, projectId),
        eq(this.projectRepos.subPath, subPath),
      ));
    return rows[0] || null;
  }

  async setPrimary(projectId, repoId) {
    const now = Date.now();
    await this.db.update(this.projectRepos)
      .set({ isPrimary: false, updatedAt: now })
      .where(eq(this.projectRepos.projectId, projectId));
    await this.db.update(this.projectRepos)
      .set({ isPrimary: true, updatedAt: now })
      .where(and(
        eq(this.projectRepos.id, repoId),
        eq(this.projectRepos.projectId, projectId),
      ));
  }

  async updateCloneStatus(repoId, status, error = null) {
    await this.db.update(this.projectRepos)
      .set({ cloneStatus: status, cloneError: error, updatedAt: Date.now() })
      .where(eq(this.projectRepos.id, repoId));
  }

  /**
   * 删除一个 repo。如果删除的是 primary，自动把最早创建的剩余 repo 升级为 primary。
   * @param {string} id
   * @returns {Promise<void>}
   */
  async removeRepo(id) {
    const repo = await this.getById(id);
    if (!repo) return;
    const wasPrimary = repo.isPrimary;
    const projectId = repo.projectId;
    await this.db.delete(this.projectRepos).where(eq(this.projectRepos.id, id));
    if (wasPrimary) {
      const remaining = await this.db.select().from(this.projectRepos)
        .where(eq(this.projectRepos.projectId, projectId))
        .orderBy(asc(this.projectRepos.createdAt))
        .limit(1);
      if (remaining[0]) {
        await this.setPrimary(projectId, remaining[0].id);
      }
    }
  }
}

module.exports = { ProjectRepoService };
