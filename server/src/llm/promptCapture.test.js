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
    if (fs.existsSync(root)) walk(root);
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

const CLAIMS = { sid: 'sess-test1', uid: 'u1', pid: 'p1', aid: 'claude-code' };

function body(obj) {
    return Buffer.from(JSON.stringify(obj));
}

function readRecord(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('promptCapture: 默认格式 <agent>/<sessionId>.json，messages 按请求顺序累加', async () => {
    const dir = makeEnv({ mode: 'all' });
    await promptCapture.capture(CLAIMS, body({
        model: 'claude-sonnet-4',
        system: 'You are Claude Code...',
        messages: [{ role: 'user', content: 'hello' }],
    }));
    await promptCapture.capture(CLAIMS, body({
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: 'again' }],
    }));

    const files = listFiles(dir);
    assert.equal(files.length, 1);
    // 无 session 目录层，文件直接以 session 命名
    assert.equal(files[0], path.join(dir, 'claude-code', 'sess-test1.json'));

    const record = readRecord(files[0]);
    // 目标格式：{"agent": "...", "messages": [msg1, msg2]}
    assert.equal(record.agent, 'claude-code');
    assert.equal(record.messages.length, 2);
    assert.deepEqual(record.messages[0].messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(record.messages[0].system, 'You are Claude Code...');
    assert.deepEqual(record.messages[1].messages, [{ role: 'user', content: 'again' }]);
});

test('promptCapture: turns 模式每会话只累加前 N 个请求', async () => {
    const dir = makeEnv({ mode: 'turns', turns: 2 });
    await promptCapture.capture(CLAIMS, body({ messages: [] }));
    await promptCapture.capture(CLAIMS, body({ messages: [] }));
    await promptCapture.capture(CLAIMS, body({ messages: [] })); // 超出窗口
    const record = readRecord(listFiles(dir)[0]);
    assert.equal(record.messages.length, 2);
});

test('promptCapture: first 模式只记每会话第 1 个请求', async () => {
    const dir = makeEnv({ mode: 'first' });
    await promptCapture.capture(CLAIMS, body({ messages: [] }));
    await promptCapture.capture(CLAIMS, body({ messages: [] }));
    const record = readRecord(listFiles(dir)[0]);
    assert.equal(record.messages.length, 1);
});

test('promptCapture: off 模式显式关闭后不落盘', () => {
    const dir = makeEnv({ mode: 'off' });
    promptCapture.capture(CLAIMS, body({ messages: [] }));
    assert.equal(listFiles(dir).length, 0);
});

test('promptCapture: 未设置 LLM_CAPTURE_MODE 时默认 all 模式生效（零配置部署场景）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xe-prompt-capture-'));
    process.env.LLM_CAPTURE_DIR = dir;
    delete process.env.LLM_CAPTURE_MODE;
    promptCapture.reloadForTest();
    await promptCapture.capture(CLAIMS, body({ messages: [] }));
    await promptCapture.capture({ ...CLAIMS, sid: 'sess-b', aid: 'opencode' }, body({ messages: [] }));
    // all 模式：每会话一个文件、每请求一个元素
    const files = listFiles(dir);
    assert.equal(files.length, 2);
    assert.equal(readRecord(files[0]).messages.length, 1);
    assert.equal(readRecord(files[1]).messages.length, 1);
    assert.ok(files.some((f) => f.includes(`${path.sep}opencode${path.sep}`)));
});

test('promptCapture: 进程重启后同一会话继续追加而不是覆盖', async () => {
    const dir = makeEnv({ mode: 'all' });
    await promptCapture.capture(CLAIMS, body({ messages: [{ role: 'user', content: 'turn1' }] }));
    // 模拟重启：清空进程内状态（内存链/计数），磁盘文件保留
    promptCapture.reloadForTest();
    process.env.LLM_CAPTURE_DIR = dir;
    process.env.LLM_CAPTURE_MODE = 'all';
    promptCapture.reloadForTest();
    await promptCapture.capture(CLAIMS, body({ messages: [{ role: 'user', content: 'turn2' }] }));
    const record = readRecord(listFiles(dir)[0]);
    assert.equal(record.messages.length, 2);
    assert.equal(record.messages[0].messages[0].content, 'turn1');
    assert.equal(record.messages[1].messages[0].content, 'turn2');
});

test('promptCapture: body 超过单请求上限 → oversize 标记元素，不落原始 body', async () => {
    const dir = makeEnv({ mode: 'all', maxBytes: 64 });
    const big = body({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(512) }] });
    await promptCapture.capture(CLAIMS, big);
    const record = readRecord(listFiles(dir)[0]);
    assert.equal(record.messages.length, 1);
    assert.deepEqual(record.messages[0], { oversize: true, body_bytes: big.length });
});

test('promptCapture: body 非 JSON → parse_error 标记元素', async () => {
    const dir = makeEnv({ mode: 'all' });
    await promptCapture.capture(CLAIMS, Buffer.from('not-json'));
    const record = readRecord(listFiles(dir)[0]);
    assert.equal(record.messages[0].parse_error, true);
    assert.equal(record.messages[0].body_bytes, Buffer.from('not-json').length);
});

function touchOld(file, daysAgo) {
    const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, ts, ts);
}

test('promptCapture: 保留期清理按文件 mtime 删除过期会话文件', async () => {
    const dir = makeEnv({ mode: 'off', retentionDays: 7 });
    const oldFile = path.join(dir, 'claude-code', 'sess-old.json');
    const newFile = path.join(dir, 'claude-code', 'sess-new.json');
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.writeFileSync(oldFile, '{"agent":"claude-code","messages":[]}');
    fs.writeFileSync(newFile, '{"agent":"claude-code","messages":[]}');
    touchOld(oldFile, 20);

    await promptCapture.runMaintenance();
    assert.ok(!fs.existsSync(oldFile), '过期会话文件应被删除');
    assert.ok(fs.existsSync(newFile), '新文件必须保留');
});

test('promptCapture: 总量配额超限按 mtime 从最旧删除，活跃文件跳过', async () => {
    const dir = makeEnv({ mode: 'off', maxTotalMB: 0.000001 }); // ≈1 byte 配额
    const pad = 'x'.repeat(200);
    const mk = (name) => {
        const p = path.join(dir, 'claude-code', `${name}.json`);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ agent: 'claude-code', messages: [{ pad }] }));
        return p;
    };
    const old1 = mk('sess-old1');
    const old2 = mk('sess-old2');
    const active = mk('sess-active');
    touchOld(old1, 3);
    touchOld(old2, 1);
    // active 保持当前 mtime（模拟正在使用的会话）

    await promptCapture.runMaintenance();
    assert.ok(!fs.existsSync(old1), '最旧文件应被删除');
    assert.ok(!fs.existsSync(old2), '次旧文件应被删除');
    assert.ok(fs.existsSync(active), '活跃（近期修改）文件必须跳过');
});
