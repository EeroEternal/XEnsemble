const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
    DEPENDENCY_EXCLUDE_SCRIPT,
    DEPENDENCY_EXCLUDE_ENTRIES,
} = require('./dependencyExclude');

function hasSh() {
    return spawnSync('sh', ['-c', 'true']).status === 0;
}

function hasGit() {
    return spawnSync('git', ['--version']).status === 0;
}

function runScript(cwd) {
    return spawnSync('sh', ['-c', DEPENDENCY_EXCLUDE_SCRIPT], { cwd, encoding: 'utf8' });
}

function makeTempRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-exclude-'));
    spawnSync('git', ['init', '-q'], { cwd: dir });
    return dir;
}

describe('dependencyExclude', () => {
    it('appends all entries to .git/info/exclude and is idempotent', { skip: !hasSh() || !hasGit() ? 'sh/git unavailable' : false }, () => {
        const dir = makeTempRepo();
        try {
            const r1 = runScript(dir);
            assert.strictEqual(r1.status, 0);
            assert.ok(r1.stdout.includes('EXCLUDE_OK'), 'script must report success');

            const excludePath = path.join(dir, '.git', 'info', 'exclude');
            assert.ok(fs.existsSync(excludePath), '.git/info/exclude must be created');
            const first = fs.readFileSync(excludePath, 'utf8');
            for (const entry of DEPENDENCY_EXCLUDE_ENTRIES) {
                assert.ok(first.split('\n').includes(entry), `missing entry: ${entry}`);
            }

            const r2 = runScript(dir);
            assert.strictEqual(r2.status, 0);
            const second = fs.readFileSync(excludePath, 'utf8');
            assert.strictEqual(second, first, 'second run must not duplicate entries');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('never removes user-managed exclude rules', { skip: !hasSh() || !hasGit() ? 'sh/git unavailable' : false }, () => {
        const dir = makeTempRepo();
        try {
            runScript(dir);
            const excludePath = path.join(dir, '.git', 'info', 'exclude');
            fs.appendFileSync(excludePath, 'my-custom-rule/\n');
            runScript(dir);
            const content = fs.readFileSync(excludePath, 'utf8');
            assert.ok(content.split('\n').includes('my-custom-rule/'), 'user rule must survive');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('is a no-op outside a git repo', { skip: !hasSh() ? 'sh unavailable' : false }, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-exclude-nogit-'));
        try {
            const r = runScript(dir);
            assert.strictEqual(r.status, 0);
            assert.ok(!r.stdout.includes('EXCLUDE_OK'), 'must skip when .git is absent');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('actually hides node_modules from git status (end-to-end)', { skip: !hasSh() || !hasGit() ? 'sh/git unavailable' : false }, () => {
        const dir = makeTempRepo();
        try {
            fs.mkdirSync(path.join(dir, 'node_modules', 'express', 'lib'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'node_modules', 'express', 'lib', 'index.js'), 'x\n');
            fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)\n');

            const before = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
            assert.ok(before.stdout.includes('node_modules/'), 'sanity: node_modules visible before exclude');

            runScript(dir);

            const after = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
            assert.ok(!after.stdout.includes('node_modules'), 'node_modules must be invisible after exclude');
            assert.ok(after.stdout.includes('app.js'), 'user files must remain visible');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
