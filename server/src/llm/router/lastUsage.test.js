const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { eq } = require('drizzle-orm');
const { bootstrapTestDb } = require('../../test/db');

const SESSION_ID = 'sess_last_usage';
const TEST_AGENT_ID = 'last-usage-test-agent';

let ctx;
let db;
let schema;
let loadLastSessionUsage;

describe('loadLastSessionUsage', { concurrency: false, timeout: 60000 }, () => {
    before(async () => {
        ctx = await bootstrapTestDb(['./lastUsage'], __dirname);
        ({ db, schema } = ctx);
        ({ loadLastSessionUsage } = ctx.reloaded['./lastUsage']);

        const users = await db.select().from(schema.users).limit(1);
        let userId = users[0]?.id;
        if (!userId) {
            userId = 'usr_last_usage_test';
            await db.insert(schema.users).values({
                id: userId,
                username: 'last_usage_test',
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
                name: 'Last Usage Test',
                cmd: 'last-usage-test',
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

    it('returns null when the session has no llm_usage rows', async () => {
        assert.equal(await loadLastSessionUsage(SESSION_ID), null);
        assert.equal(await loadLastSessionUsage(''), null);
    });

    it('returns promptTokens and cachedTokens from the latest llm_usage row', async () => {
        const users = await db.select().from(schema.users).limit(1);
        const userId = users[0].id;
        await db.insert(schema.llmUsage).values({
            userId,
            sessionId: SESSION_ID,
            promptTokens: 100,
            completionTokens: 1,
            totalTokens: 101,
            cachedTokens: 10,
            createdAt: Date.now() - 5000,
        });
        await db.insert(schema.llmUsage).values({
            userId,
            sessionId: SESSION_ID,
            promptTokens: 1000,
            completionTokens: 20,
            totalTokens: 1020,
            cachedTokens: 400,
            createdAt: Date.now(),
        });
        const usage = await loadLastSessionUsage(SESSION_ID);
        assert.deepEqual(usage, { promptTokens: 1000, cachedTokens: 400 });
    });
});
