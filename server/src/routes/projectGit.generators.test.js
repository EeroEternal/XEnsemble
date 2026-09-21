const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// 生成器单元测试不触运行时/PTY：projectGit 顶部的服务类依赖链（workspace →
// node-pty 原生模块）在沙箱/CI 无原生模块环境无法加载，而生成器路径完全用不到，
// 在 require 路由模块前替换为桩。
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === '../workspace') return {};
    if (request === '../runtime/RuntimeService') return { ensureProjectRuntime: async () => ({}) };
    if (request === '../runtime/registry') return { getRuntime: () => ({}) };
    return origLoad(request, parent, isMain);
};

// db/index 的连接池是惰性创建的，设一个假 DSN 即可加载路由模块（生成器本身不触库）。
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test';

const llm = require('../llm/analyzeClient');
const { __testables } = require('./projectGit');
const { generateCommitMessage, generatePRDescription } = __testables;

const origFetch = global.fetch;

// 与生产路由一致的 metering（feature='git_pr_fill' + 发起用户/项目归属）。
const METERING = { feature: 'git_pr_fill', userId: 'user-1', projectId: 'proj-1' };

function fakeGitService(diff) {
    return {
        async _execGit() { return ''; },
        async getDiff() { return { diff }; },
        async getStatus() { return { files: [] }; },
    };
}

function flushMicrotasks() {
    return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
    process.env.LLM_ANALYZE_API_KEY = 'test-key';
    delete process.env.LLM_ANALYZE_MODEL;
    delete process.env.LLM_VERIFY_MODEL;
    delete process.env.LLM_ANALYZE_REASONING_EFFORT;
    delete process.env.LLM_ANALYZE_API_URL;
    delete process.env.LLM_ANALYZE_DISABLE_THINKING;
});

afterEach(() => {
    global.fetch = origFetch;
    llm.__setUsageSink(null);
    delete process.env.LLM_ANALYZE_API_KEY;
});

test('pr-description: metering 全链路接线并返回 {title, body}（回归：曾因 opts.metering 未定义而 500）', async () => {
    const bodies = [];
    global.fetch = async (url, init) => {
        bodies.push({ url: String(url), body: JSON.parse(init.body) });
        return {
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: '{"title":"feat: add login form","body":"- adds form\\n- why: user request"}' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            }),
        };
    };
    const rows = [];
    llm.__setUsageSink((row) => rows.push(row));

    const result = await generatePRDescription(
        { id: 'proj-1' },
        fakeGitService('diff --git a/x b/x'),
        { targetBranch: 'main', locale: 'en', metering: METERING },
    );
    await flushMicrotasks();

    assert.deepEqual(result, { title: 'feat: add login form', body: '- adds form\n- why: user request' });
    assert.equal(bodies.length, 1);
    assert.ok(/\/chat\/completions$/.test(bodies[0].url)); // 端点归一化收口
    assert.equal(bodies[0].body.reasoning_effort, 'low'); // 默认 low 提速
    assert.equal(bodies[0].body.messages[0].role, 'system');
    // metering 真正穿透到 analyzeClient（回归点：opts.metering 未定义时在此前直接 ReferenceError）
    assert.equal(rows.length, 1);
    assert.equal(rows[0].feature, 'git_pr_fill');
    assert.equal(rows[0].userId, 'user-1');
    assert.equal(rows[0].projectId, 'proj-1');
    assert.equal(rows[0].source, 'internal');
    assert.equal(rows[0].totalTokens, 120);
});

test('commit message: 返回 {message}，reasoning_effort 可经 env 置空关闭', async () => {
    const bodies = [];
    global.fetch = async (url, init) => {
        bodies.push(JSON.parse(init.body));
        return {
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: 'fix(auth): guard null session\n\n- why: user report' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
        };
    };
    process.env.LLM_ANALYZE_REASONING_EFFORT = '';
    const result = await generateCommitMessage({ id: 'proj-1' }, fakeGitService('diff'), { locale: 'en', metering: METERING });
    assert.equal(result.message, 'fix(auth): guard null session\n\n- why: user report');
    assert.equal(bodies[0].reasoning_effort, undefined);
});

test('AI 请求失败: 保持既有路由侧错误通道（AI error <status>）', async () => {
    global.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
    await assert.rejects(
        () => generatePRDescription({ id: 'proj-1' }, fakeGitService('diff'), { locale: 'en', metering: METERING }),
        (err) => err.message === 'AI error 429',
    );
});
