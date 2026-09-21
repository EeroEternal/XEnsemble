/**
 * Pre-trust workspace folder in GitHub Copilot CLI's ~/.copilot/config.json so
 * that the first interactive launch skips the "Confirm folder trust" dialog.
 * Without this, unattended sessions (LoopTask) stall on the trust dialog —
 * the injected task prompt is swallowed by it and never reaches the input box.
 *
 * copilot has no per-session stateDir in xensemble (config lives in the VM
 * HOME), so the permanent trust list is seeded in the shared ~/.copilot
 * config — once trusted, every later session boots straight to the prompt.
 *
 * 键名在不同版本/资料中存在两种写法（trusted_folders / trustedFolders），
 * 两个键都合并写入以兼容；copilot 自己会用它认识的那个键。
 *
 * @param {object} opts
 * @param {object} opts.runtime 执行面 runtime（runtime.exec 在 VM 内执行）
 * @param {string} [opts.runtimeRef] VM runtime 引用
 * @param {string} [opts.cwd] 要预信任的工作区绝对路径（VM 内路径，如 /workspace）
 * @param {object} [opts.log]
 */
async function ensureCopilotFolderTrusted({ runtime, runtimeRef, cwd, log }) {
    if (!cwd) return;
    // copilot 无独立 stateDir，配置固定在 VM 用户 HOME（~ 展开）
    const configPath = '~/.copilot/config.json';

    const readScript = `cat '${configPath}' 2>/dev/null || echo '{}'`;
    const readResult = await runtime.exec.exec(
        'sh', ['-c', readScript], {}, { runtimeRef, cwd: '/' },
    );
    let config;
    try {
        config = JSON.parse(readResult.stdout || '{}');
    } catch {
        config = {};
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};

    let changed = false;
    for (const key of ['trusted_folders', 'trustedFolders']) {
        const list = Array.isArray(config[key]) ? config[key].filter((v) => typeof v === 'string') : [];
        if (!list.includes(cwd)) {
            config[key] = [...list, cwd];
            changed = true;
        }
    }
    if (!changed) return;

    // heredoc 带引号定界符：JSON 内容不做任何 shell 展开
    const writeScript = `mkdir -p '~/.copilot' && cat > '${configPath}' << 'COPILOT_JSON_EOF'\n${JSON.stringify(config, null, 2)}\nCOPILOT_JSON_EOF`;
    await runtime.exec.exec(
        'sh', ['-c', writeScript], {}, { runtimeRef, cwd: '/' },
    );
    log?.info?.({ cwd }, '[copilot-bootstrap] folder trust pre-seeded');
}

module.exports = { ensureCopilotFolderTrusted };
