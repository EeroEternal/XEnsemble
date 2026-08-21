const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { probeAgent, enrichPath } = require('./agentProbe');

const TIMEOUT_MS = 10 * 60 * 1000;
const VERSION_TIMEOUT_MS = 15 * 1000;

const AGENT_LIFECYCLE = {
    'kimi-code': {
        install: 'npm install -g @moonshot-ai/kimi-code',
        uninstall: 'npm uninstall -g @moonshot-ai/kimi-code',
        update: 'npm install -g @moonshot-ai/kimi-code@latest',
        npmPackage: '@moonshot-ai/kimi-code',
    },
    'claude-code': {
        install: 'npm install -g @anthropic-ai/claude-code',
        uninstall: 'npm uninstall -g @anthropic-ai/claude-code',
        update: 'npm install -g @anthropic-ai/claude-code@latest',
        npmPackage: '@anthropic-ai/claude-code',
    },
    'cursor': {
        install: 'curl https://cursor.com/install -fsS | bash',
        uninstall: 'rm -f "$HOME/.local/bin/cursor" "$HOME/.local/bin/cursor-agent" "$HOME/.local/bin/agent"',
        update: 'curl https://cursor.com/install -fsS | bash',
    },
    'amp': {
        install: 'curl -fsSL https://ampcode.com/install.sh | bash',
        uninstall: 'npm uninstall -g @ampcode/cli @sourcegraph/amp 2>/dev/null; rm -f "$HOME/.local/bin/amp"',
        update: 'amp update 2>/dev/null || curl -fsSL https://ampcode.com/install.sh | bash',
        npmPackage: '@ampcode/cli',
    },
    'droid': {
        install: 'curl -fsSL https://app.factory.ai/cli | sh',
        uninstall: 'npm uninstall -g @factory/cli droid 2>/dev/null; rm -f "$HOME/.local/bin/droid" "$HOME/.local/bin/factoryd"',
        update: 'curl -fsSL https://app.factory.ai/cli | sh',
        npmPackage: '@factory/cli',
    },
    'commandcode': {
        install: 'npm install -g command-code@latest',
        uninstall: 'npm uninstall -g command-code',
        update: 'npm install -g command-code@latest',
        npmPackage: 'command-code',
    },
    'hermes': {
        preInstall: 'rm -rf "$HOME/.hermes/hermes-agent" "$HOME/.hermes"/hermes-agent.broken-* 2>/dev/null; true',
        install: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-setup',
        uninstall: 'rm -rf "$HOME/.hermes"; rm -f "$HOME/.local/bin/hermes"',
        update: 'hermes update',
    },
    'openclaw': {
        install: 'npm install -g openclaw@latest',
        uninstall: 'npm uninstall -g openclaw; rm -rf "$HOME/.openclaw"',
        update: 'npm install -g openclaw@latest',
        npmPackage: 'openclaw',
    },
    'opencode': {
        install: 'curl -fsSL https://opencode.ai/install | bash',
        uninstall: 'npm uninstall -g opencode-ai 2>/dev/null; rm -f "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode"',
        update: 'npm install -g opencode-ai@latest',
        npmPackage: 'opencode-ai',
    },
    'cline': {
        install: 'npm install -g cline@3.0.55',
        uninstall: 'npm uninstall -g cline',
        update: 'npm install -g cline@3.0.55',
        npmPackage: 'cline',
    },
    'codebuddy': {
        install: 'npm install -g @tencent-ai/codebuddy-code',
        uninstall: 'npm uninstall -g @tencent-ai/codebuddy-code',
        update: 'npm install -g @tencent-ai/codebuddy-code@latest',
        npmPackage: '@tencent-ai/codebuddy-code',
    },
    'glm-agent': {
        install: 'npm install -g @guizmo-ai/zai-cli',
        uninstall: 'npm uninstall -g @guizmo-ai/zai-cli',
        update: 'npm install -g @guizmo-ai/zai-cli@latest',
        npmPackage: '@guizmo-ai/zai-cli',
    },
    'qoder': {
        install: 'npm install -g @qoder-ai/qodercli',
        uninstall: 'npm uninstall -g @qoder-ai/qodercli',
        update: 'npm install -g @qoder-ai/qodercli@latest',
        npmPackage: '@qoder-ai/qodercli',
    },
    'qwen-code': {
        install: 'npm install -g @qwen-code/qwen-code@latest',
        uninstall: 'npm uninstall -g @qwen-code/qwen-code',
        update: 'npm install -g @qwen-code/qwen-code@latest',
        npmPackage: '@qwen-code/qwen-code',
    },
    'minimax-cli': {
        install: 'npm install -g mmx-cli',
        uninstall: 'npm uninstall -g mmx-cli',
        update: 'npm install -g mmx-cli@latest',
        npmPackage: 'mmx-cli',
    },
    'pi': {
        install: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
        uninstall: 'npm uninstall -g @earendil-works/pi-coding-agent',
        update: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest',
        npmPackage: '@earendil-works/pi-coding-agent',
    },
    'github-copilot': {
        install: 'npm install -g @github/copilot',
        uninstall: 'npm uninstall -g @github/copilot',
        update: 'npm install -g @github/copilot@latest',
        npmPackage: '@github/copilot',
    },
};

function getManifest(agentId, cmd) {
    if (AGENT_LIFECYCLE[agentId]) return AGENT_LIFECYCLE[agentId];
    const pkg = cmd || agentId;
    return {
        install: `npm install -g ${pkg}`,
        uninstall: `npm uninstall -g ${pkg}`,
        update: `npm install -g ${pkg}@latest`,
        npmPackage: pkg,
    };
}

function getInstallCommand(agentId) {
    return getManifest(agentId).install;
}

function shellEnv() {
    const nodeBinDir = path.dirname(process.execPath);
    const basePath = [nodeBinDir, process.env.PATH || '']
        .filter(Boolean)
        .join(path.delimiter);
    return {
        ...process.env,
        PATH: enrichPath({ ...process.env, PATH: basePath }),
    };
}

async function runCommand(command, timeout = TIMEOUT_MS) {
    const { stdout, stderr } = await execAsync(command, {
        env: shellEnv(),
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        shell: true,
    });
    return { stdout: stdout?.trim(), stderr: stderr?.trim() };
}

function parseVersion(output) {
    if (!output) return null;
    const match = output.match(/(\d+\.\d+\.\d+(?:[-+.\w]*)?)/);
    return match ? match[1] : output.split('\n')[0].trim().slice(0, 80) || null;
}

async function getLocalVersion(cmd) {
    const flags = ['--version', 'version', '-v'];
    for (const flag of flags) {
        try {
            const { stdout, stderr } = await execAsync(`${cmd} ${flag} 2>&1`, {
                env: shellEnv(),
                timeout: VERSION_TIMEOUT_MS,
                shell: true,
            });
            const parsed = parseVersion(stdout || stderr);
            if (parsed) return parsed;
        } catch {
            /* try next flag */
        }
    }
    return null;
}

async function getNpmLatest(packageName) {
    try {
        const { stdout } = await execAsync(`npm view ${packageName} version`, {
            env: shellEnv(),
            timeout: VERSION_TIMEOUT_MS,
            shell: true,
        });
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

function compareVersions(a, b) {
    if (!a || !b) return 0;
    // Split numeric core from pre-release suffix (e.g. "1.0.0-beta.1")
    const coreA = a.replace(/^v/, '');
    const coreB = b.replace(/^v/, '');
    const [numA, preA] = coreA.split('-', 2);
    const [numB, preB] = coreB.split('-', 2);
    const pa = numA.split('.').map((x) => parseInt(x, 10) || 0);
    const pb = numB.split('.').map((x) => parseInt(x, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i += 1) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    // Numeric cores are equal — apply SemVer pre-release precedence:
    //   - no pre-release > has pre-release (1.0.0 > 1.0.0-beta)
    //   - pre-release segments compared per SemVer §11:
    //     numeric segments compared as integers, string segments lexically,
    //     shorter pre-release < longer when all preceding segments are equal.
    if (!preA && !preB) return 0;
    if (!preA) return 1;   // a is release, b is pre-release => a > b
    if (!preB) return -1;  // b is release, a is pre-release => b > a
    const segA = preA.split('.');
    const segB = preB.split('.');
    const segLen = Math.max(segA.length, segB.length);
    for (let i = 0; i < segLen; i += 1) {
        if (segA[i] === undefined) return -1; // a has fewer segments => a < b
        if (segB[i] === undefined) return 1;  // b has fewer segments => a > b
        const aNum = /^[0-9]+$/.test(segA[i]) ? parseInt(segA[i], 10) : NaN;
        const bNum = /^[0-9]+$/.test(segB[i]) ? parseInt(segB[i], 10) : NaN;
        if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
            if (aNum < bNum) return -1;
            if (aNum > bNum) return 1;
        } else {
            if (segA[i] < segB[i]) return -1;
            if (segA[i] > segB[i]) return 1;
        }
    }
    return 0;
}

async function installAgent(agent) {
    const manifest = getManifest(agent.id, agent.cmd);
    const existing = probeAgent(agent.cmd);
    if (existing.installed) {
        return { ok: true, already_installed: true, path: existing.path };
    }

    try {
        if (manifest.preInstall) {
            await runCommand(manifest.preInstall, 60000);
        }
        const { stdout, stderr } = await runCommand(manifest.install);
        const after = probeAgent(agent.cmd);
        if (!after.installed) {
            const err = new Error(
                `Install finished but "${agent.cmd}" is still not on PATH. ${(stdout || stderr || '').slice(0, 500)}`,
            );
            err.statusCode = 500;
            throw err;
        }
        return { ok: true, path: after.path, stdout: stdout?.slice(0, 2000), stderr: stderr?.slice(0, 2000) };
    } catch (err) {
        if (err.statusCode) throw err;
        const detail = [err.stderr, err.stdout].filter(Boolean).join('\n').trim();
        const suffix = detail ? `: ${detail.slice(-500)}` : '';
        const wrapped = new Error(`Install failed${suffix}`);
        wrapped.statusCode = 500;
        throw wrapped;
    }
}

async function uninstallAgent(agent) {
    const manifest = getManifest(agent.id, agent.cmd);
    const before = probeAgent(agent.cmd);
    if (!before.installed) {
        return { ok: true, already_removed: true };
    }

    try {
        const { stdout, stderr } = await runCommand(manifest.uninstall);
        const after = probeAgent(agent.cmd);
        if (after.installed) {
            const err = new Error(
                `Uninstall finished but "${agent.cmd}" is still present at ${after.path}. ${(stdout || stderr || '').slice(0, 500)}`,
            );
            err.statusCode = 500;
            throw err;
        }
        return { ok: true, stdout: stdout?.slice(0, 2000), stderr: stderr?.slice(0, 2000) };
    } catch (err) {
        if (err.statusCode) throw err;
        const wrapped = new Error(`Uninstall failed: ${err.message}`);
        wrapped.statusCode = 500;
        throw wrapped;
    }
}

async function updateAgent(agent) {
    const manifest = getManifest(agent.id, agent.cmd);
    const before = probeAgent(agent.cmd);
    if (!before.installed) {
        const err = new Error(`"${agent.name}" is not installed. Install it first.`);
        err.statusCode = 400;
        throw err;
    }

    try {
        const { stdout, stderr } = await runCommand(manifest.update);
        const after = probeAgent(agent.cmd);
        const localVersion = await getLocalVersion(agent.cmd);
        return {
            ok: true,
            path: after.path,
            local_version: localVersion,
            stdout: stdout?.slice(0, 2000),
            stderr: stderr?.slice(0, 2000),
        };
    } catch (err) {
        if (err.statusCode) throw err;
        const wrapped = new Error(`Update failed: ${err.message}`);
        wrapped.statusCode = 500;
        throw wrapped;
    }
}

async function checkUpdate(agent) {
    const manifest = getManifest(agent.id, agent.cmd);
    const probe = probeAgent(agent.cmd);
    if (!probe.installed) {
        return {
            installed: false,
            local_version: null,
            latest_version: null,
            update_available: false,
        };
    }

    const localVersion = await getLocalVersion(agent.cmd);
    let latestVersion = null;
    let updateAvailable = false;

    if (manifest.npmPackage) {
        latestVersion = await getNpmLatest(manifest.npmPackage);
        updateAvailable = Boolean(
            localVersion && latestVersion && compareVersions(localVersion, latestVersion) < 0,
        );
    }

    return {
        installed: true,
        local_version: localVersion,
        latest_version: latestVersion,
        update_available: updateAvailable,
        path: probe.path,
    };
}

module.exports = {
    getManifest,
    getInstallCommand,
    installAgent,
    uninstallAgent,
    updateAgent,
    checkUpdate,
    getLocalVersion,
};
