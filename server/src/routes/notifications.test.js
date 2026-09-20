/**
 * /api/v1/notifications* 路由冒烟（node:test + fastify.inject，无真实 PG）。
 * 通过 notificationsService._setDbForTest 注入 Proxy 假 db，验证：
 * 认证挂钩生效、四个端点的状态码与响应形状、db 异常 → 500 兜底。
 * （与 repos.test.js / projectGit.multi.test.js 同风格。）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');

const notificationsService = require('../session/notificationsService');
const { registerNotificationsRoutes } = require('./notifications');

let fastify;

/**
 * 可脚本化的链式假 db。按 select 的实参区分两类查询（与实现一致）：
 *   - select()        无参 → 列表查询（listRows）
 *   - select({n:..})  带参 → unreadCount 计数查询（countRows）
 * returning() 返回 returningResult（read-all / mark-read 用）。
 */
function fakeDb({ listRows = [], countRows = [{ n: 0 }], returningResult = [] } = {}) {
    let pendingRows = listRows;
    const node = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'then') {
                // 链末直接 await（unreadCount 在 where() 落地、无 limit）→ 解析为挂起的行
                return (res, rej) => Promise.resolve(pendingRows).then(res, rej);
            }
            if (prop === 'select') {
                return (...args) => {
                    pendingRows = args.length > 0 ? countRows : listRows;
                    return node;
                };
            }
            if (prop === 'returning') return () => Promise.resolve(returningResult);
            if (prop === 'limit') return () => Promise.resolve(pendingRows);
            return (..._args) => node;
        },
    });
    return node;
}

test.before(async () => {
    fastify = Fastify({ logger: false });
    fastify.decorate('authenticate', async (req, reply) => {
        if (!req.headers.authorization) return reply.code(401).send({ error: 'unauthorized', code: 'unauthorized' });
        req.user = { id: 'u1', username: 'u1', role: 'user', status: 'active' };
    });
    fastify.decorateRequest('locale', 'en');
    registerNotificationsRoutes(fastify);
    await fastify.ready();
});

test.after(async () => {
    if (fastify) await fastify.close();
});

const AUTH = { authorization: 'Bearer test-token' };

test('未认证 → 401（authPre 生效）', async () => {
    notificationsService._setDbForTest(fakeDb());
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/notifications' });
    assert.equal(res.statusCode, 401);
});

test('GET /notifications → {items, nextCursor, unreadCount}，字段映射正确', async () => {
    notificationsService._setDbForTest(fakeDb({
        listRows: [{ id: 'ntf_1', type: 'session_waiting', payload: { sessionId: 's1' }, readAt: null, createdAt: 111 }],
        countRows: [{ n: 3 }],
    }));
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/notifications?limit=20', headers: AUTH });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.unreadCount, 3);
    assert.equal(body.nextCursor, null);
    assert.deepEqual(body.items, [{ id: 'ntf_1', type: 'session_waiting', payload: { sessionId: 's1' }, readAt: null, createdAt: 111 }]);
});

test('GET /notifications?before=<非法游标> → 忽略游标，仍 200', async () => {
    notificationsService._setDbForTest(fakeDb());
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/notifications?before=garbage', headers: AUTH });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).items, []);
});

test('GET /unread-count → {count}', async () => {
    notificationsService._setDbForTest(fakeDb({ countRows: [{ n: 7 }] }));
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/notifications/unread-count', headers: AUTH });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { count: 7 });
});

test('POST /read-all → {updated: N}', async () => {
    notificationsService._setDbForTest(fakeDb({ returningResult: [{ id: 'a' }, { id: 'b' }] }));
    const res = await fastify.inject({ method: 'POST', url: '/api/v1/notifications/read-all', headers: AUTH });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { updated: 2 });
});

test('POST /:id/read → 命中 {ok:true}；未命中 404 notification_not_found', async () => {
    notificationsService._setDbForTest(fakeDb({ returningResult: [{ id: 'ntf_1' }] }));
    const hit = await fastify.inject({ method: 'POST', url: '/api/v1/notifications/ntf_1/read', headers: AUTH });
    assert.equal(hit.statusCode, 200);
    assert.deepEqual(JSON.parse(hit.body), { ok: true });

    notificationsService._setDbForTest(fakeDb({ returningResult: [] }));
    const miss = await fastify.inject({ method: 'POST', url: '/api/v1/notifications/ntf_x/read', headers: AUTH });
    assert.equal(miss.statusCode, 404);
    assert.equal(JSON.parse(miss.body).code, 'notification_not_found');
});

test('db 异常 → 500 兜底（sendPublicError：脱敏文案、不泄堆栈）', async () => {
    const throwing = new Proxy({}, { get() { throw new Error('pg down'); } });
    notificationsService._setDbForTest(throwing);
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/notifications', headers: AUTH });
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.ok(body.error, 'error 文案存在');
    assert.ok(!body.error.includes('pg down'), '内部错误信息被脱敏');
    assert.equal(body.code, undefined, '通用错误无机器码');
});
