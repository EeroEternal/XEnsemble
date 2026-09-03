// WORKSPACE_ROOT hardening: relative values must resolve against the repo root,
// not process.cwd(). Covers the dev-container "double-server" bug where
// `npm start` from <repo>/server with WORKSPACE_ROOT=./server/data/workspaces
// used to produce <repo>/server/server/data/workspaces.
//
// These tests load the module fresh per case by clearing the require cache so
// the top-level `const WORKSPACE_ROOT = ...` re-evaluates against the env we
// stage. They do NOT touch the real filesystem — the module only mkdirs the
// resolved path inside ensureWorkspaceRoot(), which the tests never call.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MODULE_PATH = require.resolve('../workspace');

function loadWorkspace(envValue) {
    delete require.cache[MODULE_PATH];
    if (envValue === undefined) {
        delete process.env.WORKSPACE_ROOT;
    } else {
        process.env.WORKSPACE_ROOT = envValue;
    }
    return require('../workspace');
}

describe('workspace.js WORKSPACE_ROOT resolution', () => {
    let savedEnv;
    before(() => { savedEnv = process.env.WORKSPACE_ROOT; });
    after(() => {
        if (savedEnv === undefined) delete process.env.WORKSPACE_ROOT;
        else process.env.WORKSPACE_ROOT = savedEnv;
    });

    it('resolves relative WORKSPACE_ROOT against the repo root, not process.cwd()', () => {
        // Simulate the dev-container bug: cwd is <repo>/server, env is the
        // .env.example default. The double-server path MUST NOT win.
        const origCwd = process.cwd();
        process.chdir(path.join(REPO_ROOT, 'server'));
        try {
            const ws = loadWorkspace('./server/data/workspaces');
            assert.equal(ws.WORKSPACE_ROOT, path.join(REPO_ROOT, 'server/data/workspaces'));
            assert.ok(!ws.WORKSPACE_ROOT.includes('/server/server/'),
                `WORKSPACE_ROOT must not be the double-server path; got ${ws.WORKSPACE_ROOT}`);
        } finally {
            process.chdir(origCwd);
        }
    });

    it('resolves the same relative value identically when cwd is the repo root', () => {
        // The intended dev scenario: `npm run dev` from <repo> with the same
        // .env value must produce the same absolute path as the buggy cwd.
        const origCwd = process.cwd();
        process.chdir(REPO_ROOT);
        try {
            const ws = loadWorkspace('./server/data/workspaces');
            assert.equal(ws.WORKSPACE_ROOT, path.join(REPO_ROOT, 'server/data/workspaces'));
        } finally {
            process.chdir(origCwd);
        }
    });

    it('passes absolute WORKSPACE_ROOT through unchanged (production path)', () => {
        const ws = loadWorkspace('/var/lib/xensemble/workspaces');
        assert.equal(ws.WORKSPACE_ROOT, '/var/lib/xensemble/workspaces');
    });

    it('falls back to the hardcoded default when WORKSPACE_ROOT is unset', () => {
        const ws = loadWorkspace(undefined);
        assert.equal(ws.WORKSPACE_ROOT, '/var/lib/xensemble/workspaces');
    });

    it('accepts a tmpdir absolute path (e2e test pattern)', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xe-wsroot-'));
        try {
            const ws = loadWorkspace(tmp);
            assert.equal(ws.WORKSPACE_ROOT, tmp);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('derives projectDir and worktreeDir from the resolved absolute root', () => {
        // cwd is <repo>/server with relative env — the OLD code produced
        // <repo>/server/server/data/workspaces (the bug). The hardened
        // resolve must produce the repo-root-anchored <repo>/server/data/workspaces.
        const origCwd = process.cwd();
        process.chdir(path.join(REPO_ROOT, 'server'));
        try {
            const ws = loadWorkspace('./server/data/workspaces');
            const expected = path.join(REPO_ROOT, 'server/data/workspaces');
            assert.equal(ws.WORKSPACE_ROOT, expected,
                'must not be the double-server path');
            assert.equal(ws.projectDir('u1', 'p1'), path.join(expected, 'u1', 'p1'));
            assert.equal(ws.worktreeDir('u1', 'p1', 'r1'), path.join(expected, 'u1', 'p1.wt', 'r1'));
        } finally {
            process.chdir(origCwd);
        }
    });
});
