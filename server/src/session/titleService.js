const { eq } = require('drizzle-orm');
const { db } = require('../db');
const schema = require('../db/schema');
const { stripAnsi } = require('./terminalText');
const llm = require('../llm/analyzeClient');

const MAX_HISTORY_CHARS = 4000;
const MAX_TITLE_LENGTH = 40;

const STARTUP_KEYWORDS = /\b(welcome|config|setup|initializ|loading|checking|ready|starting|booting|installing|verifying|preparing|configur)\b/i;

function filterStartupNoise(text) {
    const lines = text.split('\n');
    const filtered = lines.filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        return !STARTUP_KEYWORDS.test(trimmed);
    });
    return filtered.join('\n').trim();
}

function sanitizeTitle(raw) {
    if (!raw) return null;
    return raw
        .replace(/["'`]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(0, MAX_TITLE_LENGTH)
        .trim();
}

async function fetchSummary(history, agentName, metering) {
    if (!llm.isConfigured()) return null;

    const prompt = [
        'You are a concise session title generator.',
        'Given a terminal session transcript, output a short, natural title (max 20 characters) that describes what the session is doing.',
        `The agent is ${agentName || 'an assistant'}.`,
        'Respond with the title text only, no quotes, no markdown, no explanation.',
    ].join(' ');

    const content = await llm.chat({
        system: prompt,
        user: history,
        metering, // 0043：内部计量归属（feature='session_title'）
        // 推理模型（如 GLM-5）的思维链会占用输出 token，60 会被思维链耗尽导致 content 为空，
        // 因此给足余量；sanitizeTitle 最终仍截断到 MAX_TITLE_LENGTH。
        options: { maxTokens: 512, temperature: 0.6 },
    });
    return sanitizeTitle(content);
}

async function loadAgentName(agentId) {
    try {
        const rows = await db
            .select({ name: schema.agents.name })
            .from(schema.agents)
            .where(eq(schema.agents.id, agentId));
        return rows[0]?.name || agentId;
    } catch {
        return agentId;
    }
}

async function generateSessionTitle(sessionId) {
    const sessionRow = await db
        .select({ id: schema.sessions.id, userId: schema.sessions.userId, agentId: schema.sessions.agentId, title: schema.sessions.title, titleManual: schema.sessions.titleManual })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId))
        .limit(1);

    if (!sessionRow.length) return null;
    // User has manually set a title — never overwrite it.
    if (sessionRow[0].titleManual) return sessionRow[0].title || null;
    if (sessionRow[0].title) return sessionRow[0].title;

    const sessionManager = require('./SessionManager');
    const liveSession = sessionManager.getSession(sessionId);
    if (!liveSession) return null;

    const history = stripAnsi(liveSession.history || '').slice(-MAX_HISTORY_CHARS).trim();
    const filteredHistory = filterStartupNoise(history);
    if (filteredHistory.length < 10) return null;

    const agentName = await loadAgentName(sessionRow[0].agentId);
    // 0043：内部计量归属（feature='session_title'），userId 直接取自会话行。
    const title = await fetchSummary(
        filteredHistory,
        agentName,
        { feature: 'session_title', userId: sessionRow[0].userId, sessionId },
    );
    if (!title) return null;

    await db
        .update(schema.sessions)
        .set({ title })
        .where(eq(schema.sessions.id, sessionId));

    try {
        const { broadcastSse } = require('./sseManager');
        broadcastSse({ type: 'session_title', sessionId, title, userId: sessionRow[0].userId });
    } catch (_) {}

    console.log(`[titleService] Generated title for ${sessionId}: "${title}"`);
    return title;
}

module.exports = {
    generateSessionTitle,
    sanitizeTitle,
};
