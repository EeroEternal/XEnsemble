const fs = require('fs');
const os = require('os');
const path = require('path');

// Per-process cache of askpass scripts keyed by host directory.
// The script body is token-independent (token is passed via GIT_ASKPASS_TOKEN env),
// so a single script per directory can be reused across all git calls in this process.
const askpassCache = new Map();

// Clean up cached scripts on process exit.
process.on('exit', () => {
    for (const scriptPath of askpassCache.values()) {
        try { fs.unlinkSync(scriptPath); } catch { /* best-effort */ }
    }
});

/**
 * Remove embedded credentials from a Git remote URL so the remote is always
 * stored without a token / password.
 *
 * @param {string} url
 * @returns {string}
 */
function stripCredentialFromUrl(url) {
    if (!url) return url;
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) {
            parsed.username = '';
            parsed.password = '';
            // URL#toString keeps the trailing .git path intact.
            return parsed.toString();
        }
    } catch {
        // Not a URL we can parse; return it untouched and let git report errors.
    }
    return url;
}

/**
 * Get or create a cached GIT_ASKPASS helper script for the given directory.
 * The script body is identical regardless of token (token passed via env),
 * so the script is created once per directory and reused.
 *
 * @param {string} dir - host directory to write the script into
 * @returns {string} absolute path to the helper script
 */
function getOrCreateAskpassScript(dir) {
    const targetDir = dir || os.tmpdir();
    const cached = askpassCache.get(targetDir);
    if (cached && fs.existsSync(cached)) {
        return cached;
    }
    const askpassDir = path.join(targetDir, '.xensemble', 'git');
    try { fs.mkdirSync(askpassDir, { recursive: true }); } catch {}
    const scriptPath = path.join(askpassDir, `git-askpass-${process.pid}.sh`);
    const content = `#!/bin/sh\nprintf '%s\\n' "$GIT_ASKPASS_TOKEN"\n`;
    try {
        fs.writeFileSync(scriptPath, content, { mode: 0o700 });
    } catch (e) {
        // If the target directory is not writable, fall back to os.tmpdir().
        if (targetDir !== os.tmpdir()) {
            return getOrCreateAskpassScript(os.tmpdir());
        }
        throw e;
    }
    askpassCache.set(targetDir, scriptPath);
    return scriptPath;
}

/**
 * Create a temporary GIT_ASKPASS helper script that prints the supplied token.
 * The actual token is passed through the environment variable
 * GIT_ASKPASS_TOKEN so it is never interpolated into the script body.
 *
 * Note: This low-level function always creates a fresh script. For cached
 * (reusable) scripts, use getOrCreateAskpassScript / buildCredentialEnv.
 *
 * @param {string} token
 * @param {string} [workspacePath]
 * @returns {string} absolute path to the helper script
 */
function createAskpassScript(token, workspacePath) {
    const dir = workspacePath ? path.join(workspacePath, '.xensemble', 'git') : os.tmpdir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const scriptPath = path.join(
        dir,
        `git-askpass-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
    );
    const content = `#!/bin/sh\nprintf '%s\\n' "$GIT_ASKPASS_TOKEN"\n`;
    fs.writeFileSync(scriptPath, content, { mode: 0o700 });
    return scriptPath;
}

/**
 * Delete a temporary GIT_ASKPASS helper script. Failures are swallowed because
 * the script lives in a temp directory.
 *
 * Note: This only removes scripts NOT in the cache (i.e. scripts created via
 * createAskpassScript). Cached scripts are cleaned up on process exit.
 *
 * @param {string} scriptPath
 */
function removeAskpassScript(scriptPath) {
    // Don't remove cached scripts; they are reused across calls.
    for (const cachedPath of askpassCache.values()) {
        if (cachedPath === scriptPath) return;
    }
    try {
        fs.unlinkSync(scriptPath);
    } catch {
        // Best-effort cleanup.
    }
}

/**
 * Build an environment object that makes git use a cached GIT_ASKPASS
 * helper. Returns the env object and a no-op cleanup function (the
 * cached script is reused across calls and cleaned up on process exit).
 *
 * When a username is supplied it is injected via git's GIT_CONFIG_*
 * environment variables as `credential.username`. Git then uses that
 * username without prompting, so the askpass helper only ever answers the
 * password prompt — this avoids askpass having to distinguish localized
 * "Username/Password" prompt text, and is required for GitLab/Gitea OAuth
 * tokens (HTTP Basic username must be `oauth2`).
 *
 * @param {string} token
 * @param {string} [hostPath] - host directory for the script
 * @param {string} [sandboxPath] - sandbox-visible path corresponding to hostPath
 * @param {{ username?: string }} [options]
 * @returns {{ env: { GIT_ASKPASS: string, GIT_ASKPASS_TOKEN: string, ... }, cleanup: () => void }}
 */
function buildCredentialEnv(token, hostPath, sandboxPath, options = {}) {
    const scriptPath = getOrCreateAskpassScript(hostPath);
    const scriptName = path.basename(scriptPath);
    const askpassSubdir = '.xensemble/git';
    // sandboxPath 是沙箱内的工作目录路径，git 在沙箱内运行时通过这个路径访问脚本
    const sandboxScriptPath = sandboxPath
        ? path.join(sandboxPath, askpassSubdir, scriptName)
        : scriptPath;
    const env = {
        GIT_ASKPASS: sandboxScriptPath,
        GIT_ASKPASS_TOKEN: token,
    };
    if (options.username) {
        env.GIT_CONFIG_COUNT = '1';
        env.GIT_CONFIG_KEY_0 = 'credential.username';
        env.GIT_CONFIG_VALUE_0 = options.username;
    }
    return {
        env,
        cleanup: () => { /* cached script, reused across calls */ },
    };
}

module.exports = {
    stripCredentialFromUrl,
    createAskpassScript,
    removeAskpassScript,
    buildCredentialEnv,
    getOrCreateAskpassScript,
};
