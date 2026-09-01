const { test } = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_AGENTS, getInstructionFile } = require('./defaultAgents');

test('claude-code declares CLAUDE.md as instruction file', () => {
    assert.equal(getInstructionFile('claude-code'), 'CLAUDE.md');
});

test('other built-in agents default to AGENTS.md', () => {
    for (const id of ['kimi-code', 'opencode', 'cursor', 'qwen-code', 'cline']) {
        assert.equal(getInstructionFile(id), 'AGENTS.md');
    }
});

test('custom / unknown agent defaults to AGENTS.md', () => {
    assert.equal(getInstructionFile('custom-agent-xyz'), 'AGENTS.md');
});

test('only claude-code declares an instructionFile override', () => {
    const declared = DEFAULT_AGENTS.filter((a) => a.instructionFile).map((a) => a.id);
    assert.deepEqual(declared, ['claude-code']);
});
