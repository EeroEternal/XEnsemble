/**
 * Host-side git helpers for providers whose workspace is visible on the host
 * (local disk, or BoxLite virtiofs mount).
 */
const { spawn } = require('child_process');
const { resolveRuntimeProvider } = require('../config/runtimeProvider');

/** Providers whose workspace lives on (or is virtiofs-mounted from) the host. */
function usesHostWorkspace() {
    const provider = resolveRuntimeProvider();
    return provider === 'local' || provider === 'boxlite';
}

/**
 * Run git on the host filesystem.
 * Must not be used for guest-only paths that are not visible on the host.
 */
function hostGit(cwd, args, options = {}) {
    return new Promise((resolve, reject) => {
        // -c safe.directory=* 绕过 "dubious ownership"：server 常以 root 运行，
        // 而 workspace 目录可能属主为运行服务用户（administrator），git 默认拒绝访问，
        // 导致分支/status 拉取失败。
        const child = spawn('git', ['-c', 'safe.directory=*', ...args], {
            cwd,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(options.env || {}) },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`git ${args[0]} timed out`));
        }, options.timeoutMs || 30_000);
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                const err = new Error(`git ${args[0]} failed: ${stderr || stdout}`);
                err.exitCode = code;
                reject(err);
                return;
            }
            resolve({ exitCode: 0, stdout, stderr });
        });
    });
}

module.exports = { hostGit, usesHostWorkspace };
