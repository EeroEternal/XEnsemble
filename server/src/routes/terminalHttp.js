const auth = require('../auth/index');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { eq } = require('drizzle-orm');
const { getRuntime } = require('../runtime/registry');
const { ensureProjectRuntime } = require('../runtime/RuntimeService');
const agentGatewayConfig = require('../admin/AgentGatewayConfig');
const { issueSessionToken } = require('../llm/sessionToken');
const sessionManager = require('../session/SessionManager');
const { applyTerminalMessage, subscribeTerminal, resolveLiveSession } = require('../session/terminalBridge');
const { resumeSession } = require('../session/resumeSession');
const { buildResumeSessionContext } = require('../session/resumeSessionContext');
const transcriptStore = require('../runtime/TranscriptStore');
const runtime = getRuntime();
const { t } = require('../i18n');

function extractAccessToken(request) {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7).trim();
    const q = request.query?.access_token;
    if (typeof q === 'string' && q.trim()) return q.trim();
    return null;
}

async function assertSessionOwner(userId, sessionId) {
    const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    if (rows.length === 0) return { ok: false, status: 404, error: 'Session not found', code: 'session_not_found' };
    if (rows[0].userId !== userId) return { ok: false, status: 403, error: 'Forbidden', code: 'forbidden' };
    return { ok: true };
}

const { getProjectForUser } = require('../projects/getProjectForUser');

async function wakeIdleSession({ requestUser, requestLog, sessionRecord }) {
    const resumeContext = await buildResumeSessionContext({
        requestUser,
        requestLog,
        session: sessionRecord,
        db,
        schema,
        getProjectForUser,
        agentGatewayConfig,
        issueSessionToken,
    });
    return resumeSession({
        db,
        schema,
        sessionManager,
        runtime,
        project: resumeContext.project,
        session: sessionRecord,
        agentMeta: resumeContext.agentMeta,
        terminalThemeId: resumeContext.terminalThemeId,
        resolvedSpawnEnv: resumeContext.resolvedSpawnEnv,
        requestLog,
        fastifyLog: requestLog,
        ensureProjectRuntime,
        issueSessionToken,
        agentGatewayConfig,
        requestUser,
        byokConfigFiles: resumeContext.byokConfigFiles,
    });
}

async function authenticateTerminalRequest(request, reply) {
    const token = extractAccessToken(request);
    if (!token) {
        reply.code(401).send({ error: t('errors:unauthorized', {}, request.locale || 'en'), code: 'unauthorized' });
        return null;
    }
    const payload = auth.verifyAccessToken(token);
    if (!payload?.id) {
        reply.code(401).send({ error: t('errors:unauthorized', {}, request.locale || 'en'), code: 'unauthorized' });
        return null;
    }
    const rows = await db.select().from(schema.users).where(eq(schema.users.id, payload.id));
    if (rows.length === 0) {
        reply.code(401).send({ error: t('errors:unauthorized', {}, request.locale || 'en'), code: 'unauthorized' });
        return null;
    }
    const user = rows[0];
    const status = user.status || 'active';
    if (status !== 'active') {
        const code = status === 'pending' ? 'account_pending' : 'account_suspended';
        reply.code(403).send({ error: t('errors:' + code, {}, request.locale || 'en'), code });
        return null;
    }
    return { id: user.id, username: user.username, role: user.role, status };
}

function writeSse(reply, payload) {
    if (payload?.seq != null) {
        reply.raw.write(`id: ${payload.seq}\n`);
    }
    reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function registerTerminalHttpRoutes(fastify) {
    fastify.get('/api/v1/terminal/stream', async (request, reply) => {
        const user = await authenticateTerminalRequest(request, reply);
        if (!user) return;

        const sessionId = request.query?.sessionId;
        if (!sessionId || typeof sessionId !== 'string') {
            return reply.code(400).send({ error: t('errors:session_id_required', { defaultValue: 'sessionId is required' }, request.locale || 'en'), code: 'session_id_required' });
        }
        const afterHeader = request.headers['last-event-id'];
        const afterQuery = request.query?.after;
        const after = Number(
            typeof afterHeader === 'string' && afterHeader.trim() !== ''
                ? afterHeader
                : afterQuery
        );

        const access = await assertSessionOwner(user.id, sessionId);
        if (!access.ok) {
            return reply.code(access.status).send({ error: t('errors:' + access.code, {}, request.locale || 'en'), code: access.code });
        }

        const sessionRows = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
        const sessionRecord = sessionRows[0] || null;

        reply.hijack();
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        let streamEnded = false;
        const endStream = () => {
            if (streamEnded) return;
            streamEnded = true;
            try { reply.raw.end(); } catch (_) { /* already closed */ }
        };

        const send = (payload) => {
            if (streamEnded) return;
            if (payload.type === 'error' || payload.type === 'exit') {
                writeSse(reply, payload);
                endStream();
                return;
            }
            writeSse(reply, payload);
        };

        const sub = await subscribeTerminal(sessionId, send, {
            after: Number.isFinite(after) ? after : 0,
            sessionRecord,
            wakeSession: sessionRecord ? () => wakeIdleSession({
                requestUser: user,
                requestLog: request.log,
                sessionRecord,
            }) : null,
        });
        if (!sub.ok) {
            endStream();
            return;
        }

        const onClientClose = () => {
            sub.cleanup();
            endStream();
        };

        request.raw.on('close', onClientClose);
        request.raw.on('aborted', onClientClose);
    });

    fastify.post('/api/v1/terminal/input', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        const sessionId = request.body?.session_id || request.body?.sessionId;
        const type = request.body?.type;
        if (!sessionId) return reply.code(400).send({ error: 'session_id is required' });
        if (!type) return reply.code(400).send({ error: 'type is required' });

        const access = await assertSessionOwner(request.user.id, sessionId);
        if (!access.ok) return reply.code(access.status).send({ error: t('errors:' + access.code, {}, request.locale || 'en'), code: access.code });

        const sessionRows = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
        const sessionRecord = sessionRows[0] || null;
        const live = await resolveLiveSession(sessionId, {
            sessionRecord,
            wakeSession: sessionRecord ? () => wakeIdleSession({
                requestUser: request.user,
                requestLog: request.log,
                sessionRecord,
            }) : null,
        });
        if (!live.ok) {
            return reply.code(live.error.includes('not found') ? 404 : 409).send({ error: live.error });
        }

        const transcriptKind = type === 'input' ? 'in' : type === 'resize' ? 'resize' : null;
        const transcriptRef = live?.transcriptRef || live?.streamRef;
        if (transcriptKind && transcriptRef) {
            transcriptStore.append(transcriptRef, {
                kind: transcriptKind,
                data: transcriptKind === 'in'
                    ? request.body?.data
                    : { cols: request.body?.cols, rows: request.body?.rows },
            });
        }

        if (type === 'input') {
            sessionManager.touchActivity(sessionId, 'input');
        }

        applyTerminalMessage(live.handle, {
            type,
            data: request.body?.data,
            cols: request.body?.cols,
            rows: request.body?.rows,
        });
        return { ok: true };
    });
}

module.exports = { registerTerminalHttpRoutes };
