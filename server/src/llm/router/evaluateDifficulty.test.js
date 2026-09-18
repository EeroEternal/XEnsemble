const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    evaluateDifficulty,
    heuristicDifficulty,
    requiredCapability,
    capabilityQualified,
    HARD_TASK_DIFFICULTY,
} = require('./evaluateDifficulty');

test('evaluateDifficulty returns a static 0-1 score for empty input', async () => {
    const demand = await evaluateDifficulty({});
    assert.equal(typeof demand.difficulty, 'number');
    assert.ok(demand.difficulty >= 0 && demand.difficulty <= 1);
    assert.equal(demand.requiredCapability, requiredCapability(demand.difficulty));
});

test('tools and reasoning raise difficulty', () => {
    const plain = { messages: [{ role: 'user', content: 'hi' }] };
    const withTools = {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'x' } }],
    };
    const reasoning = {
        messages: [{ role: 'user', content: 'Please explain step by step and prove the theorem' }],
    };
    assert.ok(heuristicDifficulty(withTools) > heuristicDifficulty(plain));
    assert.ok(heuristicDifficulty(reasoning) > heuristicDifficulty(plain));
    assert.ok(heuristicDifficulty(reasoning) >= HARD_TASK_DIFFICULTY);
});

test('correction cues raise difficulty', () => {
    const plain = { messages: [{ role: 'user', content: 'hi' }] };
    const correction = {
        messages: [
            { role: 'user', content: 'write a sort' },
            { role: 'assistant', content: 'here' },
            { role: 'user', content: '不对，你的代码有死锁错误，还是报错' },
        ],
    };
    assert.ok(heuristicDifficulty(correction) > heuristicDifficulty(plain));
});

test('agent envelope (tools + system) does not make 你好 a hard task', () => {
    const hello = {
        system: 'You are an engineer. architecture algorithm compiler class Foo',
        messages: [
            { role: 'user', content: '<system-reminder>ignore</system-reminder>\n你好' },
        ],
        tools: Array.from({ length: 25 }, (_, i) => ({
            type: 'function',
            function: {
                name: `tool_${i}`,
                description: 'implement architecture algorithm step by step and prove the theorem',
                parameters: { type: 'object', properties: { q: { type: 'string' } } },
            },
        })),
    };
    const d = heuristicDifficulty(hello);
    assert.ok(d < HARD_TASK_DIFFICULTY, `你好 should stay easy, got ${d}`);
    assert.ok(d > heuristicDifficulty({ messages: [{ role: 'user', content: '你好' }] }));
});

test('requiredCapability and hard-task qualification use one continuous gate', () => {
    assert.equal(requiredCapability(0), 0.35);
    assert.equal(requiredCapability(1), 0.9);
    assert.equal(HARD_TASK_DIFFICULTY, 0.55);
    assert.ok(Math.abs(requiredCapability(0.55) - 0.6525) < 1e-9);
    // 连续门槛：D=0.55 不再跳到「目录最高分 - 0.04」的硬门槛
    assert.equal(capabilityQualified(0.65, 0.15), true);
    assert.equal(capabilityQualified(0.65, 0.70), false);
    assert.equal(capabilityQualified(0.92, 0.70), true);
    assert.equal(capabilityQualified(0.95, 0.70), true);
    // 0.55 处与相邻难度保持连续，无断崖
    assert.equal(capabilityQualified(0.65, 0.54), true);
    assert.equal(capabilityQualified(0.65, 0.55), false);
});
