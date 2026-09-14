const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const promptCapture = require('./promptCapture');

function listFiles(root) {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (!e.name.endsWith('.tmp')) out.push(p);
        }
    };
    walk(root);
    return out.sort();
}

function makeEnv(overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xe-prompt-capture-'));
    process.env.LLM_CAPTURE_MODE = overrides.mode ?? 'turns';
    process.env.LLM_CAPTURE_DIR = dir;
    process.env.LLM_CAPTURE_TURNS = String(overrides.turns ?? 2);
    process.env.LLM_CAPTURE_MAX_BYTES = String(overrides.maxBytes ?? 8 * 1024 * 1024);
    process.env.LLM_CAPTURE_MAX_TOTAL_MB = String(overrides.maxTotalMB ?? 2048);
    process.env.LLM_CAPTURE_RETENTION_DAYS = String(overrides.retentionDays ?? 7);
    promptCapture.reloadForTest();
    return dir;
}

const CLAIMS = { sid: 'sess-test1', uid: 'u1', pid: 'p1', aid: 'claude-code', model: null };

function body(obj) {
    return Buffer.from(JSON.stringify(obj));
}

test('promptCapture: turns 模式按会话前 N 个请求落盘，目录按 agent/session 分层', async () => {
    const dir = makeEnv({ mode: 'turns', turns: 2 });
    const raw1 = body({
        model: 'claude-sonnet-4',
        system: 'You are Claude Code...',
        messages: [{ role: 'user', content: 'hello' }],
    });
    await promptCapture.capture(CLAIMS, '/v1/messages?beta=true', raw1, 'claude-sonnet-4');
    await promptCapture.capture(CLAIMS, '/v1/messages', body({
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: 'again' }],
    }), 'claude-sonnet-4');
    // 第 3 个请求超出窗口，不落盘
    await promptCapture.capture(CLAIMS, '/v1/messages', body({
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: 'third' }],
    }), 'claude-sonnet-4');

    const files = listFiles(dir);
    assert.equal(files.length, 2);
    assert.ok(files[0].includes(`${path.sep}claude-code${path.sep}sess-test1${path.sep}`));

    const rec1 = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    const rec2 = JSON.parse(fs.readFileSync(files[1], 'utf8'));
    assert.equal(rec1.meta.turn, 1);
    assert.equal(rec2.meta.turn, 2);
    assert.equal(rec1.meta.agent, 'claude-code');
    assert.equal(rec1.meta.session_id, 'sess-test1');
    assert.equal(rec1.meta.protocol, 'anthropic');
    assert.equal(rec1.meta.path, '/v1/messages');
    assert.equal(rec1.meta.model, 'claude-sonnet-4');
    assert.equal(rec1.meta.body_bytes, raw1.length);
    assert.ok(rec1.meta.ts > 0);
    assert.match(rec1.meta.captured_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(rec1.body.system, 'You are Claude Code...');
    assert.deepEqual(rec1.body.messages, [{ role: 'user', content: 'hello' }]);
    // 文件名含 turn 序号，按名排序即请求时序
    assert.match(path.basename(files[0]), /^t001_/);
    assert.match(path.basename(files[1]), /^t002_/);
});

test('promptCapture: first 模式只采每会话第 1 个请求', async () => {
    const dir = makeEnv({ mode: 'first' });
    await promptCapture.capture(CLAIMS, '/v1/chat/completions', body({ messages: [] }), null);
    await promptCapture.capture(CLAIMS, '/v1/chat/completions', body({ messages: [] }), null);
    const files = listFiles(dir);
    assert.equal(files.length, 1);
    const rec = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    assert.equal(rec.meta.turn, 1);
    assert.equal(rec.meta.protocol, 'openai');
});

test('promptCapture: off 模式显式关闭后不落盘', () => {
    const dir = makeEnv({ mode: 'off' });
    promptCapture.capture(CLAIMS, '/v1/messages', body({ messages: [] }), null);
    assert.equal(listFiles(dir).length, 0);
});

test('promptCapture: 未设置 LLM_CAPTURE_MODE 时默认 all 模式生效（零配置部署场景）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xe-prompt-capture-'));
    process.env.LLM_CAPTURE_DIR = dir;
    delete process.env.LLM_CAPTURE_MODE;
    promptCapture.reloadForTest();
    await promptCapture.capture(CLAIMS, '/v1/messages', body({ messages: [] }), null);
    await promptCapture.capture({ ...CLAIMS, sid: 'sess-b' }, '/v1/messages', body({ messages: [] }), null);
    // all 模式：每个请求都落盘，不做采样
    assert.equal(listFiles(dir).length, 2);
});

test('promptCapture: 不同会话独立计数，session 目录隔离', async () => {
    const dir = makeEnv({ mode: 'first' });
    await promptCapture.capture(CLAIMS, '/v1/messages', body({ messages: [] }), null);
    await promptCapture.capture({ ...CLAIMS, sid: 'sess-test2' }, '/v1/messages', body({ messages: [] }), null);
    const files = listFiles(dir);
    assert.equal(files.length, 2);
    assert.ok(files[0].includes(`${path.sep}sess-test1${path.sep}`));
    assert.ok(files[1].includes(`${path.sep}sess-test2${path.sep}`));
});

test('promptCapture: body 超过单请求上限 → oversize 元数据桩，不落原始 body', async () => {
    const dir = makeEnv({ mode: 'all', maxBytes: 64 });
    const big = body({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(512) }] });
    await promptCapture.capture(CLAIMS, '/v1/messages', big, 'm');
    const files = listFiles(dir);
    assert.equal(files.length, 1);
    assert.match(path.basename(files[0]), /_oversize\.json$/);
    const rec = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    assert.equal(rec.oversize, true);
    assert.equal(rec.body, null);
    assert.equal(rec.meta.body_bytes, big.length);
});

test('promptCapture: body 非 JSON → parse_error 元数据桩', async () => {
    const dir = makeEnv({ mode: 'all' });
    await promptCapture.capture(CLAIMS, '/v1/messages', Buffer.from('not-json'), null);
    const files = listFiles(dir);
    assert.equal(files.length, 1);
    assert.match(path.basename(files[0]), /_parse_error\.json$/);
    const rec = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    assert.equal(rec.parse_error, true);
    assert.equal(rec.body, null);
});

test('promptCapture: 保留期清理删除过期日期目录，保留当天', async () => {
    const dir = makeEnv({ mode: 'off', retentionDays: 7 });
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const oldDir = path.join(dir, fmt(old), 'claude-code', 'sess-old');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 't001_000000_000.json'), '{}');
    // 当天目录存在文件，必须保留
    const todayDir = path.join(dir, fmt(new Date()), 'qwen-code', 'sess-today');
    fs.mkdirSync(todayDir, { recursive: true });
    fs.writeFileSync(path.join(todayDir, 't001_000000_000.json'), '{}');

    await promptCapture.runMaintenance();
    assert.ok(!fs.existsSync(path.join(dir, fmt(old))), '过期日期目录应被删除');
    assert.ok(fs.existsSync(path.join(dir, fmt(new Date()))), '当天目录必须保留');
});

test('promptCapture: 总量配额超限从最旧日期目录删除，当天目录不删', async () => {
    const dir = makeEnv({ mode: 'off', maxTotalMB: 0.000001 }); // ≈1 byte 配额
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const mk = (daysAgo, name) => {
        const p = path.join(dir, fmt(new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)), 'a', 's');
        fs.mkdirSync(p, { recursive: true });
        fs.writeFileSync(path.join(p, 't001_000000_000.json'), JSON.stringify({ pad: 'x'.repeat(200) }));
        return fmt(new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000));
    };
    const d3 = mk(3, 'old3');
    const d1 = mk(1, 'old1');
    // 当天目录也有数据，必须保留（配额循环删到当天为止）
    const todayDir = path.join(dir, fmt(new Date()), 'a', 's');
    fs.mkdirSync(todayDir, { recursive: true });
    fs.writeFileSync(path.join(todayDir, 't001_000000_000.json'), '{}');
    const d0 = fmt(new Date());

    await promptCapture.runMaintenance();
    // 配额极小：最旧的先删，删到当天为止
    assert.ok(!fs.existsSync(path.join(dir, d3)));
    assert.ok(!fs.existsSync(path.join(dir, d1)));
    assert.ok(fs.existsSync(path.join(dir, d0)), '当天目录永不删除');
});
