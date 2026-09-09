const crypto = require('crypto');
const { eq, and, isNull } = require('drizzle-orm');

const { db } = require('../db/index');
const schema = require('../db/schema');
const { recordEvent } = require('../events/recordEvent');
const { getProvider } = require('./providers/registry');
const { GitConnectionService, getProviderConfig } = require('./GitConnectionService');
const { GitOperationService } = require('./GitOperationService');
const { withProjectGitLock } = require('./gitMutationLock');

class MergeRequestService {
    constructor(deps = {}) {
        this.gitConnectionService = deps.gitConnectionService ?? new GitConnectionService();
        this.gitOperationService = deps.gitOperationService ?? new GitOperationService();
        // 多仓库：目标 project_repo 行（{ id, subPath, remoteFullName }）；单仓库/未指定 = null（用 project 主仓库字段）
        this.repo = deps.repo || null;
    }

    /** 当前操作目标仓库的 remoteFullName（多仓库取 repo 行，否则回退 project 主仓库字段）。 */
    _repoFullName(project) {
        return this.repo?.remoteFullName || project.remoteFullName || project.githubFullName;
    }

    /** 构造按 repo 过滤的 merge_requests 查询条件（单仓库用 repoId IS NULL，兼容存量数据）。 */
    _repoCond(projectId, providerName, num = null) {
        const conds = [
            eq(schema.mergeRequests.projectId, projectId),
            eq(schema.mergeRequests.provider, providerName),
        ];
        if (num != null) conds.push(eq(schema.mergeRequests.remoteMrNumber, num));
        if (this.repo?.id) {
            conds.push(eq(schema.mergeRequests.repoId, this.repo.id));
        } else {
            conds.push(isNull(schema.mergeRequests.repoId));
        }
        return and(...conds);
    }

    _generateId() {
        return `mr_${crypto.randomBytes(8).toString('hex')}`;
    }

    // 查询当前用户在 Git 平台上对该仓库的写权限（决定前端是否显示 merge/approve/close/reopen 等按钮）。
    // 用当前用户的 token 查仓库（GitHub/Gitea 的 permissions.push，GitLab 的 access_level），
    // 而不是项目 owner 的 token，这样无权限的用户就看不到对应的操作按钮。
    async getCurrentUserPermissions(project, currentUserId) {
        const providerName = project.repoProvider || 'github';
        if (!providerName || providerName === 'none' || providerName === 'local_git') return null;
        const repoFullName = this._repoFullName(project);
        if (!repoFullName) return null;
        const denied = { can_merge: false, can_approve: false, can_close: false, can_reopen: false, can_comment: true, can_edit: false };
        let token;
        try {
            token = await this.gitConnectionService.getDecryptedToken(currentUserId, providerName);
        } catch {
            // 未连接/未知 provider（如 URL 导入的仓库）：查询接口不应因此 500，按无权限处理
            return denied;
        }
        if (!token) return denied;
        const provider = getProvider(providerName);
        if (!provider || typeof provider.getRepo !== 'function') return denied;
        const config = await getProviderConfig(providerName);
        try {
            const info = await provider.getRepo(token, repoFullName, { apiBase: config?.apiBase });
            const perms = info?.permissions || {};
            let canWrite = false;
            if (providerName === 'gitlab') {
                const level = perms?.project_access?.access_level ?? perms?.group_access?.access_level ?? 0;
                canWrite = level >= 30; // Developer(30) 及以上可 merge/approve
            } else {
                canWrite = perms?.push === true || perms?.admin === true;
            }
            return {
                can_merge: canWrite,
                can_approve: canWrite,
                can_close: canWrite,
                can_reopen: canWrite,
                can_comment: true,
                can_edit: canWrite,
            };
        } catch (e) {
            return denied;
        }
    }

    _mapStatus({ state, merged }) {
        if (state === 'closed' && merged) return 'merged';
        if (state === 'closed') return 'closed';
        return 'open';
    }

    _sameBranch(a, b) {
        if (!a || !b) return false;
        const norm = (s) => String(s).replace(/^[^:]+:/, '').trim();
        return norm(a) === norm(b);
    }

    async _findLocalOpen(projectId, providerName, src, tgt) {
        const rows = await db.select().from(schema.mergeRequests)
            .where(this._repoCond(projectId, providerName));
        return rows.find((row) => row.status === 'open'
            && this._sameBranch(row.sourceBranch, src) && this._sameBranch(row.targetBranch, tgt)) || null;
    }

    async _findLocalOpenSynced(project, providerName, src, tgt) {
        const localOpen = await this._findLocalOpen(project.id, providerName, src, tgt);
        if (!localOpen) return null;

        const provider = getProvider(providerName);
        const config = await getProviderConfig(providerName);
        const repoFullName = this._repoFullName(project);
        const token = await this.gitConnectionService.getDecryptedToken(project.userId, providerName);
        try {
            const prInfo = await provider.getPR(token, repoFullName, localOpen.remoteMrNumber, {
                apiBase: config?.apiBase,
            });
            const mappedStatus = this._mapStatus({ state: prInfo.state, merged: prInfo.merged });
            if (mappedStatus !== 'open') {
                await db.update(schema.mergeRequests)
                    .set({
                        status: mappedStatus,
                        remoteState: prInfo.state,
                        mergeSha: prInfo.mergeCommitSha ?? null,
                        updatedAt: Date.now(),
                        lastSyncedAt: Date.now(),
                    })
                    .where(eq(schema.mergeRequests.id, localOpen.id));
                return null;
            }
        } catch { /* best-effort: treat as open if sync fails */ }
        return localOpen;
    }

    async _findRemoteOpen(provider, token, repoFullName, src, tgt, apiBase) {
        const open = await provider.listPRs(token, repoFullName, {
            state: provider.name === 'gitlab' ? 'opened' : 'open',
            perPage: 50,
            apiBase,
        });
        return open.find((pr) => this._sameBranch(pr.headRef, src) && this._sameBranch(pr.baseRef, tgt)) || null;
    }

    async _upsertFromRemote(project, providerName, prInfo, { title, body, src, tgt, actorUserId }) {
        const now = Date.now();
        const existingByNumber = await db.select().from(schema.mergeRequests)
            .where(this._repoCond(project.id, providerName, prInfo.number));
        if (existingByNumber[0]) {
            await db.update(schema.mergeRequests)
                .set({
                    remoteMrUrl: prInfo.url,
                    title: title || prInfo.title || existingByNumber[0].title,
                    description: body ?? prInfo.body ?? existingByNumber[0].description,
                    sourceBranch: src,
                    targetBranch: tgt,
                    status: this._mapStatus({ state: prInfo.state, merged: prInfo.merged }),
                    remoteState: prInfo.state,
                    mergeSha: prInfo.mergeCommitSha ?? null,
                    createdAt: prInfo.createdAt ?? existingByNumber[0].createdAt,
                    updatedAt: now,
                    lastSyncedAt: now,
                })
                .where(eq(schema.mergeRequests.id, existingByNumber[0].id));
            const rows = await db.select().from(schema.mergeRequests)
                .where(eq(schema.mergeRequests.id, existingByNumber[0].id));
            return rows[0];
        }

        const id = this._generateId();
        const record = {
            id,
            projectId: project.id,
            repoId: this.repo?.id ?? null,
            provider: providerName,
            remoteMrNumber: prInfo.number,
            remoteMrUrl: prInfo.url,
            title: title || prInfo.title || `${src} → ${tgt}`,
            description: body ?? prInfo.body ?? null,
            sourceBranch: src,
            targetBranch: tgt,
            status: this._mapStatus({ state: prInfo.state, merged: prInfo.merged }),
            remoteState: prInfo.state,
            mergeSha: prInfo.mergeCommitSha ?? null,
            createdBy: actorUserId ?? null,
            createdAt: prInfo.createdAt ?? now,
            updatedAt: now,
            lastSyncedAt: now,
        };
        await db.insert(schema.mergeRequests).values(record);
        return record;
    }

    async create(project, { title, body, sourceBranch, source_branch, targetBranch, target_branch }, actorUserId) {
        return withProjectGitLock(project.id, async () => {
            const providerName = project.repoProvider;
            if (!providerName || providerName === 'none' || providerName === 'local_git') {
                throw new Error('Project is not connected to an external Git provider');
            }

            const repoFullName = this._repoFullName(project);
            if (!repoFullName) throw new Error('Project does not have a remote repository identifier');

            const token = await this.gitConnectionService.getDecryptedToken(project.userId, providerName);
            const provider = getProvider(providerName);
            const config = await getProviderConfig(providerName);

            const src = sourceBranch || source_branch || project.currentBranch;
            const tgt = targetBranch || target_branch || project.repoDefaultBranch || 'main';
            if (!src) throw new Error('sourceBranch is required and project.currentBranch is not set');
            if (!title) throw new Error('title is required');

            const localOpen = await this._findLocalOpenSynced(project, providerName, src, tgt);
            if (localOpen) return localOpen;

            const remoteOpen = await this._findRemoteOpen(
                provider, token, repoFullName, src, tgt, config?.apiBase,
            );
            if (remoteOpen) {
                return this._upsertFromRemote(project, providerName, remoteOpen, {
                    title, body, src, tgt, actorUserId,
                });
            }

            // Before pushing, fetch the target branch and rebase the source
            // branch onto it. This ensures the PR is up-to-date and reduces
            // merge conflicts on the remote.
            try {
                await this.gitOperationService.fetchAndRebase(project, tgt);
            } catch (err) {
                if (err.code === 'rebase_conflict') {
                    throw err;
                }
                // Non-conflict rebase failures (e.g. network) are non-fatal —
                // proceed with push and let the remote reject if needed.
            }

            await this.gitOperationService.pushBranch(project, src);

            let prInfo;
            try {
                prInfo = await provider.createPR(token, repoFullName, {
                    title,
                    body,
                    head: src,
                    base: tgt,
                    apiBase: config?.apiBase,
                });
            } catch (err) {
                // Another client may have created the same PR between list and create.
                const raced = await this._findRemoteOpen(
                    provider, token, repoFullName, src, tgt, config?.apiBase,
                );
                if (!raced) throw err;
                return this._upsertFromRemote(project, providerName, raced, {
                    title, body, src, tgt, actorUserId,
                });
            }

            const record = await this._upsertFromRemote(project, providerName, prInfo, {
                title, body, src, tgt, actorUserId,
            });

            await recordEvent({
                userId: actorUserId ?? project.userId,
                projectId: project.id,
                subjectType: 'merge_request',
                subjectId: record.id,
                type: 'mr.created',
                data: {
                    provider: providerName,
                    remoteMrNumber: prInfo.number,
                    title,
                    sourceBranch: src,
                    targetBranch: tgt,
                },
            });

            return record;
        });
    }

    async sync(project, mrId) {
        const providerName = project.repoProvider;
        const repoFullName = this._repoFullName(project);
        if (!repoFullName) throw new Error('Project does not have a remote repository identifier');

        const token = await this.gitConnectionService.getDecryptedToken(project.userId, providerName);
        const provider = getProvider(providerName);
        const config = await getProviderConfig(providerName);

        const existingRows = await db.select().from(schema.mergeRequests)
            .where(eq(schema.mergeRequests.id, mrId));
        if (existingRows.length === 0) throw new Error('merge request not found');
        const existing = existingRows[0];

        const prInfo = await provider.getPR(token, repoFullName, existing.remoteMrNumber, {
            apiBase: config?.apiBase,
        });

        const now = Date.now();
        await db.update(schema.mergeRequests)
            .set({
                title: prInfo.title,
                description: prInfo.body ?? null,
                sourceBranch: prInfo.headRef ?? existing.sourceBranch,
                targetBranch: prInfo.baseRef ?? existing.targetBranch,
                status: this._mapStatus({ state: prInfo.state, merged: prInfo.merged }),
                remoteState: prInfo.state,
                mergeSha: prInfo.mergeCommitSha ?? null,
                createdAt: prInfo.createdAt ?? existing.createdAt,
                updatedAt: now,
                lastSyncedAt: now,
            })
            .where(eq(schema.mergeRequests.id, mrId));

        const rows = await db.select().from(schema.mergeRequests)
            .where(eq(schema.mergeRequests.id, mrId));
        return rows[0];
    }

    async list(projectId, { repoId } = {}) {
        const conds = [eq(schema.mergeRequests.projectId, projectId)];
        if (repoId) conds.push(eq(schema.mergeRequests.repoId, repoId));
        return db.select().from(schema.mergeRequests).where(and(...conds));
    }

    async syncAll(project) {
        const providerName = project.repoProvider;
        if (!providerName || providerName === 'none' || providerName === 'local_git') {
            return { synced: 0 };
        }
        const repoFullName = this._repoFullName(project);
        if (!repoFullName) return { synced: 0 };

        const ctx = await this._resolveProvider(project, null);
        if (!ctx) return { synced: 0 };

        // Fetch ALL states (open + closed + merged) so the list panel
        // doesn't go stale for merged/closed PRs.
        const remotePRs = await ctx.provider.listPRs(ctx.token, ctx.repoFullName, {
            state: 'all',
            perPage: 100,
            apiBase: ctx.apiBase,
        });

        let synced = 0;
        for (const prInfo of remotePRs) {
            await this._upsertFromRemote(project, providerName, prInfo, {
                title: prInfo.title,
                body: prInfo.body,
                src: prInfo.headRef,
                tgt: prInfo.baseRef,
                actorUserId: project.userId,
            });
            synced++;
        }

        return { synced };
    }

    async get(mrId) {
        const rows = await db.select().from(schema.mergeRequests)
            .where(eq(schema.mergeRequests.id, mrId));
        return rows[0] ?? null;
    }

    async _resolveProvider(project, mr) {
        const providerName = project.repoProvider || mr?.provider;
        if (!providerName || providerName === 'none' || providerName === 'local_git') return null;
        const repoFullName = this._repoFullName(project);
        if (!repoFullName) return null;
        let token;
        try {
            token = await this.gitConnectionService.getDecryptedToken(project.userId, providerName);
        } catch {
            return null;
        }
        const provider = getProvider(providerName);
        const config = await getProviderConfig(providerName);
        return { token, provider, repoFullName, apiBase: config?.apiBase };
    }

    async listReviews(project, mrId) {
        const mr = await this.get(mrId);
        if (!mr || mr.projectId !== project.id) return [];
        const ctx = await this._resolveProvider(project, mr);
        if (!ctx) return [];
        return ctx.provider.listReviews(ctx.token, ctx.repoFullName, mr.remoteMrNumber, { apiBase: ctx.apiBase });
    }

    async listReviewComments(project, mrId, opts = {}) {
        const mr = await this.get(mrId);
        if (!mr || mr.projectId !== project.id) return [];
        const ctx = await this._resolveProvider(project, mr);
        if (!ctx) return [];
        return ctx.provider.listReviewComments(ctx.token, ctx.repoFullName, mr.remoteMrNumber, { apiBase: ctx.apiBase, ...opts });
    }

    async listIssueComments(project, mrId, opts = {}) {
        const mr = await this.get(mrId);
        if (!mr || mr.projectId !== project.id) return [];
        const ctx = await this._resolveProvider(project, mr);
        if (!ctx) return [];
        return ctx.provider.listIssueComments(ctx.token, ctx.repoFullName, mr.remoteMrNumber, { apiBase: ctx.apiBase, ...opts });
    }

    async listMrFiles(project, mrId, opts = {}) {
        const mr = await this.get(mrId);
        if (!mr || mr.projectId !== project.id) return [];
        const ctx = await this._resolveProvider(project, mr);
        if (!ctx) return [];
        return ctx.provider.listMrFiles(ctx.token, ctx.repoFullName, mr.remoteMrNumber, { apiBase: ctx.apiBase, ...opts });
    }

    async mergePR(project, mrId) {
        const mr = await this.get(mrId);
        if (!mr || mr.projectId !== project.id) throw new Error('Merge request not found');
        const ctx = await this._resolveProvider(project, mr);
        if (!ctx) throw new Error('Provider not available');
        const result = await ctx.provider.mergePR(ctx.token, ctx.repoFullName, mr.remoteMrNumber, { apiBase: ctx.apiBase });
        try { await this.sync(project, mrId); } catch (_) {}
        return result;
    }

    async closePR(project, mrId) {
        const mr = await this.get(mrId);
        if (!mr || mr.projectId !== project.id) throw new Error('Merge request not found');
        const ctx = await this._resolveProvider(project, mr);
        if (!ctx) throw new Error('Provider not available');
        const result = await ctx.provider.closePR(ctx.token, ctx.repoFullName, mr.remoteMrNumber, { apiBase: ctx.apiBase });
        try { await this.sync(project, mrId); } catch (_) {}
        return result;
    }

    async reopenPR(project, mrId) {
        const mr = await this.get(mrId);
        if (!mr || mr.projectId !== project.id) throw new Error('Merge request not found');
        const ctx = await this._resolveProvider(project, mr);
        if (!ctx) throw new Error('Provider not available');
        const result = await ctx.provider.reopenPR(ctx.token, ctx.repoFullName, mr.remoteMrNumber, { apiBase: ctx.apiBase });
        try { await this.sync(project, mrId); } catch (_) {}
        return result;
    }

    async approvePR(project, mrId) {
        const mr = await this.get(mrId);
        if (!mr || mr.projectId !== project.id) throw new Error('Merge request not found');
        const ctx = await this._resolveProvider(project, mr);
        if (!ctx) throw new Error('Provider not available');
        return ctx.provider.submitApproval(ctx.token, ctx.repoFullName, mr.remoteMrNumber, { apiBase: ctx.apiBase });
    }

    async addComment(project, mrId, body) {
        const mr = await this.get(mrId);
        if (!mr || mr.projectId !== project.id) throw new Error('Merge request not found');
        const ctx = await this._resolveProvider(project, mr);
        if (!ctx) throw new Error('Provider not available');
        return ctx.provider.addIssueComment(ctx.token, ctx.repoFullName, mr.remoteMrNumber, body, { apiBase: ctx.apiBase });
    }

    async replyToReviewComment(project, mrId, commentId, body, opts = {}) {
        const mr = await this.get(mrId);
        if (!mr || mr.projectId !== project.id) throw new Error('Merge request not found');
        const ctx = await this._resolveProvider(project, mr);
        if (!ctx) throw new Error('Provider not available');
        return ctx.provider.replyToReviewComment(
            ctx.token, ctx.repoFullName, mr.remoteMrNumber, commentId, body,
            { apiBase: ctx.apiBase, discussionId: opts.discussionId },
        );
    }

    async editComment(project, mrId, commentId, body, commentType, opts = {}) {
        const mr = await this.get(mrId);
        if (!mr || mr.projectId !== project.id) throw new Error('Merge request not found');
        const ctx = await this._resolveProvider(project, mr);
        if (!ctx) throw new Error('Provider not available');
        const providerName = ctx.provider.name;
        if (providerName === 'gitlab') {
            return ctx.provider.editComment(
                ctx.token, ctx.repoFullName, mr.remoteMrNumber, commentId, body,
                { apiBase: ctx.apiBase },
            );
        }
        // GitHub: different endpoints for review vs issue comments
        if (commentType === 'review') {
            return ctx.provider.editReviewComment(
                ctx.token, ctx.repoFullName, mr.remoteMrNumber, commentId, body,
                { apiBase: ctx.apiBase },
            );
        }
        return ctx.provider.editIssueComment(
            ctx.token, ctx.repoFullName, mr.remoteMrNumber, commentId, body,
            { apiBase: ctx.apiBase },
        );
    }

    async deleteComment(project, mrId, commentId, commentType, opts = {}) {
        const mr = await this.get(mrId);
        if (!mr || mr.projectId !== project.id) throw new Error('Merge request not found');
        const ctx = await this._resolveProvider(project, mr);
        if (!ctx) throw new Error('Provider not available');
        const providerName = ctx.provider.name;
        if (providerName === 'gitlab') {
            return ctx.provider.deleteComment(
                ctx.token, ctx.repoFullName, mr.remoteMrNumber, commentId,
                { apiBase: ctx.apiBase },
            );
        }
        // GitHub: different endpoints for review vs issue comments
        if (commentType === 'review') {
            return ctx.provider.deleteReviewComment(
                ctx.token, ctx.repoFullName, mr.remoteMrNumber, commentId,
                { apiBase: ctx.apiBase },
            );
        }
        return ctx.provider.deleteIssueComment(
            ctx.token, ctx.repoFullName, mr.remoteMrNumber, commentId,
            { apiBase: ctx.apiBase },
        );
    }
}

module.exports = { MergeRequestService };
