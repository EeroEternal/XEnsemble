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
