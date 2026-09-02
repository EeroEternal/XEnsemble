const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { bootstrapTestDb } = require('../test/db');

let ctx;
let extractor;
let analyzeClient;

before(async () => {
    ctx = await bootstrapTestDb([
        '../db/index',
        '../db/schema',
        '../llm/analyzeClient',
        './skillExtractor',
    ], __dirname);
    analyzeClient = ctx.reloaded['../llm/analyzeClient'];
    extractor = ctx.reloaded['./skillExtractor'];
});

after(async () => {
    if (ctx) await ctx.teardown();
});

test('buildSkillMarkdown composes YAML frontmatter + body', () => {
    const md = extractor.buildSkillMarkdown({
        name: 'Fix Postgres pool leak',
        description: 'When the DB pool errors, follow these steps',
        content: '## When to use\nDB pool errors.\n## Steps\n1. Inspect pool config',
    });
    assert.ok(md.startsWith('---\nname: Fix Postgres pool leak'));
    assert.ok(md.includes('description: When the DB pool errors, follow these steps'));
    assert.ok(md.includes('---\n\n## When to use'));
    assert.ok(md.endsWith('1. Inspect pool config'));
});

test('buildSkillMarkdown strips newlines from frontmatter values', () => {
    const md = extractor.buildSkillMarkdown({
        name: 'a\nb',
        description: 'x\ny',
        content: 'body',
    });
    assert.ok(md.startsWith('---\nname: a b'));
    assert.ok(md.includes('description: x y'));
});

test('buildExtractPrompt requests name/description fields', () => {
    const prompt = extractor.buildExtractPrompt({
        overview: 'fix pool',
        turns: [{ role: 'user', text: 'hi' }],
    });
    assert.match(prompt, /"name"/);
    assert.match(prompt, /"description"/);
    assert.match(prompt, /"content"/);
    assert.match(prompt, /no YAML frontmatter here/);
});

test('validateExtracted parses structured fields', () => {
    const out = extractor.validateExtracted({
        name: '  Fix pool  ',
        description: '  When pool errors  ',
        content: '## Steps\n1. x',
        tags: ['db', ''],
        confidence: 0.9,
    });
    assert.equal(out.name, 'Fix pool');
    assert.equal(out.description, 'When pool errors');
    assert.equal(out.body, '## Steps\n1. x');
    assert.deepEqual(out.tags, ['db']);
    assert.equal(out.confidence, 0.9);
});

test('validateExtracted rejects missing name or body', () => {
    assert.equal(extractor.validateExtracted({ name: '', content: 'x' }), null);
    assert.equal(extractor.validateExtracted({ name: 'n', content: '' }), null);
    assert.equal(extractor.validateExtracted(null), null);
});

test('extract returns SKILL.md content with title = name', async () => {
    analyzeClient.chatJson = async () => ({
        name: 'Fix Postgres pool leak',
        description: 'DB pool debugging recipe',
        content: '## When to use\nPool errors.\n## Steps\n1. Inspect',
        tags: ['postgres'],
        confidence: 0.85,
    });
    const out = await extractor.extract({
        summary: { overview: 'fix pool leak', keyDecisions: [], filesTouched: [] },
        turns: [],
    });
    assert.equal(out.title, 'Fix Postgres pool leak');
    assert.equal(out.description, 'DB pool debugging recipe');
    assert.ok(out.content.startsWith('---\nname: Fix Postgres pool leak'));
    assert.ok(out.content.includes('description: DB pool debugging recipe'));
    assert.ok(out.content.includes('## Steps'));
    assert.deepEqual(out.tags, ['postgres']);
    assert.equal(out.confidence, 0.85);
});

// ---------------------------------------------------------------------------
// 0020 脚本级 Skill：命令序列提取 + 脚本校验
// ---------------------------------------------------------------------------

test('collectCommands extracts Bash commands with args + result', () => {
    const turns = [
        { role: 'assistant', tools: [{ tool: 'Bash', args: '{"command":"npm install"}', result: 'added 42 pkgs' }] },
        { role: 'assistant', tools: [{ tool: 'Edit', args: '{"path":"a.js"}' }, { tool: 'Bash', args: 'ls -la' }] },
        { role: 'assistant', tools: [{ tool: 'run_shell', args: { cmd: 'npm test' }, result: 'ok' }] },
        { role: 'assistant', tools: [{ tool: 'Read', args: '{"path":"x"}' }] },
    ];
    const cmds = extractor.collectCommands(turns);
    assert.deepEqual(cmds.map((c) => c.command), ['npm install', 'ls -la', 'npm test']);
    assert.equal(cmds[0].result, 'added 42 pkgs');
});

test('collectCommands caps at MAX_COMMANDS and skips empty commands', () => {
    const turns = [{ role: 'assistant', tools: [{ tool: 'Bash', args: '{"command":""}' }] }];
    assert.equal(extractor.collectCommands(turns).length, 0);
    assert.equal(extractor.collectCommands([]).length, 0);
});

test('buildExtractPrompt includes executed commands context when present', () => {
    const prompt = extractor.buildExtractPrompt({
        overview: 'x',
        commands: [{ command: 'npm run build', result: 'ok' }],
    });
    assert.ok(prompt.includes('Executed commands'));
    assert.ok(prompt.includes('$ npm run build'));
});

test('validateScripts accepts whitelisted script paths and rejects traversal', () => {
    const ok = extractor.validateScripts([
        { path: 'scripts/main.sh', content: '#!/bin/bash' },
        { path: 'scripts/check.py', content: 'x' },
    ]);
    assert.deepEqual(ok.map((s) => s.path), ['scripts/main.sh', 'scripts/check.py']);

    const bad = extractor.validateScripts([
        { path: '../evil.sh', content: 'x' },      // 穿越
        { path: 'scripts/noext', content: 'x' },   // 无白名单扩展名
        { path: 'scripts/empty.sh', content: '' }, // 空内容
        { path: 'scripts/big.sh', content: 'x'.repeat(40000) }, // 超 32KB
    ]);
    assert.equal(bad.length, 0);
    assert.equal(extractor.validateScripts(null).length, 0);
});

test('extract passes through validated scripts', async () => {
    analyzeClient.chatJson = async () => ({
        name: 'Auto fix',
        description: 'd',
        content: '## Steps',
        tags: [],
        confidence: 0.7,
        scripts: [
            { path: 'scripts/fix.sh', content: '#!/bin/bash\necho fix' },
            { path: '../bad.sh', content: 'x' }, // 应被过滤
        ],
    });
    const out = await extractor.extract({ summary: { overview: 'o' }, turns: [] });
    assert.deepEqual(out.scripts, [{ path: 'scripts/fix.sh', content: '#!/bin/bash\necho fix' }]);
});
