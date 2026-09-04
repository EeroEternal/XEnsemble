'use strict';

/**
 * Runtime toolchain detector.
 *
 * Probes the boxlite sandbox (or any runtime) for which dev tooling is
 * actually present, so the LLM analyze / verify agents can be told the
 * truth about their environment instead of trusting a stale prompt.
 *
 * IMPORTANT: this is the only authoritative source of "what tools are
 * available". The LLM system prompt used to lie ("sandbox has
 * node/python/go/cargo") and that led to 14-minute verify loops trying
 * to `go build` on an image that ships only Node. AI-side constraints are
 * unreliable, so we always re-probe here on the host and inject the real
 * inventory into the prompt.
 *
 * Detection order: which-based first, then `command -v` fallback for
 * tools that may not respond to `--version` (e.g. broken installs).
 *
 * @typedef {object} ToolInfo
 * @property {string}  command   - binary name (`go`, `node`, `cargo`, ...)
 * @property {boolean} available - present on PATH and runnable
 * @property {string|null} version - `--version` first line, normalized
 * @property {string|null} path    - absolute path to the binary
 */

const fs = require('fs');
const path = require('path');

const { getRuntime } = require('../runtime/registry');

/**
 * Tooling inventory we care about. Order is informational only; the LLM
 * prompt groups them by language family (node, python, go, rust, jvm).
 */
const TRACKED_TOOLS = [
    // Node / JS — always present (boxlite base installs node 22), but we
    // probe anyway because pnpm/yarn may differ per project.
    { cmd: 'node', language: 'node', required: false },
    { cmd: 'npm', language: 'node', required: false },
    { cmd: 'pnpm', language: 'node', required: false },
    { cmd: 'yarn', language: 'node', required: false },
    { cmd: 'corepack', language: 'node', required: false },
    // Python — Debian's `python3` is in the base image; pip may not be.
    { cmd: 'python3', language: 'python', required: false },
    { cmd: 'pip', language: 'python', required: false },
    { cmd: 'pip3', language: 'python', required: false },
    // Go — NOT in boxlite base; installed via apt-get on demand.
    { cmd: 'go', language: 'go', required: false },
    // Rust — NOT in boxlite base.
    { cmd: 'cargo', language: 'rust', required: false },
    { cmd: 'rustc', language: 'rust', required: false },
    // JVM — NOT in boxlite base.
    { cmd: 'java', language: 'jvm', required: false },
    { cmd: 'mvn', language: 'jvm', required: false },
    { cmd: 'gradle', language: 'jvm', required: false },
    // C/C++ toolchain — needed by node-gyp for native modules.
    { cmd: 'make', language: 'native', required: false },
    { cmd: 'gcc', language: 'native', required: false },
    { cmd: 'python', language: 'native', required: false }, // node-gyp needs `python` (not python3) on some distros
    // Health-check utility.
    { cmd: 'curl', language: 'net', required: false },
];

/**
 * Probe a single binary. Returns the ToolInfo record; never throws.
 * Strategy: try `which` first (returns the absolute path), then ask
 * `--version`. If either errors, the tool is unavailable.
 *
 * @param {object} runtime - getRuntime() result
 * @param {string} runtimeRef
 * @param {string} cwd
 * @param {string} cmd
 * @returns {Promise<ToolInfo>}
 */
async function probeOne(runtime, runtimeRef, cwd, cmd) {
    let path_ = null;
    let available = false;
    let version = null;
    try {
        const r = await runtime.exec.exec(
            'sh',
            ['-c', `command -v ${cmd} 2>/dev/null`],
            {},
            { runtimeRef, cwd, timeoutMs: 4000 },
        );
        const line = String(r.stdout || '').trim().split('\n')[0].trim();
        if (line && line !== cmd) {
            path_ = line;
        } else if (line === cmd) {
            // `command -v` echoes the literal name when it's a function/alias;
            // treat as available but unknown path.
            path_ = null;
        }
        if (line) available = true;
    } catch { /* ignore — tool missing or exec errored */ }
    if (available) {
        try {
            const r = await runtime.exec.exec(
                'sh',
                ['-c', `${cmd} --version 2>&1 | head -1`],
                {},
                { runtimeRef, cwd, timeoutMs: 4000 },
            );
            const raw = String(r.stdout || '').trim().split('\n')[0].trim();
            // Strip the binary name prefix when it appears (e.g. "go version go1.22.3" → "go1.22.3").
            version = raw.replace(new RegExp(`^${cmd}\\s+(version\\s+)?`, 'i'), '').trim() || raw;
        } catch { /* --version not supported; still mark as available */ }
    }
    return { command: cmd, available, version: version || null, path: path_ };
}

/**
 * Probe every tracked tool. Always returns (even on partial failure);
 * the caller decides how to handle the inventory. We run probes in
 * parallel to keep the wall clock at one tool's worth of latency rather
 * than N. Each probe has a 4s timeout, so the overall budget is ~4s.
 *
 * @param {string|object} runtimeRefOrRuntime - runtimeRef string, or
 *     pass a pre-resolved runtime object directly (used by tests to
 *     inject a mock; production code passes the runtimeRef and the
 *     helper resolves getRuntime() itself).
 * @param {string} [cwd='/workspace']
 * @returns {Promise<ToolInfo[]>}
 */
async function detectRuntimeToolchain(runtimeRefOrRuntime, cwd = '/workspace') {
    const isRuntimeObject = runtimeRefOrRuntime && typeof runtimeRefOrRuntime.exec?.exec === 'function';
    const runtime = isRuntimeObject ? runtimeRefOrRuntime : getRuntime();
    const runtimeRef = isRuntimeObject ? null : runtimeRefOrRuntime;
    if (!runtime?.exec?.exec) {
        return TRACKED_TOOLS.map((t) => ({ command: t.cmd, available: false, version: null, path: null }));
    }
    const probes = TRACKED_TOOLS.map((t) => probeOne(runtime, runtimeRef, cwd, t.cmd).catch(() => ({
        command: t.cmd, available: false, version: null, path: null,
    })));
    return Promise.all(probes);
}

/**
 * Group the inventory by language family for prompt injection.
 *
 * @param {ToolInfo[]} inventory
 * @returns {Record<string, {available: string[], missing: string[]}>}
 */
function groupByLanguage(inventory) {
    const groups = {};
    for (const t of TRACKED_TOOLS) {
        const g = t.language;
        if (!groups[g]) groups[g] = { available: [], missing: [] };
        const entry = inventory.find((i) => i.command === t.cmd);
        if (entry?.available) {
            const v = entry.version ? ` (${entry.version})` : '';
            groups[g].available.push(`${t.cmd}${v}`);
        } else {
            groups[g].missing.push(t.cmd);
        }
    }
    return groups;
}

/**
 * Render the inventory as a prompt block for the analyze / verify LLM.
 * The block explicitly says which tools are MISSING so the LLM is not
 * tempted to call `go build` when `go` is absent — and tells it that
 * `apt-get install` is the way to bring missing tools in.
 *
 * @param {ToolInfo[]} inventory
 * @returns {string}
 */
function renderToolchainBlock(inventory) {
    const groups = groupByLanguage(inventory);
    const lines = [];
    lines.push('SANDBOX TOOLCHAIN (probed live with `command -v`, not a guess — trust this list):');
    for (const [lang, info] of Object.entries(groups)) {
        if (info.available.length) {
            lines.push(`  ${lang}: available = ${info.available.join(', ')}`);
        }
        if (info.missing.length) {
            lines.push(`  ${lang}: missing  = ${info.missing.join(', ')}`);
        }
    }
    lines.push('');
    lines.push('If a step needs a tool listed as `missing`, install it with `apt-get update && apt-get install -y <package>` — the apt mirror is already switched to a fast CN mirror (~1 minute). MANDATORY: use apt-get ONLY. NEVER download official tarballs (go.dev/golang.org/dl), NEVER compile from source — those paths take 4-5+ minutes each and routinely blow the deploy time budget. If a specific Node version is REQUIRED (engines/.nvmrc) and apt has no matching package, use `NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node nvm install <ver>` (CN mirror) as the ONLY exception. The boxlite base image is Debian bookworm-slim; common package names:');
    lines.push('  - go:        golang-go            (or golang-1.22 for a pinned version)');
    lines.push('  - cargo:     cargo                (in /usr/bin/cargo; ~150MB)');
    lines.push('  - python3:   python3 python3-pip  (python3 is shipped but pip often missing)');
    lines.push('  - java/mvn:  default-jdk maven    (~300MB; avoid unless project is JVM-only)');
    lines.push('  - native build (for node-gyp): build-essential python3');
    lines.push('  - postgres:  postgresql postgresql-contrib   (if project has a Postgres dep)');
    lines.push('CN MIRRORS ALREADY CONFIGURED system-wide: npm/pnpm → registry.npmmirror.com, pip → tsinghua pypi, go → goproxy.cn, cargo → rsproxy.cn, maven → aliyun. Just run the package managers normally — do NOT pass any custom registry/index flags.');
    lines.push('NEVER spend rounds trying to `command -v` or `which` the same missing tool — either install it via apt-get or pick a sub-project that does NOT need it.');
    return lines.join('\n');
}

/**
 * Apt-get install helper that the analyze / verify LLM can call as a
 * run_shell tool. Returns stdout/stderr in the same shape as the runtime
 * exec adapter. Heavy packages (cargo, openjdk) are slow (~1-2 minutes
 * first time); the verify agent should set a long timeout.
 *
 * This is the code-side constraint the user asked for: "只有代码的
 * 约束才是稳定的". After this helper returns successfully, the LLM
 * must re-probe the tool via detectRuntimeToolchain to confirm the
 * install actually worked (apt-get may fail silently on lock contention).
 *
 * @param {string|object} runtimeRefOrRuntime
 * @param {string[]} packages
 * @param {string} [cwd='/workspace']
 */
async function aptInstall(runtimeRefOrRuntime, packages, cwd = '/workspace') {
    if (!Array.isArray(packages) || packages.length === 0) {
        throw new Error('aptInstall requires a non-empty package list');
    }
    const isRuntimeObject = runtimeRefOrRuntime && typeof runtimeRefOrRuntime.exec?.exec === 'function';
    const runtime = isRuntimeObject ? runtimeRefOrRuntime : getRuntime();
    const runtimeRef = isRuntimeObject ? null : runtimeRefOrRuntime;
    const cmd = `set -e; apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages.map((p) => p.replace(/[^A-Za-z0-9+._-]/g, '')).join(' ')}`;
    return runtime.exec.exec('sh', ['-c', cmd], {}, { runtimeRef, cwd, timeoutMs: 600000 });
}

module.exports = {
    detectRuntimeToolchain,
    probeOne,
    groupByLanguage,
    renderToolchainBlock,
    aptInstall,
    TRACKED_TOOLS,
};
