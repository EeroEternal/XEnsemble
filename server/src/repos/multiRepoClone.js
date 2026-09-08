/**
 * multiRepoClone — 多仓库导入的后台 clone 编排
 *
 * 布局约定：仅 repos.length > 1 的项目使用子目录布局（projectDir/<subPath>）；
 * primary repo 走完整流程（runtime provision + clone + work branch + scaffold），
 * 非 primary repo 并发简单 clone，各自回写 project_repos.clone_status。
 *
 * 看门狗：每个仓库的 clone 有硬超时（防止任何一步挂起导致项目永远停在
 * cloning，前端导入进度无限转圈）；超时把该 repo 状态置为 failed，
 * 底层 git 进程若最终完成则目录保留，可用 Changes 面板查看实际状态。
 */

const path = require('path');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { GitOperationService } = require('../github/GitOperationService');
const { ProjectRepoService } = require('./ProjectRepoService');

// 单仓库 clone 的硬超时（含 runtime provision / fetch / checkout 全程）
const CLONE_TIMEOUT_MS = Number(process.env.MULTI_REPO_CLONE_TIMEOUT_MS || 10 * 60_000);

function withTimeout(promiseFactory, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    });
    return Promise.race([promiseFactory(), timeout]).finally(() => clearTimeout(timer));
}

async function clonePrimary(project, primary, opts) {
    const { baseBranch, workBranchName, autoCreateBranch } = opts;
    const svc = new ProjectRepoService({ db, projectReposTable: schema.projectRepos });
    try {
        await withTimeout(async () => {
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
            // scaffold 写 primary 仓库根（多仓库布局下 projectDir 根不是 git 仓，
            // autoCommitOnExit 的 git 提交只对 <subPath> 仓库有意义）
            const { scaffoldXEnsembleWithFs } = require('../repositories/RepositoryEnvironmentService');
            const scaffoldRoot = path.join(ready.hostWorkspacePath || ready.workspacePath, primary.subPath);
            await scaffoldXEnsembleWithFs(scaffoldRoot, {
                baseBranch: baseBranch || primary.repoDefaultBranch || 'main',
                autoCommitOnExit: true,
            });
        }, CLONE_TIMEOUT_MS, `primary repo "${primary.subPath}" clone`);
        await svc.updateCloneStatus(primary.id, 'ready', null);
    } catch (err) {
        await svc.updateCloneStatus(primary.id, 'failed', err.message);
    }
}

async function cloneSecondary(project, repo) {
    const svc = new ProjectRepoService({ db, projectReposTable: schema.projectRepos });
    const opSvc = new GitOperationService({ repoSubPath: repo.subPath });
    try {
        await withTimeout(async () => {
            await opSvc.cloneRepo(project, {
                repoUrl: repo.cloneUrl,
                branch: repo.repoDefaultBranch || 'main',
            });
        }, CLONE_TIMEOUT_MS, `repo "${repo.subPath}" clone`);
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
