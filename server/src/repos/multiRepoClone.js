/**
 * multiRepoClone — 多仓库导入的后台 clone 编排
 *
 * 布局约定：仅 repos.length > 1 的项目使用子目录布局（projectDir/<subPath>）；
 * primary repo 走完整流程（runtime provision + clone + work branch + scaffold），
 * 非 primary repo 并发简单 clone，各自回写 project_repos.clone_status。
 */

const { db } = require('../db/index');
const schema = require('../db/schema');
const { GitOperationService } = require('../github/GitOperationService');
const { ProjectRepoService } = require('./ProjectRepoService');

async function clonePrimary(project, primary, opts) {
    const { baseBranch, workBranchName, autoCreateBranch } = opts;
    const svc = new ProjectRepoService({ db, projectReposTable: schema.projectRepos });
    try {
        const { ensureProjectRuntime } = require('../runtime/RuntimeService');
        const primarySvc = new GitOperationService({ repoSubPath: primary.subPath });
        const ready = await ensureProjectRuntime(project);
        // Update the in-memory project object so that subsequent
        // _execGit -> ensureProjectRuntime calls use the fast path.
        if (ready?.runtime?.id) {
            project.defaultRuntimeId = ready.runtime.id;
        }
        await primarySvc.cloneRepo(project, {
            repoUrl: primary.cloneUrl,
            branch: baseBranch || primary.repoDefaultBranch || 'main',
        });
        if (autoCreateBranch && workBranchName) {
            await primarySvc.createBranch(project, workBranchName, baseBranch || primary.repoDefaultBranch || 'main');
        }
        const { scaffoldXEnsembleWithFs } = require('../repositories/RepositoryEnvironmentService');
        await scaffoldXEnsembleWithFs(ready.hostWorkspacePath || ready.workspacePath, {
            baseBranch: baseBranch || primary.repoDefaultBranch || 'main',
            autoCommitOnExit: true,
        });
        await svc.updateCloneStatus(primary.id, 'ready', null);
    } catch (err) {
        await svc.updateCloneStatus(primary.id, 'failed', err.message);
    }
}

async function cloneSecondary(project, repo) {
    const svc = new ProjectRepoService({ db, projectReposTable: schema.projectRepos });
    const opSvc = new GitOperationService({ repoSubPath: repo.subPath });
    try {
        await opSvc.cloneRepo(project, {
            repoUrl: repo.cloneUrl,
            branch: repo.repoDefaultBranch || 'main',
        });
        await svc.updateCloneStatus(repo.id, 'ready', null);
    } catch (err) {
        await svc.updateCloneStatus(repo.id, 'failed', err.message);
    }
}

/**
 * @param {object} project - 含 defaultRuntimeId 的 project row（会被原地更新）
 * @param {Array<{id, subPath, cloneUrl, repoDefaultBranch, isPrimary}>} repos
 * @param {{ baseBranch?: string, workBranchName?: string, autoCreateBranch?: boolean }} opts
 */
async function multiRepoClone(project, repos, opts = {}) {
    const primary = repos.find((r) => r.isPrimary) || repos[0];
    try {
        await clonePrimary(project, primary, opts);
    } catch (err) {
        // primary 失败不阻断 secondary clone（各自状态独立回写）
    }
    const secondaries = repos.filter((r) => r.id !== primary.id);
    if (secondaries.length > 0) {
        await Promise.all(secondaries.map((r) => cloneSecondary(project, r)));
    }
}

module.exports = { multiRepoClone };
