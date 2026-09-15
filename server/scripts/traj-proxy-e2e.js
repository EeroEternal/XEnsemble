/* eslint-disable no-console */
/**
 * Trajectory 全链路验证（一次性脚本）：
 * 起 server → 创建 session → issue session token → 走真实 LLM proxy 调用
 * （经 UniGateway → TokenHub 真模型）→ 查 trajectory 是否同时捕获
 * 请求（含用户消息）与响应（含 finish_reason/usage/latency）。
 * 需先手工启动 server：PORT=3999 node --env-file=.env src/server.js
 */
const { randomUUID } = require('crypto');
const { db } = require('../src/db/index');
const schema = require('../src/db/schema');
const { eq } = require('drizzle-orm');
const { issueSessionToken } = require('../src/llm/sessionToken');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3999';
const MODEL = process.env.E2E_MODEL || 'TokenHub/deepseek-v4-flash-ga-260731';

async function main() {
    // 找一个「有 agent 授权且有 session 配额」的活跃用户
    const granted = await db.select({
        userId: schema.userAgentGrants.userId,
        agentId: schema.userAgentGrants.agentId,
    }).from(schema.userAgentGrants).limit(20);
    const seenSessions = await db.select({ userId: schema.sessions.userId, projectId: schema.sessions.projectId })
        .from(schema.sessions).limit(50);
    const projectByUser = new Map(seenSessions.map((s) => [s.userId, s.projectId]));
    let userId = null;
    let agentId = null;
    for (const g of granted) {
        const u = await db.select().from(schema.users).where(eq(schema.users.id, g.userId)).limit(1);
        if (u[0]?.status === 'active') { userId = g.userId; agentId = g.agentId; break; }
    }
    if (!userId) throw new Error('no active user with agent grants');
    const projectId = projectByUser.get(userId) ?? null;

    const sessionId = `sess_e2e_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    await db.insert(schema.sessions).values({
        id: sessionId, userId, projectId,
        agentId, status: 'running',
        cwd: 'C:\\tmp', streamRef: `traj-e2e-${sessionId}`, createdAt: now, updatedAt: now,
    });

    const token = issueSessionToken({
        sessionId, userId,
        projectId: projectId ?? undefined,
        agentId, model: MODEL, role: 'user',
    });

    const res = await fetch(`${BASE}/api/v1/llm/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
            max_tokens: 8,
            stream: false,
        }),
    });
    const body = await res.text();
    console.log('proxy status:', res.status);
    console.log('upstream body snippet:', body.slice(0, 160).replace(/\s+/g, ' '));

    await new Promise((r) => setTimeout(r, 400));
    // 直接查库校验（trajectory 查询 API 需要用户 JWT，这里省去登录）
    const steps = await db.select().from(schema.sessionTrajectory)
        .where(eq(schema.sessionTrajectory.sessionId, sessionId));
    steps.sort((a, b) => a.seq - b.seq);
    for (const s of steps) {
        console.log(`step #${s.seq} status=${s.status} latency=${s.latencyMs} model=${s.model} snapshot=${s.snapshot} msgCount=${s.msgCount}`);
        console.log('  request messages:', (s.request?.messages || []).length, '| response finish:', s.response?.finish_reason, '| usage:', s.response?.usage?.total_tokens, '| content kinds:', (s.response?.content || []).map((c) => c.type).join(','));
    }
    const ok = steps.some((s) => s.response && s.response.finish_reason);
    console.log(ok ? 'E2E PASS: response captured through real proxy' : 'E2E FAIL: response missing');

    await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
    process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
