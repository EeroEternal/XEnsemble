const { test } = require('node:test');
const assert = require('node:assert/strict');

const { assembleSpawnArgs } = require('./assembleSpawnArgs');

test('interactive droid session with --model gets no stray undefined arg', () => {
    // 回归点（515251e 引入的真实故障）：交互式会话的 taskArgs 是 []（truthy），
    // 老实现走进 droid 特例分支并追加 taskArgs[-1]（undefined）→ JSON 变成 null
    // → boxlite 422 args[2]，新建 droid 会话必失败。
    const args = assembleSpawnArgs({
        agentId: 'droid',
        append: ['--model', 'glm-5.3-flash/glm-5.3-flash'],
        taskArgs: [],
    });
    assert.deepEqual(args, ['--model', 'glm-5.3-flash/glm-5.3-flash']);
    assert.equal(args.some((a) => a == null), false);
    assert.equal(JSON.stringify(args), '["--model","glm-5.3-flash/glm-5.3-flash"]');
});

test('interactive droid session without a configured model stays empty', () => {
    assert.deepEqual(assembleSpawnArgs({ agentId: 'droid', append: [], taskArgs: [] }), []);
});

test('missing / null taskArgs is treated as no task run', () => {
    assert.deepEqual(assembleSpawnArgs({ agentId: 'droid', append: ['--model', 'm'] }), ['--model', 'm']);
    assert.deepEqual(assembleSpawnArgs({ agentId: 'droid', append: ['--model', 'm'], taskArgs: null }), ['--model', 'm']);
});

test('droid task run keeps --auto high before the prompt and inserts --model before it', () => {
    assert.deepEqual(
        assembleSpawnArgs({
            agentId: 'droid',
            append: ['--model', 'm'],
            taskArgs: ['exec', '--auto', 'high', 'do it'],
        }),
        ['exec', '--auto', 'high', '--model', 'm', 'do it'],
    );
});

test('approveArgs are appended at the very end, never spliced into taskArgs', () => {
    // 回归点：交互式批准参数曾与 taskArgs 混传，droid 特例把最后一个元素
    // （'high'）当 prompt 搬到 --model 之后，--auto 与其值被拆开，
    // CLI 报 "Invalid --auto value. Allowed values: low, medium, high."
    assert.deepEqual(
        assembleSpawnArgs({
            agentId: 'droid',
            append: ['--model', 'm'],
            taskArgs: [],
            approveArgs: ['--auto', 'high'],
        }),
        ['--model', 'm', '--auto', 'high'],
    );
    assert.deepEqual(
        assembleSpawnArgs({
            agentId: 'droid',
            append: [],
            taskArgs: [],
            approveArgs: ['--auto', 'high'],
        }),
        ['--auto', 'high'],
    );
    // 一次性任务 + 批准参数并存：prompt 位置不动，approveArgs 追加最末
    assert.deepEqual(
        assembleSpawnArgs({
            agentId: 'droid',
            append: ['--model', 'm'],
            taskArgs: ['exec', '--auto', 'high', 'do it'],
            approveArgs: ['--extra-flag'],
        }),
        ['exec', '--auto', 'high', '--model', 'm', 'do it', '--extra-flag'],
    );
    assert.deepEqual(
        assembleSpawnArgs({
            agentId: 'claude-code',
            append: [],
            taskArgs: ['-p', 'hi'],
            approveArgs: ['--dangerously-skip-permissions'],
        }),
        ['-p', 'hi', '--dangerously-skip-permissions'],
    );
});

test('droid task run keeps prepend / state / base args in front', () => {
    assert.deepEqual(
        assembleSpawnArgs({
            agentId: 'droid',
            prepend: ['-p'],
            stateArgs: ['--session-dir', '/state'],
            baseArgs: ['--foo'],
            append: ['--model', 'm'],
            taskArgs: ['exec', '--auto', 'high', 'prompt'],
        }),
        ['-p', '--session-dir', '/state', '--foo', 'exec', '--auto', 'high', '--model', 'm', 'prompt'],
    );
});

test('other agents are unaffected by the droid special case', () => {
    assert.deepEqual(
        assembleSpawnArgs({ agentId: 'claude-code', append: [], taskArgs: ['-p', 'hi'] }),
        ['-p', 'hi'],
    );
    // 非 droid：append 一律落在 taskArgs 之前，不做 prompt 位置的搬运
    assert.deepEqual(
        assembleSpawnArgs({ agentId: 'cline', append: ['-P', 'openai-compatible'], taskArgs: ['prompt'] }),
        ['-P', 'openai-compatible', 'prompt'],
    );
});
