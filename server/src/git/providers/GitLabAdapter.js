const { GitProviderService } = require('./GitProviderService');

const DEFAULT_API_BASE = 'https://gitlab.com';

class GitLabError extends Error {
    constructor(message, code, status) {
        super(message);
        this.name = 'GitLabError';
        this.code = code;
        this.status = status;
    }
}

function normalizeBase(apiBase) {
    const base = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
    return base.endsWith('/api/v4') ? base : `${base}/api/v4`;
}

function webBase(apiBase) {
    return (apiBase || DEFAULT_API_BASE).replace(/\/api\/v4\/?$/, '').replace(/\/+$/, '');
}

function mapStatusToCode(status) {
    if (status === 401) return 'token_expired';
    if (status === 403) return 'insufficient_scope';
    if (status === 404) return 'repo_not_found';
    return 'gitlab_api_error';
}

async function gitlabFetch(token, apiBase, path, opts = {}) {
    const base = normalizeBase(apiBase);
    const url = `${base}${path}`;
    const options = {
        ...opts,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
            ...opts.headers,
        },
    };

    let res;
    try {
        res = await fetch(url, options);
    } catch (cause) {
        throw new GitLabError(`GitLab request failed: ${cause.message}`, 'network_error');
    }

    if (res.ok) return res.json();

    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const message = body?.message || body?.error || `${path} failed with status ${res.status}`;
    throw new GitLabError(
        typeof message === 'object' ? JSON.stringify(message) : message,
        mapStatusToCode(res.status),
        res.status,
    );
}

function normalizeRepoInfo(glProject, apiBase) {
    return {
        id: String(glProject.id),
        fullName: glProject.path_with_namespace,
        cloneUrl: glProject.http_url_to_repo,
        defaultBranch: glProject.default_branch || 'main',
        private: glProject.visibility === 'private',
        description: glProject.description || null,
        language: null,
        updatedAt: glProject.last_activity_at || null,
        // GitLab /projects/{id} 返回当前用户的项目/组权限：{ project_access, group_access }（access_level）
        permissions: glProject.permissions || null,
    };
}

function normalizeMRInfo(glMr, apiBase) {
    const base = webBase(apiBase);
    return {
        number: glMr.iid,
        url: glMr.web_url || `${base}/${glMr.references?.full || ''}`,
        title: glMr.title,
        body: glMr.description || null,
        state: glMr.state === 'merged' ? 'closed' : glMr.state,
        merged: glMr.state === 'merged',
        headRef: glMr.source_branch || null,
        baseRef: glMr.target_branch || null,
        mergeCommitSha: glMr.merge_commit_sha || null,
        createdAt: glMr.created_at ? Date.parse(glMr.created_at) : null,
    };
}

class GitLabAdapter extends GitProviderService {
    get name() { return 'gitlab'; }
    get displayName() { return 'GitLab'; }
    get prTerminology() {
        return { singular: 'Merge Request', plural: 'Merge Requests', abbreviation: 'MR' };
    }

    get requiresTokenRefresh() { return true; }

    // ── OAuth ──

    buildAuthUrl({ clientId, callbackUrl, state, scope, apiBase }) {
        const base = webBase(apiBase);
        const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: callbackUrl || '',
            response_type: 'code',
            state,
            scope: scope || 'api',
        });
        return `${base}/oauth/authorize?${params.toString()}`;
    }

    async exchangeCode(code, { clientId, clientSecret, callbackUrl, apiBase }) {
        const base = webBase(apiBase);
        let res;
        try {
            res = await fetch(`${base}/oauth/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: clientId,
                    client_secret: clientSecret,
                    code,
                    grant_type: 'authorization_code',
                    redirect_uri: callbackUrl || '',
                }),
            });
        } catch (cause) {
            throw new GitLabError(`GitLab OAuth request failed: ${cause.message}`, 'network_error');
        }

        const data = await res.json();
        if (!res.ok || data.error) {
            const message = data.error_description || data.error || `OAuth exchange failed (${res.status})`;
            throw new GitLabError(message, data.error || 'oauth_failed');
        }
        if (!data.access_token) {
            throw new GitLabError('OAuth response did not contain an access_token', 'oauth_failed');
        }

        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || null,
            expiresIn: data.expires_in || null,
            scope: data.scope || null,
        };
    }

    async refreshAccessToken(refreshToken, { clientId, clientSecret, apiBase }) {
        const base = webBase(apiBase);
        let res;
        try {
            res = await fetch(`${base}/oauth/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: clientId,
                    client_secret: clientSecret,
                    refresh_token: refreshToken,
                    grant_type: 'refresh_token',
                }),
            });
        } catch (cause) {
            throw new GitLabError(`GitLab token refresh failed: ${cause.message}`, 'network_error');
        }

        const data = await res.json();
        if (!res.ok || data.error) {
            throw new GitLabError(data.error_description || data.error || 'token refresh failed', 'refresh_failed');
        }

        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || null,
            expiresIn: data.expires_in || null,
        };
    }

    // ── User ──

    async getAuthenticatedUser(token, { apiBase } = {}) {
        const user = await gitlabFetch(token, apiBase, '/user');
        return {
            id: String(user.id),
            username: user.username,
            displayName: user.name || user.username,
            avatarUrl: user.avatar_url || null,
            email: user.email || null,
        };
    }

    // ── Repositories ──

    async listUserRepos(token, { page = 1, perPage = 30, search, apiBase } = {}) {
        const query = new URLSearchParams();
        query.set('page', String(page));
        query.set('per_page', String(perPage));
        query.set('membership', 'true');
        query.set('order_by', 'updated_at');
        query.set('sort', 'desc');
        if (search) query.set('search', search);
        const projects = await gitlabFetch(token, apiBase, `/projects?${query.toString()}`);
        return {
            repos: projects.map((p) => normalizeRepoInfo(p, apiBase)),
            hasMore: projects.length === perPage,
        };
    }

    async getRepo(token, repoIdentifier, { apiBase } = {}) {
        const encoded = encodeURIComponent(repoIdentifier);
        const project = await gitlabFetch(token, apiBase, `/projects/${encoded}`);
        return normalizeRepoInfo(project, apiBase);
    }

    // ── Merge Requests ──

    async createPR(token, repoIdentifier, { title, body, head, base: baseBranch, apiBase }) {
        const encoded = encodeURIComponent(repoIdentifier);
        const mr = await gitlabFetch(token, apiBase,
            `/projects/${encoded}/merge_requests`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    description: body,
                    source_branch: head,
                    target_branch: baseBranch,
                }),
            });
        return normalizeMRInfo(mr, apiBase);
    }

    async getPR(token, repoIdentifier, mrIid, { apiBase } = {}) {
        const encoded = encodeURIComponent(repoIdentifier);
        const mr = await gitlabFetch(token, apiBase,
            `/projects/${encoded}/merge_requests/${mrIid}`);
        return normalizeMRInfo(mr, apiBase);
    }

    async listPRs(token, repoIdentifier, { state = 'opened', page = 1, perPage = 30, apiBase } = {}) {
        const encoded = encodeURIComponent(repoIdentifier);
        const query = new URLSearchParams();
        // Map generic 'open' → GitLab 'opened'
        query.set('state', state === 'open' ? 'opened' : state);
        query.set('page', String(page));
        query.set('per_page', String(perPage));
        const mrs = await gitlabFetch(token, apiBase,
            `/projects/${encoded}/merge_requests?${query.toString()}`);
        return mrs.map((mr) => normalizeMRInfo(mr, apiBase));
    }

    // ── Reviews (Phase 4) ──

    async listReviews(token, repoIdentifier, mrIid, { apiBase } = {}) {
        const encoded = encodeURIComponent(repoIdentifier);
        const approvals = await gitlabFetch(token, apiBase,
            `/projects/${encoded}/merge_requests/${mrIid}/approvals`);
        // GitLab doesn't have "reviews" like GitHub; approximate from approvals + notes
        const reviewers = (approvals.approved_by || []).map((a) => ({
            id: a.user?.id,
            user: { login: a.user?.username, avatarUrl: a.user?.avatar_url },
            state: 'APPROVED',
            body: null,
            submittedAt: null,
            htmlUrl: null,
        }));
        return reviewers;
    }

    async listReviewComments(token, repoIdentifier, mrIid, { apiBase, page = 1, perPage = 30 } = {}) {
        const encoded = encodeURIComponent(repoIdentifier);
        const query = new URLSearchParams({ page: String(page), per_page: String(perPage) });
        const notes = await gitlabFetch(token, apiBase,
            `/projects/${encoded}/merge_requests/${mrIid}/notes?${query}`);
        return notes.filter((n) => !n.system && n.position).map((n) => ({
            id: n.id,
            discussionId: n.discussion_id || null,
            path: n.position?.new_path || n.position?.old_path || null,
            line: n.position?.new_line || n.position?.old_line || null,
            side: n.position?.new_line ? 'RIGHT' : 'LEFT',
            user: { login: n.author?.username, avatarUrl: n.author?.avatar_url },
            body: n.body || '',
            createdAt: n.created_at,
            updatedAt: n.updated_at,
            inReplyToId: null,
            diffHunk: null,
        }));
    }

    async listIssueComments(token, repoIdentifier, mrIid, { apiBase, page = 1, perPage = 30 } = {}) {
        const encoded = encodeURIComponent(repoIdentifier);
        const query = new URLSearchParams({ page: String(page), per_page: String(perPage) });
        const notes = await gitlabFetch(token, apiBase,
            `/projects/${encoded}/merge_requests/${mrIid}/notes?${query}`);
        return notes.filter((n) => !n.system && !n.position).map((n) => ({
            id: n.id,
            discussionId: n.discussion_id || null,
            user: { login: n.author?.username, avatarUrl: n.author?.avatar_url },
            body: n.body || '',
            createdAt: n.created_at,
            updatedAt: n.updated_at,
        }));
    }

    async listMrFiles(token, repoIdentifier, mrIid, { apiBase } = {}) {
        const encoded = encodeURIComponent(repoIdentifier);
        const data = await gitlabFetch(token, apiBase,
            `/projects/${encoded}/merge_requests/${mrIid}/changes`);
        const changes = data.changes || [];
        return changes.map((c) => ({
            path: c.new_path || c.old_path || '',
            oldPath: c.old_path || null,
            status: c.new_file ? 'added' : c.deleted_file ? 'deleted' : 'modified',
            additions: null,
            deletions: null,
            diff: c.diff || '',
        }));
    }

    // ── PR Actions ──

    async mergePR(token, repoIdentifier, mrIid, { apiBase, squash, removeSourceBranch } = {}) {
        const encoded = encodeURIComponent(repoIdentifier);
        const body = {};
        if (squash) body.squash = true;
        if (removeSourceBranch) body.should_remove_source_branch = true;
        const res = await gitlabFetch(token, apiBase,
            `/projects/${encoded}/merge_requests/${mrIid}/merge`, {
            method: 'PUT',
            body: JSON.stringify(body),
        });
        return { merged: true, mergeSha: res.merge_commit_sha || null };
    }

    async closePR(token, repoIdentifier, mrIid, { apiBase } = {}) {
        const encoded = encodeURIComponent(repoIdentifier);
        const res = await gitlabFetch(token, apiBase,
            `/projects/${encoded}/merge_requests/${mrIid}`, {
            method: 'PUT',
            body: JSON.stringify({ state_event: 'close' }),
        });
        return { state: res.state || 'closed' };
    }

    async reopenPR(token, repoIdentifier, mrIid, { apiBase } = {}) {
        const encoded = encodeURIComponent(repoIdentifier);
        const res = await gitlabFetch(token, apiBase,
            `/projects/${encoded}/merge_requests/${mrIid}`, {
            method: 'PUT',
            body: JSON.stringify({ state_event: 'reopen' }),
        });
        return { state: res.state || 'opened' };
    }

    async submitApproval(token, repoIdentifier, mrIid, { apiBase } = {}) {
        const encoded = encodeURIComponent(repoIdentifier);
        try {
            await gitlabFetch(token, apiBase,
                `/projects/${encoded}/merge_requests/${mrIid}/approve`, {
                method: 'POST',
            });
            return { approved: true };
        } catch (err) {
            // GitLab returns 401 for both "token expired" and "already approved".
            // Distinguish the latter so it isn't misclassified as an auth error.
            if (err.status === 401 && /already\s+approved|approved\s+by/i.test(err.message)) {
                err.code = 'already_approved';
                err.status = 409;
            }
            throw err;
        }
    }

    async addIssueComment(token, repoIdentifier, mrIid, body, { apiBase } = {}) {
        const encoded = encodeURIComponent(repoIdentifier);
        const res = await gitlabFetch(token, apiBase,
            `/projects/${encoded}/merge_requests/${mrIid}/notes`, {
            method: 'POST',
            body: JSON.stringify({ body }),
        });
        return {
            id: res.id,
            body: res.body,
            createdAt: res.created_at,
            user: { login: res.author?.username, avatarUrl: res.author?.avatar_url },
        };
    }

    // ── Comment management ──

    async replyToReviewComment(token, repoIdentifier, mrIid, commentId, body, { apiBase, discussionId } = {}) {
        const encoded = encodeURIComponent(repoIdentifier);
        if (!discussionId) throw new Error('discussionId is required for GitLab reply');
        const res = await gitlabFetch(token, apiBase,
            `/projects/${encoded}/merge_requests/${mrIid}/discussions/${discussionId}/notes`, {
            method: 'POST',
            body: JSON.stringify({ body }),
        });
        return {
            id: res.id,
            discussionId: res.discussion_id || discussionId,
            user: { login: res.author?.username, avatarUrl: res.author?.avatar_url },
            body: res.body || '',
            createdAt: res.created_at,
        };
    }

    async editComment(token, repoIdentifier, mrIid, commentId, body, { apiBase } = {}) {
        const encoded = encodeURIComponent(repoIdentifier);
        const res = await gitlabFetch(token, apiBase,
            `/projects/${encoded}/merge_requests/${mrIid}/notes/${commentId}`, {
            method: 'PUT',
            body: JSON.stringify({ body }),
        });
        return { id: res.id, body: res.body, updatedAt: res.updated_at };
    }

    async deleteComment(token, repoIdentifier, mrIid, commentId, { apiBase } = {}) {
        const encoded = encodeURIComponent(repoIdentifier);
        await gitlabFetch(token, apiBase,
            `/projects/${encoded}/merge_requests/${mrIid}/notes/${commentId}`, {
            method: 'DELETE',
        });
        return { deleted: true };
    }

    // ── Utility ──

    parseRepoIdentifier(fullName) {
        if (!fullName || typeof fullName !== 'string') {
            throw new Error('Repository path is required');
        }
        const parts = fullName.split('/');
        if (parts.length < 2) {
            throw new Error(`Invalid GitLab repo identifier: ${fullName}`);
        }
        // GitLab supports nested groups: group/subgroup/repo
        return { owner: parts.slice(0, -1).join('/'), repo: parts[parts.length - 1] };
    }

    buildCloneUrl(repoIdentifier, { apiBase } = {}) {
        const base = webBase(apiBase);
        return `${base}/${repoIdentifier}.git`;
    }
}

module.exports = { GitLabAdapter, GitLabError };
