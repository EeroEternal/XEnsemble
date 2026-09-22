const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyAgentTuiEnv } = require('./agentTuiEnv');

test('applyAgentTuiEnv disables the ClinePass promo notice for cline', () => {
    const env = {};
    applyAgentTuiEnv(env, 'cline');
    assert.equal(env.CLINE_DISABLE_CLINE_PASS_NOTICE, '1');
});

test('applyAgentTuiEnv leaves other agents untouched', () => {
    for (const agentId of ['claude-code', 'kimi-code', 'glm-agent', 'pi']) {
        const env = {};
        applyAgentTuiEnv(env, agentId);
        assert.equal(env.CLINE_DISABLE_CLINE_PASS_NOTICE, undefined);
    }
});

test('applyAgentTuiEnv preserves existing env vars', () => {
    const env = { OPENAI_API_KEY: 'sk-test', PATH: '/usr/bin' };
    applyAgentTuiEnv(env, 'cline');
    assert.equal(env.OPENAI_API_KEY, 'sk-test');
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.CLINE_DISABLE_CLINE_PASS_NOTICE, '1');
});

test('applyAgentTuiEnv tolerates missing env object', () => {
    assert.equal(applyAgentTuiEnv(null, 'cline'), null);
    assert.equal(applyAgentTuiEnv(undefined, 'cline'), undefined);
});
