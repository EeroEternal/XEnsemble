const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootstrapTestDb } = require('../test/db');

describe('agentBootstrap', () => {
    let tmpDir;
    let ctx;
    let ensureAgentBootstrap;
    let shouldRunSetup;
    let readSetupStatus;
    let seedAgentWorkspaceFiles;

    before(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xensemble-bootstrap-'));
        ctx = await bootstrapTestDb([
            './agentBootstrap',
            '../repositories/RepositoryEnvironmentService',
            '../events/recordEvent',
        ], __dirname);
        ({
            ensureAgentBootstrap,
            shouldRunSetup,
            readSetupStatus,
            seedAgentWorkspaceFiles,
            ensureGitignoreEntries,
        } = ctx.reloaded['./agentBootstrap']);
    });

    after(async () => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        await ctx.teardown();
    });

    it('seeds setup script, AGENTS.md, and resume; does not seed preview.json (handled by two-stage deploy)', () => {
        const ws = path.join(tmpDir, 'seed');
        fs.mkdirSync(ws, { recursive: true });
        seedAgentWorkspaceFiles(ws);
        assert.ok(fs.existsSync(path.join(ws, '.agents', 'setup')));
        assert.ok(fs.existsSync(path.join(ws, '.agents', 'resume')));
        assert.ok(fs.existsSync(path.join(ws, '.agents', 'AGENTS.md')));
        // .agents/preview.json is intentionally NOT seeded at workspace
        // bootstrap; it is the output of a successful two-stage deploy.
        assert.ok(!fs.existsSync(path.join(ws, '.agents', 'preview.json')));
        // Starter index.html still ships for an empty workspace so the
        // preview iframe isn't completely blank.
        assert.ok(fs.existsSync(path.join(ws, 'index.html')));
    });

    it('does not create .gitignore during seed (clone-safe)', () => {
        const ws = path.join(tmpDir, 'no-gitignore');
        fs.mkdirSync(ws, { recursive: true });
        seedAgentWorkspaceFiles(ws);
        assert.ok(!fs.existsSync(path.join(ws, '.gitignore')));
    });

    it('ensures .gitignore contains .agents/ and .xensemble/', () => {
        const ws = path.join(tmpDir, 'gitignore');
        fs.mkdirSync(ws, { recursive: true });
        ensureGitignoreEntries(ws);
        const gi = fs.readFileSync(path.join(ws, '.gitignore'), 'utf8');
        assert.match(gi, /\.agents\//);
        assert.match(gi, /\.xensemble\//);
    });

    it('appends to existing .gitignore without clobbering', () => {
        const ws = path.join(tmpDir, 'gitignore-existing');
        fs.mkdirSync(ws, { recursive: true });
        fs.writeFileSync(path.join(ws, '.gitignore'), 'node_modules/\n*.log\n', 'utf8');
        ensureGitignoreEntries(ws);
        const gi = fs.readFileSync(path.join(ws, '.gitignore'), 'utf8');
        assert.ok(gi.startsWith('node_modules/\n*.log\n'));
        assert.match(gi, /\.agents\//);
        assert.match(gi, /\.xensemble\//);
    });

    it('does not duplicate entries on re-seed', () => {
        const ws = path.join(tmpDir, 'gitignore-idempotent');
        fs.mkdirSync(ws, { recursive: true });
        ensureGitignoreEntries(ws);
        ensureGitignoreEntries(ws);
        const gi = fs.readFileSync(path.join(ws, '.gitignore'), 'utf8');
        const matches = gi.match(/\.agents\//g);
        assert.equal(matches.length, 1);
    });

    it('runs setup once and skips when hash unchanged', async () => {
        const projectId = `proj_${Date.now()}`;
        const userId = `usr_${Date.now()}`;
        const { schema } = ctx;
        await ctx.db.insert(schema.users).values({
            id: userId,
            username: `bootstrap_${Date.now()}`,
            passwordHash: 'hash',
            role: 'admin',
            status: 'active',
            createdAt: Date.now(),
        });
        await ctx.db.insert(schema.projects).values({
            id: projectId,
            userId,
            name: 'bootstrap test',
            serverPath: '',
            createdAt: Date.now(),
        });
        const project = { id: projectId, userId };
        const ws = path.join(tmpDir, 'ws1');
        fs.mkdirSync(ws, { recursive: true });
        seedAgentWorkspaceFiles(ws);

        const first = await ensureAgentBootstrap(project, ws);
        assert.equal(first.status, 'completed');
        assert.ok(first.snapshot_id);

        assert.equal(shouldRunSetup(ws), false);
        const second = await ensureAgentBootstrap(project, ws);
        assert.equal(readSetupStatus(ws).snapshot_id, first.snapshot_id);
        assert.equal(second.snapshot_id, first.snapshot_id);
    });
});
