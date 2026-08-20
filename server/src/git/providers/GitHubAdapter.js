const { GitProviderService } = require('./GitProviderService');

const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_OAUTH_BASE = 'https://github.com';
const GITHUB_API_VERSION = '2022-11-28';

class GitHubError extends Error {
    constructor(message, code, status) {
        super(message);
        this.name = 'GitHubError';
        this.code = code;
        this.status = status;
    }
}

function mapStatusToCode(status) {
    if (status === 401) return 'token_expired';
    if (status === 403) return 'insufficient_scope';
    if (status === 404) return 'repo_not_found';
    return 'github_api_error';
}

function authHeaders(token) {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
    };
}

function deriveOAuthBase(apiBase) {
    if (!apiBase || apiBase === DEFAULT_API_BASE) return DEFAULT_OAUTH_BASE;
    try {
        const url = new URL(apiBase);
        return `${url.protocol}//${url.host}`;
    } catch {
        return DEFAULT_OAUTH_BASE;
    }
}

async function githubFetch(token, apiBase, path, opts = {}) {
    const { returnHeaders, ...fetchOpts } = opts;
    const url = `${apiBase}${path}`;
    const options = {
        ...fetchOpts,
        headers: {
            ...authHeaders(token),
            ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
            ...fetchOpts.headers,
        },
    };

    let res;
    try {
        res = await fetch(url, options);
    } catch (cause) {
        throw new GitHubError(`GitHub request failed: ${cause.message}`, 'network_error');
    }

    if (res.ok) {
        return returnHeaders ? { data: await res.json(), headers: res.headers } : res.json();
    }

    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const message = body?.message || `${path} failed with status ${res.status}`;
    throw new GitHubError(message, mapStatusToCode(res.status), res.status);
}

function normalizeRepoInfo(ghRepo) {
    return {
        id: String(ghRepo.id),
        fullName: ghRepo.full_name,
        cloneUrl: ghRepo.clone_url,
        defaultBranch: ghRepo.default_branch || 'main',
        private: ghRepo.private || false,
        description: ghRepo.description || null,
        language: ghRepo.language || null,
        updatedAt: ghRepo.updated_at || null,
        // GitHub API 返回当前 token 用户对仓库的权限：{ pull, push, admin }
        permissions: ghRepo.permissions || null,
    };
}

function normalizePRInfo(ghPr) {
    return {
        number: ghPr.number,
        url: ghPr.html_url,
        title: ghPr.title,
        body: ghPr.body || null,
        state: ghPr.state,
        merged: ghPr.merged || false,
        headRef: ghPr.head?.ref || null,
        baseRef: ghPr.base?.ref || null,
        mergeCommitSha: ghPr.merge_commit_sha || null,
        createdAt: ghPr.created_at ? Date.parse(ghPr.created_at) : null,
    };
}

class GitHubAdapter extends GitProviderService {
    get name() { return 'github'; }
    get displayName() { return 'GitHub'; }
    get prTerminology() {
        return { singular: 'Pull Request', plural: 'Pull Requests', abbreviation: 'PR' };
    }

    get requiresTokenRefresh() { return false; }

    // ── OAuth ──

    buildAuthUrl({ clientId, callbackUrl, state, scope, apiBase }) {
        const oauthBase = deriveOAuthBase(apiBase);
        const params = new URLSearchParams({
            client_id: clientId,
            state,
            scope: scope || 'repo',
        });
        if (callbackUrl) params.set('redirect_uri', callbackUrl);
        return `${oauthBase}/login/oauth/authorize?${params.toString()}`;
    }

    async exchangeCode(code, { clientId, clientSecret, apiBase }) {
        const oauthBase = deriveOAuthBase(apiBase);
        let res;
        try {
            res = await fetch(`${oauthBase}/login/oauth/access_token`, {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
            });
        } catch (cause) {
            throw new GitHubError(`GitHub OAuth request failed: ${cause.message}`, 'network_error');
        }

        const data = await res.json();
        if (!res.ok || data.error) {
            const message = data.error_description || data.error || `OAuth exchange failed (${res.status})`;
            throw new GitHubError(message, data.error || 'oauth_failed');
        }
        if (!data.access_token) {
            throw new GitHubError('OAuth response did not contain an access_token', 'oauth_failed');
        }

        return {
            accessToken: data.access_token,
            scope: data.scope || null,
        };
    }

    // ── User ──

    async getAuthenticatedUser(token, { apiBase } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { data: ghUser, headers } = await githubFetch(token, base, '/user', { returnHeaders: true });
        // GitHub returns X-OAuth-Scopes for classic PATs (comma+space separated);
        // fine-grained PATs carry no such header, so mark them distinctly.
        const scopesHeader = headers?.get('x-oauth-scopes');
        return {
            id: String(ghUser.id),
            username: ghUser.login,
            displayName: ghUser.name || ghUser.login,
            avatarUrl: ghUser.avatar_url || null,
            email: ghUser.email || null,
            tokenScope: scopesHeader != null ? (scopesHeader || null) : 'fine-grained',
        };
    }

    // ── Repositories ──

    async listUserRepos(token, { page = 1, perPage = 30, affiliation = 'owner,collaborator,organization_member', apiBase } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const query = new URLSearchParams();
        query.set('page', String(page));
        query.set('per_page', String(perPage));
        if (affiliation) query.set('affiliation', affiliation);
        query.set('sort', 'updated');
        const repos = await githubFetch(token, base, `/user/repos?${query.toString()}`);
        return {
            repos: repos.map(normalizeRepoInfo),
            hasMore: repos.length === perPage,
        };
    }

    async getRepo(token, repoIdentifier, { apiBase } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const ghRepo = await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
        return normalizeRepoInfo(ghRepo);
    }

    // ── Pull Requests ──

    async createPR(token, repoIdentifier, { title, body, head, base: baseBranch, apiBase }) {
        const apiUrl = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const ghPr = await githubFetch(token, apiUrl,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, body, head, base: baseBranch }),
            });
        return normalizePRInfo(ghPr);
    }

    async getPR(token, repoIdentifier, prNumber, { apiBase } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const ghPr = await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`);
        return normalizePRInfo(ghPr);
    }

    async listPRs(token, repoIdentifier, { state = 'open', page = 1, perPage = 30, apiBase } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const query = new URLSearchParams();
        query.set('state', state);
        query.set('page', String(page));
        query.set('per_page', String(perPage));
        const ghPrs = await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${query.toString()}`);
        return ghPrs.map(normalizePRInfo);
    }

    // ── Reviews (Phase 4) ──

    async listReviews(token, repoIdentifier, prNumber, { apiBase } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const reviews = await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/reviews`);
        return reviews.map((r) => ({
            id: r.id,
            user: { login: r.user?.login, avatarUrl: r.user?.avatar_url },
            state: r.state, // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING
            body: r.body || null,
            submittedAt: r.submitted_at || null,
            htmlUrl: r.html_url || null,
        }));
    }

    async listReviewComments(token, repoIdentifier, prNumber, { apiBase, page = 1, perPage = 30 } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const query = new URLSearchParams({ page: String(page), per_page: String(perPage) });
        const comments = await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/comments?${query}`);
        return comments.map((c) => ({
            id: c.id,
            path: c.path || null,
            line: c.line || c.original_line || null,
            side: c.side || null,
            user: { login: c.user?.login, avatarUrl: c.user?.avatar_url },
            body: c.body || '',
            createdAt: c.created_at,
            updatedAt: c.updated_at,
            inReplyToId: c.in_reply_to_id || null,
            diffHunk: c.diff_hunk || null,
        }));
    }

    // ── Utility ──

    async listIssueComments(token, repoIdentifier, prNumber, { apiBase, page = 1, perPage = 30 } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const query = new URLSearchParams({ page: String(page), per_page: String(perPage) });
        const comments = await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prNumber}/comments?${query}`);
        return comments.map((c) => ({
            id: c.id,
            user: { login: c.user?.login, avatarUrl: c.user?.avatar_url },
            body: c.body || '',
            createdAt: c.created_at,
            updatedAt: c.updated_at,
            htmlUrl: c.html_url || null,
        }));
    }

    async listMrFiles(token, repoIdentifier, prNumber, { apiBase, page = 1, perPage = 100 } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const query = new URLSearchParams({ page: String(page), per_page: String(perPage) });
        const files = await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/files?${query}`);
        return files.map((f) => ({
            path: f.filename || '',
            oldPath: f.previous_filename || null,
            status: f.status === 'added' ? 'added' : f.status === 'removed' ? 'deleted' : f.status === 'renamed' ? 'renamed' : 'modified',
            additions: f.additions ?? null,
            deletions: f.deletions ?? null,
            diff: f.patch || '',
        }));
    }

    // ── PR Actions ──

    async mergePR(token, repoIdentifier, prNumber, { apiBase, squash } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const res = await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/merge`, {
            method: 'PUT',
            body: JSON.stringify({ merge_method: squash ? 'squash' : 'merge' }),
        });
        return { merged: true, mergeSha: res.sha || null };
    }

    async closePR(token, repoIdentifier, prNumber, { apiBase } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const res = await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`, {
            method: 'PATCH',
            body: JSON.stringify({ state: 'closed' }),
        });
        return { state: res.state || 'closed' };
    }

    async reopenPR(token, repoIdentifier, prNumber, { apiBase } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const res = await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`, {
            method: 'PATCH',
            body: JSON.stringify({ state: 'open' }),
        });
        return { state: res.state || 'open' };
    }

    async submitApproval(token, repoIdentifier, prNumber, { apiBase } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const res = await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/reviews`, {
            method: 'POST',
            body: JSON.stringify({ event: 'APPROVE' }),
        });
        return { approved: true, reviewId: res.id };
    }

    async addIssueComment(token, repoIdentifier, prNumber, body, { apiBase } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const res = await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prNumber}/comments`, {
            method: 'POST',
            body: JSON.stringify({ body }),
        });
        return {
            id: res.id,
            body: res.body,
            createdAt: res.created_at,
            user: { login: res.user?.login, avatarUrl: res.user?.avatar_url },
        };
    }

    // ── Comment management ──

    async replyToReviewComment(token, repoIdentifier, prNumber, commentId, body, { apiBase } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const res = await githubFetch(token, base,
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
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const res = await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/comments/${commentId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
        });
        return { id: res.id, body: res.body, updatedAt: res.updated_at };
    }

    async deleteReviewComment(token, repoIdentifier, prNumber, commentId, { apiBase } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/comments/${commentId}`, {
            method: 'DELETE',
        });
        return { deleted: true };
    }

    async editIssueComment(token, repoIdentifier, prNumber, commentId, body, { apiBase } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        const res = await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
        });
        return { id: res.id, body: res.body, updatedAt: res.updated_at };
    }

    async deleteIssueComment(token, repoIdentifier, prNumber, commentId, { apiBase } = {}) {
        const base = apiBase || DEFAULT_API_BASE;
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        await githubFetch(token, base,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`, {
            method: 'DELETE',
        });
        return { deleted: true };
    }

    parseRepoIdentifier(fullName) {
        if (!fullName || typeof fullName !== 'string') {
            throw new Error('Repository full name is required');
        }
        const [owner, repo, ...rest] = fullName.split('/');
        if (!owner || !repo || rest.length > 0) {
            throw new Error(`Invalid GitHub repo identifier: ${fullName}`);
        }
        return { owner, repo };
    }

    buildCloneUrl(repoIdentifier, { apiBase } = {}) {
        const oauthBase = deriveOAuthBase(apiBase);
        const { owner, repo } = this.parseRepoIdentifier(repoIdentifier);
        return `${oauthBase}/${owner}/${repo}.git`;
    }
}

module.exports = { GitHubAdapter, GitHubError, deriveOAuthBase };
