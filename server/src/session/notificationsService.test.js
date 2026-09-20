/**
 * notificationsService 单测（node:test，与 server 既有 *.test.js 同风格）。
 * DB 不可达环境下运行：通过 _setDbForTest 注入 Proxy 假 db，
 * 断言调用形态（去重走 update、新增走 insert）与纯函数行为。
 */
const test = require('node:test');
const assert = require('node:assert');

const notificationsService = require('./notificationsService');

/**
 * 极简 drizzle 链式假 db：任意方法可链式调用；returning()/limit() 返回 Promise。
 * 通过 Proxy 记录调用序（顶层方法名），供断言「走了哪条路径」。
 */
function fakeDb(selectResult = [], returningResult = [], hooks = {}) {
    const calls = [];
    const node = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'then') return undefined; // 不可 thenable，await 直接落地
            if (prop === 'values' && hooks.onValues) {
                return (v) => { hooks.onValues(v); return node; };
            }
            if (prop === 'limit' || prop === 'returning') {
                return () => Promise.resolve(prop === 'limit' ? selectResult : returningResult);
            }
            return (..._args) => {
                calls.push(String(prop));
                return node;
            };
        },
    });
    return { db: node, calls };
}

test('pickIdsToTrim: 不超上限时不删', () => {
    const rows = [{ id: 'a', readAt: null }, { id: 'b', readAt: 1 }];
    assert.deepEqual(notificationsService.pickIdsToTrim(rows, 5), []);
});

test('pickIdsToTrim: 先删最旧已读，再删最旧未读', () => {
    const rows = [
        { id: 'u1', readAt: null },   // 最旧未读
        { id: 'r1', readAt: 1 },      // 最旧已读 → 先删
        { id: 'r2', readAt: 2 },      // 次旧已读 → 再删
        { id: 'u2', readAt: null },
        { id: 'u3', readAt: null },
    ];
    // cap=3，溢出 2 → 两条都从已读里出
    assert.deepEqual(notificationsService.pickIdsToTrim(rows, 3), ['r1', 'r2']);

    // cap=2，溢出 3 → 已读删完还差 1 条 → 删最旧未读 u1
    assert.deepEqual(notificationsService.pickIdsToTrim(rows, 2), ['r1', 'r2', 'u1']);
});

test('cursor 编解码往返；非法输入返回 null', () => {
    const cur = notificationsService.encodeCursor(1712345678901, 'ntf_ab');
    assert.deepEqual(notificationsService.decodeCursor(cur), { ts: 1712345678901, id: 'ntf_ab' });
    assert.equal(notificationsService.decodeCursor('garbage'), null);
    assert.equal(notificationsService.decodeCursor(''), null);
    assert.equal(notificationsService.decodeCursor(null), null);
});

test('notify: 同会话同类型已有未读 → 覆盖更新（update，不 insert）', async () => {
    const fake = fakeDb([{ id: 'ntf_existing' }]);
    notificationsService._setDbForTest(fake.db);
    const id = await notificationsService.notify({
        userId: 'user_1',
        type: 'session_waiting',
        payload: { sessionId: 'sess_1', reason: '需要确认' },
    });
    assert.equal(id, 'ntf_existing');
    assert.ok(fake.calls.includes('update'), '应走 update 覆盖');
    assert.ok(!fake.calls.includes('insert'), '不应新插入');
});

test('notify: 无未读重复 → 新插入', async () => {
    const fake = fakeDb([]);
    notificationsService._setDbForTest(fake.db);
    const id = await notificationsService.notify({
        userId: 'user_1',
        type: 'session_completed',
        payload: { sessionId: 'sess_1' },
    });
    assert.ok(String(id).startsWith('ntf_'));
    assert.ok(fake.calls.includes('insert'), '应走 insert');
});

test('notify: 非 session 类型不做去重，直接插入', async () => {
    const fake = fakeDb([{ id: 'ntf_x' }]);
    notificationsService._setDbForTest(fake.db);
    await notificationsService.notify({
        userId: 'user_1',
        type: 'skill_created',
        payload: { skillId: 'sk_1' },
    });
    assert.ok(fake.calls.includes('insert'));
    assert.ok(!fake.calls.includes('update'));
});

test('notifySkillCreated: 落库 payload 带 title/name 快照', async () => {
    let captured = null;
    const fake = fakeDb([], [], { onValues: (v) => { captured = v; } });
    notificationsService._setDbForTest(fake.db);
    await notificationsService.notifySkillCreated({
        userId: 'user_1',
        skill: { id: 'sk_9', title: 'fix-login', name: 'fix-login' },
    });
    assert.ok(captured, '应触发插入');
    assert.equal(captured.type, 'skill_created');
    assert.equal(captured.userId, 'user_1');
    assert.equal(captured.payload.skillId, 'sk_9');
    assert.equal(captured.payload.skillTitle, 'fix-login');
});

test('notify: 缺 userId/type 直接返回 null（不触 db）', async () => {
    const fake = fakeDb([]);
    notificationsService._setDbForTest(fake.db);
    assert.equal(await notificationsService.notify({ type: 'session_waiting' }), null);
    assert.equal(await notificationsService.notify({ userId: 'u' }), null);
    assert.equal(fake.calls.length, 0);
});
