const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { and, eq } = require('drizzle-orm');
const { bootstrapTestDb } = require('../../test/db');

const SESSION_ID = 'sess_decisions';
const TEST_AGENT_ID = 'decisions-test-agent';
const SEQ = 7;

let ctx;
let db;
let schema;
let insertDecision;
let patchDecisionUsage;

describe('routing decisions (postgres)', { concurrency: false, timeout: 60000 }, () => {
    before(async () => {
        ctx = await bootstrapTestDb(['./decisions'], __dirname);
        ({ db, schema } = ctx);
        ({ insertDecision, patchDecisionUsage } = ctx.reloaded['./decisions']);

        const users = await db.select().from(schema.users).limit(1);
        let userId;
        if (users.length > 0) {
            userId = users[0].id;
        } else {
            userId = 'usr_decisions_test';
            await db.insert(schema.users).values({
                id: userId,
                username: 'decisions_test',
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
                name: 'Decisions Test',
                cmd: 'decisions-test',
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
        await db.delete(schema.routingDecisions).where(eq(schema.routingDecisions.sessionId, SESSION_ID));
    });

    it('inserts then patches usage for the same (sessionId, seq)', async () => {
        await insertDecision({
            sessionId: SESSION_ID,
            userId: 'usr_decisions_test',
            agentId: TEST_AGENT_ID,
            seq: SEQ,
            trigger: 'new_session',
            chosenModel: 'deepseek-chat',
            chosenProvider: 'deepseek',
            candidates: [{ providerId: 'deepseek', modelId: 'deepseek-chat' }],
            demand: { level: 'hard' },
        });

        const inserted = await db
            .select()
            .from(schema.routingDecisions)
            .where(and(
                eq(schema.routingDecisions.sessionId, SESSION_ID),
                eq(schema.routingDecisions.seq, SEQ),
            ));
        assert.equal(inserted.length, 1);
        assert.equal(inserted[0].seq, SEQ);
        assert.equal(inserted[0].trigger, 'new_session');
        assert.equal(inserted[0].demand, null);
        assert.equal(typeof inserted[0].createdAt, 'number');
        assert.ok(inserted[0].createdAt > 0);
        assert.equal(inserted[0].promptTokens, null);
        assert.equal(inserted[0].cachedTokens, null);
        assert.equal(inserted[0].completionTokens, null);
        assert.equal(inserted[0].latencyMs, null);
        assert.equal(inserted[0].statusCode, null);
        assert.equal(inserted[0].error, null);

        await patchDecisionUsage({
            sessionId: SESSION_ID,
            seq: SEQ,
            promptTokens: 120,
            cachedTokens: 40,
            completionTokens: 30,
            latencyMs: 250,
            statusCode: 200,
            error: null,
        });

        const patched = await db
            .select()
            .from(schema.routingDecisions)
            .where(and(
                eq(schema.routingDecisions.sessionId, SESSION_ID),
                eq(schema.routingDecisions.seq, SEQ),
            ));
        assert.equal(patched.length, 1);
        assert.equal(patched[0].promptTokens, 120);
        assert.equal(patched[0].cachedTokens, 40);
        assert.equal(patched[0].completionTokens, 30);
        assert.equal(patched[0].latencyMs, 250);
        assert.equal(patched[0].statusCode, 200);
        assert.equal(patched[0].error, null);
        assert.equal(patched[0].chosenModel, 'deepseek-chat');
        assert.equal(patched[0].chosenProvider, 'deepseek');
    });
});
