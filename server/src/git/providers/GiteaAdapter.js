const { GitProviderService } = require('./GitProviderService');

const DEFAULT_API_BASE = 'https://gitea.com';

class GiteaError extends Error {
    constructor(message, code, status) {
        super(message);
        this.name = 'GiteaError';
        this.code = code;
        this.status = status;
    }
}

function normalizeBase(apiBase) {
    const base = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
    return base.endsWith('/api/v1') ? base : `${base}/api/v1`;
}

function webBase(apiBase) {
    return (apiBase || DEFAULT_API_BASE).replace(/\/api\/v1\/?$/, '').replace(/\/+$/, '');
}

function mapStatusToCode(status) {
    if (status === 401) return 'token_expired';
    if (status === 403) return 'insufficient_scope';
    if (status === 404) return 'repo_not_found';
    return 'gitea_api_error';
}

async function giteaFetch(token, apiBase, path, opts = {}) {
    const base = normalizeBase(apiBase);
    const url = `${base}${path}`;
    const options = {
        ...opts,
        headers: {
            Authorization: `token ${token}`,
            ...opts.headers,
        },
    };

    let res;
    try {
        res = await fetch(url, options);
    } catch (cause) {
        throw new GiteaError(`Gitea request failed: ${cause.message}`, 'network_error');
    }

    if (res.ok) {
        const text = await res.text();
        return text ? JSON.parse(text) : null;
    }

    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const message = body?.message || `${path} failed with status ${res.status}`;
    throw new GiteaError(message, mapStatusToCode(res.status), res.status);
}

function normalizeRepoInfo(repo) {
    return {
        id: String(repo.id),
        fullName: repo.full_name,
        cloneUrl: repo.clone_url,
        defaultBranch: repo.default_branch || 'main',
        private: repo.private || false,
        description: repo.description || null,
        language: repo.language || null,
        updatedAt: repo.updated_at || null,
        // Gitea API 返回当前 token 用户对仓库的权限：{ pull, push, admin }
        permissions: repo.permissions || null,
    };
}

function normalizePRInfo(pr) {
    return {
        number: pr.number,
        url: pr.html_url,
        title: pr.title,
        body: pr.body || null,
        state: pr.state,
        merged: pr.merged || false,
        headRef: pr.head?.ref || pr.head?.label || null,
        baseRef: pr.base?.ref || pr.base?.label || null,
        mergeCommitSha: pr.merge_commit_sha || null,
        createdAt: pr.created_at ? Date.parse(pr.created_at) : null,
    };
}

class GiteaAdapter extends GitProviderService {
    get name() { return 'gitea'; }
    get displayName() { return 'Gitea'; }
    get prTerminology() {
        return { singular: 'Pull Request', plural: 'Pull Requests', abbreviation: 'PR' };
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
        });
        // Gitea doesn't require scope in the authorize URL but some instances support it
        if (scope) params.set('scope', scope);
        return `${base}/login/oauth/authorize?${params.toString()}`;
    }

    async exchangeCode(code, { clientId, clientSecret, callbackUrl, apiBase }) {
        const base = webBase(apiBase);
        let res;
        try {
            res = await fetch(`${base}/login/oauth/access_token`, {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: clientId,
                    client_secret: clientSecret,
                    code,
                    grant_type: 'authorization_code',
                    redirect_uri: callbackUrl || '',
                }),
            });
        } catch (cause) {
            throw new GiteaError(`Gitea OAuth request failed: ${cause.message}`, 'network_error');
        }

        const data = await res.json();
        if (!res.ok || data.error) {
            const message = data.error_description || data.error || `OAuth exchange failed (${res.status})`;
            throw new GiteaError(message, data.error || 'oauth_failed');
        }
        if (!data.access_token) {
            throw new GiteaError('OAuth response did not contain an access_token', 'oauth_failed');
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
            res = await fetch(`${base}/login/oauth/access_token`, {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: clientId,
                    client_secret: clientSecret,
                    refresh_token: refreshToken,
                    grant_type: 'refresh_token',
                }),
            });
        } catch (cause) {
            throw new GiteaError(`Gitea token refresh failed: ${cause.message}`, 'network_error');
        }

        const data = await res.json();
        if (!res.ok || data.error) {
            throw new GiteaError(data.error_description || data.error || 'token refresh failed', 'refresh_failed');
        }

        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || null,
            expiresIn: data.expires_in || null,
        };
    }

    // ── User ──

    async getAuthenticatedUser(token, { apiBase } = {}) {
        const user = await giteaFetch(token, apiBase, '/user');
        return {
            id: String(user.id),
            username: user.login,
            displayName: user.full_name || user.login,
            avatarUrl: user.avatar_url || null,
            email: user.email || null,
        };
    }

    // ── Repositories ──

    async listUserRepos(token, { page = 1, perPage = 30, search, apiBase } = {}) {
        const query = new URLSearchParams();
        query.set('page', String(page));
        query.set('limit', String(perPage));
        query.set('sort', 'updated');
        query.set('order', 'desc');
        if (search) query.set('q', search);
        const repos = await giteaFetch(token, apiBase, `/user/repos?${query.toString()}`);
        return {
            repos: repos.map(normalizeRepoInfo),
            hasMore: repos.length === perPage,
        };
    }

    async getRepo(token, repoIdentifier, { apiBase } = {}) {
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const result = await giteaFetch(token, apiBase,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
        return normalizeRepoInfo(result);
    }

    // ── Pull Requests ──

    async createPR(token, repoIdentifier, { title, body, head, base: baseBranch, apiBase }) {
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const pr = await giteaFetch(token, apiBase,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, body, head, base: baseBranch }),
            });
        return normalizePRInfo(pr);
    }

    async getPR(token, repoIdentifier, prNumber, { apiBase } = {}) {
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const pr = await giteaFetch(token, apiBase,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`);
        return normalizePRInfo(pr);
    }

    async listPRs(token, repoIdentifier, { state = 'open', page = 1, perPage = 30, apiBase } = {}) {
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const query = new URLSearchParams();
        query.set('state', state);
        query.set('page', String(page));
        query.set('limit', String(perPage));
        const prs = await giteaFetch(token, apiBase,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${query.toString()}`);
        return prs.map(normalizePRInfo);
    }

    // ── PR Actions ──

    async mergePR(token, repoIdentifier, prNumber, { apiBase } = {}) {
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const res = await giteaFetch(token, apiBase,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/merge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ Do: 'merge' }),
        });
        return { merged: true };
    }

    async closePR(token, repoIdentifier, prNumber, { apiBase } = {}) {
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const res = await giteaFetch(token, apiBase,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: 'closed' }),
        });
        return { state: res.state || 'closed' };
    }

    async submitApproval(token, repoIdentifier, prNumber, { apiBase } = {}) {
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        await giteaFetch(token, apiBase,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/reviews`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'APPROVED' }),
        });
        return { approved: true };
    }

    async addIssueComment(token, repoIdentifier, prNumber, body, { apiBase } = {}) {
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const res = await giteaFetch(token, apiBase,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prNumber}/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
        });
        return {
            id: res.id,
            body: res.body,
            createdAt: res.created_at,
            user: { login: res.user?.login, avatarUrl: res.user?.avatar_url },
        };
    }

    async reopenPR(token, repoIdentifier, prNumber, { apiBase } = {}) {
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const res = await giteaFetch(token, apiBase,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: 'open' }),
        });
        return { state: res.state || 'open' };
    }

    async replyToReviewComment(token, repoIdentifier, prNumber, commentId, body, { apiBase } = {}) {
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const res = await giteaFetch(token, apiBase,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/comments/${commentId}/replies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
        });
        return {
            id: res.id,
            path: res.path || null,
            line: res.line || res.original_line || null,
            side: res.side || null,
            user: { login: res.user?.login, avatarUrl: res.user?.avatar_url },
            body: res.body || '',
            createdAt: res.created_at,
            updatedAt: res.updated_at,
            inReplyToId: res.in_reply_to_id || Number(commentId),
            diffHunk: res.diff_hunk || null,
        };
    }

    async editReviewComment(token, repoIdentifier, prNumber, commentId, body, { apiBase } = {}) {
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const res = await giteaFetch(token, apiBase,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/comments/${commentId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
        });
        return { id: res.id, body: res.body, updatedAt: res.updated_at };
    }

    async deleteReviewComment(token, repoIdentifier, prNumber, commentId, { apiBase } = {}) {
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        await giteaFetch(token, apiBase,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/comments/${commentId}`, {
            method: 'DELETE',
        });
        return { deleted: true };
    }

    async editIssueComment(token, repoIdentifier, prNumber, commentId, body, { apiBase } = {}) {
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const res = await giteaFetch(token, apiBase,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
        });
        return { id: res.id, body: res.body, updatedAt: res.updated_at };
    }

    async deleteIssueComment(token, repoIdentifier, prNumber, commentId, { apiBase } = {}) {
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        await giteaFetch(token, apiBase,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`, {
            method: 'DELETE',
        });
        return { deleted: true };
    }

    // ── Utility ──

    parseRepoIdentifier(fullName) {
        if (!fullName || typeof fullName !== 'string') {
            throw new Error('Repository full name is required');
        }
        const [owner, repo, ...rest] = fullName.split('/');
        if (!owner || !repo || rest.length > 0) {
            throw new Error(`Invalid Gitea repo identifier: ${fullName}`);
        }
        return { owner, repo };
    }

    buildCloneUrl(repoIdentifier, { apiBase } = {}) {
        const base = webBase(apiBase);
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        return `${base}/${owner}/${repo}.git`;
    }
}

module.exports = { GiteaAdapter, GiteaError };
