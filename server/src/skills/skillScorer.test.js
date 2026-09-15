const { test } = require('node:test');
const assert = require('node:assert/strict');
const scorer = require('./skillScorer');

test('countCorrections detects short correction turns with prior assistant turn', () => {
    const turns = [
        { role: 'user', text: 'fix the login bug' },
        { role: 'assistant', text: 'editing auth.js' },
        { role: 'user', text: '不对，密码应该用 bcrypt' },   // correction
        { role: 'assistant', text: 'switching to bcrypt' },
        { role: 'user', text: '还是不行，重新来' },          // correction
        { role: 'assistant', text: 'restarting' },
        { role: 'user', text: '这个是正常流程不用改' },       // not a correction
    ];
    assert.equal(scorer.countCorrections(turns), 2);
});

test('countCorrections ignores long user turns and no-prior-assistant', () => {
    const turns = [
        { role: 'user', text: '这是第一条用户输入，没有前面的 assistant 所以不算纠正' }, // > 120 chars? no, but no prior assistant
        { role: 'user', text: '不对，改一下' },  // correction candidate but no prior assistant
        { role: 'assistant', text: 'ok' },
        { role: 'user', text: 'x'.repeat(200) + '不对' }, // too long
    ];
    assert.equal(scorer.countCorrections(turns), 0);
});

test('countCorrections handles empty / non-array input', () => {
    assert.equal(scorer.countCorrections([]), 0);
    assert.equal(scorer.countCorrections(null), 0);
    assert.equal(scorer.countCorrections(undefined), 0);
});

test('computeScore formula (§6.2)', () => {
    // userMarked -> +100
    assert.equal(scorer.computeScore({ userMarked: true }), 100);
    // correctionCount capped at 3 -> 90
    assert.equal(scorer.computeScore({ correctionCount: 5 }), 90);
    // filesTouched capped at 3 -> 45
    assert.equal(scorer.computeScore({ filesTouched: 10 }), 45);
    // successExit -> +20
    assert.equal(scorer.computeScore({ successExit: true }), 20);
    // clusterSize-1 -> +25 per extra
    assert.equal(scorer.computeScore({ clusterSize: 3 }), 50);
    // turnCount > 200 penalty -10
    assert.equal(scorer.computeScore({ turnCount: 300 }), -10);
    // combined example: 2 corrections(60) + 3 files(45) + success(20) = 125
    assert.equal(scorer.computeScore({
        correctionCount: 2, filesTouched: 4, successExit: true, turnCount: 50, clusterSize: 1,
    }), 125);
    // long turn penalty
    assert.equal(scorer.computeScore({
        correctionCount: 2, filesTouched: 4, successExit: true, turnCount: 300, clusterSize: 1,
    }), 115);
});

test('buildSignals normalizes and defaults', () => {
    const s = scorer.buildSignals({
        userMarked: 1,
        correctionCount: 2,
        filesTouched: 4,
        successExit: 'yes',
        turnCount: 35,
    });
    assert.deepEqual(s, {
        userMarked: true,
        correctionCount: 2,
        filesTouched: 4,
        successExit: true,
        turnCount: 35,
        clusterSize: 1,
        trajErrorFree: false,
        trajToolCalls: 0,
    });
});

test('computeScore adds trajectory bonus (0029)', () => {
    assert.equal(scorer.computeScore({ successExit: true, trajErrorFree: true }), 30);
    assert.equal(scorer.computeScore({ trajErrorFree: true }), 10);
});
