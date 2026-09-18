const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { eq } = require('drizzle-orm');
const { bootstrapTestDb } = require('../../test/db');

const SESSION_ID = 'sess_sticky';
const TEST_AGENT_ID = 'sticky-test-agent';

let ctx;
let db;
let schema;
let getSticky;
let touchSticky;
let recordStickyFailure;

describe('session route sticky (postgres)', { concurrency: false, timeout: 60000 }, () => {
    before(async () => {
        ctx = await bootstrapTestDb(['./sticky'], __dirname);
        ({ db, schema } = ctx);
        ({ getSticky, touchSticky, recordStickyFailure } = ctx.reloaded['./sticky']);

        const users = await db.select().from(schema.users).limit(1);
        let userId;
        if (users.length > 0) {
            userId = users[0].id;
        } else {
            userId = 'usr_sticky_test';
            await db.insert(schema.users).values({
                id: userId,
                username: 'sticky_test',
                passwordHash: 'hash',
                role: 'admin',
                status: 'active',
                createdAt: Date.now(),
            });
        }

        const agentRows = await db.select().from(schema.agents).where(eq(schema.agents.id, TEST_AGENT_ID));
        if (agentRows.length === 0) {
            await db.insert(schema.agents).values({
                id: TEST_AGENT_ID,
                name: 'Sticky Test',
                cmd: 'sticky-test',
                args: '[]',
                envRequired: '[]',
            });
        }

        await db.delete(schema.sessions).where(eq(schema.sessions.id, SESSION_ID));
        await db.insert(schema.sessions).values({
            id: SESSION_ID,
            userId,
            agentId: TEST_AGENT_ID,
            cwd: '/tmp',
            status: 'running',
            createdAt: Date.now(),
        });
    });

    after(async () => {
        if (ctx) await ctx.teardown();
    });

    beforeEach(async () => {
        await db.delete(schema.sessionRouteSticky).where(eq(schema.sessionRouteSticky.sessionId, SESSION_ID));
    });

    it('getSticky returns null when no row exists', async () => {
        assert.equal(await getSticky(SESSION_ID, 'line-a'), null);
    });

    it('touchSticky upserts and getSticky returns model/provider', async () => {
        await touchSticky(SESSION_ID, 'line-a', { chosenModel: 'deepseek-chat', chosenProvider: 'deepseek' });
        const sticky = await getSticky(SESSION_ID, 'line-a');
        assert.ok(sticky);
        assert.equal(sticky.chosenModel, 'deepseek-chat');
        assert.equal(sticky.chosenProvider, 'deepseek');
        assert.equal(sticky.failCount, 0);
        assert.ok(sticky.expiresAt > Date.now());
    });

    it('sticky is isolated per line within one session', async () => {
        await touchSticky(SESSION_ID, 'line-a', { chosenModel: 'glm-5.3-flash', chosenProvider: 'personal_glm' });
        await touchSticky(SESSION_ID, 'line-b', { chosenModel: 'glm-5.3', chosenProvider: 'personal_glm' });
        const a = await getSticky(SESSION_ID, 'line-a');
        const b = await getSticky(SESSION_ID, 'line-b');
        assert.equal(a.chosenModel, 'glm-5.3-flash');
        assert.equal(b.chosenModel, 'glm-5.3');
        // 空 lineKey 退化为 session 级，不与具体线互相干扰
        assert.equal(await getSticky(SESSION_ID, ''), null);
    });

    it('getSticky returns null when expiresAt is in the past', async () => {
        await touchSticky(SESSION_ID, 'line-a', { chosenModel: 'deepseek-chat', chosenProvider: 'deepseek' });
        await db
            .update(schema.sessionRouteSticky)
            .set({ expiresAt: Date.now() - 1000 })
            .where(eq(schema.sessionRouteSticky.sessionId, SESSION_ID));
        assert.equal(await getSticky(SESSION_ID, 'line-a'), null);
    });

    it('recordStickyFailure twice keeps a tombstone so the next turn can trigger provider_fail', async () => {
        await touchSticky(SESSION_ID, 'line-a', { chosenModel: 'kimi-k2.5', chosenProvider: 'moonshot' });
        const first = await recordStickyFailure(SESSION_ID, 'line-a');
        assert.equal(first.failCount, 1);
        assert.equal(first.released, false);

        const second = await recordStickyFailure(SESSION_ID, 'line-a');
        assert.equal(second.failCount, 2);
        assert.equal(second.released, true);

        const sticky = await getSticky(SESSION_ID, 'line-a');
        assert.ok(sticky);
        assert.equal(sticky.failCount, 2);
        assert.equal(sticky.chosenProvider, 'moonshot');
    });

    it('recordStickyFailure is a noop when no row exists', async () => {
        const result = await recordStickyFailure(SESSION_ID, 'line-a');
        assert.deepEqual(result, { failCount: 0, released: false });
    });
});
