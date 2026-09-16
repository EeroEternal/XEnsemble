const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveTrigger } = require('./triggers');

test('no sticky → first_turn with reevaluate', () => {
    assert.deepEqual(
        resolveTrigger({ sticky: null, compacted: false, stickyReleasedByFailures: false }),
        { trigger: 'first_turn', reevaluate: true },
    );
});

test('compacted → compaction with reevaluate', () => {
    assert.deepEqual(
        resolveTrigger({
            sticky: { chosenModel: 'm', chosenProvider: 'p', failCount: 0 },
            compacted: true,
            stickyReleasedByFailures: false,
        }),
        { trigger: 'compaction', reevaluate: true },
    );
});

test('stickyReleasedByFailures or failCount >= 2 → provider_fail with reevaluate', () => {
    assert.deepEqual(
        resolveTrigger({
            sticky: { chosenModel: 'm', chosenProvider: 'p', failCount: 2 },
            compacted: false,
            stickyReleasedByFailures: false,
        }),
        { trigger: 'provider_fail', reevaluate: true },
    );
});

test('active sticky → sticky without reevaluate', () => {
    assert.deepEqual(
        resolveTrigger({
            sticky: { chosenModel: 'm', chosenProvider: 'p', failCount: 0 },
            compacted: false,
            stickyReleasedByFailures: false,
        }),
        { trigger: 'sticky', reevaluate: false },
    );
});

test('never returns semantic_shift', () => {
    const cases = [
        { sticky: null, compacted: false, stickyReleasedByFailures: false },
        { sticky: null, compacted: true, stickyReleasedByFailures: false },
        {
            sticky: { chosenModel: 'm', chosenProvider: 'p', failCount: 0 },
            compacted: true,
            stickyReleasedByFailures: false,
        },
        {
            sticky: { chosenModel: 'm', chosenProvider: 'p', failCount: 2 },
            compacted: false,
            stickyReleasedByFailures: true,
        },
        {
            sticky: { chosenModel: 'm', chosenProvider: 'p', failCount: 0 },
            compacted: false,
            stickyReleasedByFailures: false,
        },
    ];
    for (const input of cases) {
        const result = resolveTrigger(input);
        assert.notEqual(result.trigger, 'semantic_shift');
    }
});
