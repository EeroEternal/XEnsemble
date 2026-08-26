const { eq } = require('drizzle-orm');
const { db } = require('../db');
const schema = require('../db/schema');

const MAX_HISTORY_CHARS = 4000;
const MAX_TITLE_LENGTH = 40;

function getLlmConfig() {
    return {
        apiKey: process.env.LLM_ANALYZE_API_KEY,
        apiUrl: process.env.LLM_ANALYZE_API_URL || 'https://api.deepseek.com/chat/completions',
        model: process.env.LLM_ANALYZE_MODEL || 'deepseek-chat',
    };
}

const STARTUP_KEYWORDS = /\b(welcome|config|setup|initializ|loading|checking|ready|starting|booting|installing|verifying|preparing|configur)\b/i;

function stripAnsi(input) {
    // eslint-disable-next-line no-control-regex
    return input.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

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

async function fetchSummary(history, agentName) {
    const { apiKey, apiUrl, model } = getLlmConfig();
    if (!apiKey) return null;

    const prompt = [
        'You are a concise session title generator.',
        'Given a terminal session transcript, output a short, natural title (max 20 characters) that describes what the session is doing.',
        `The agent is ${agentName || 'an assistant'}.`,
        'Respond with the title text only, no quotes, no markdown, no explanation.',
    ].join(' ');

    const body = {
        model,
        messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: history },
        ],
        max_tokens: 60,
        temperature: 0.6,
    };

    const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Title LLM API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
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
        .select({ id: schema.sessions.id, agentId: schema.sessions.agentId, title: schema.sessions.title })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId))
        .limit(1);

    if (!sessionRow.length) return null;
    if (sessionRow[0].title) return sessionRow[0].title;

    const sessionManager = require('./SessionManager');
    const liveSession = sessionManager.getSession(sessionId);
    if (!liveSession) return null;

    const history = stripAnsi(liveSession.history || '').slice(-MAX_HISTORY_CHARS).trim();
    const filteredHistory = filterStartupNoise(history);
    if (filteredHistory.length < 10) return null;

    const agentName = await loadAgentName(sessionRow[0].agentId);
    const title = await fetchSummary(filteredHistory, agentName);
    if (!title) return null;

    await db
        .update(schema.sessions)
        .set({ title })
        .where(eq(schema.sessions.id, sessionId));

    try {
        const { broadcastSse } = require('./sseManager');
        broadcastSse({ type: 'session_title', sessionId, title });
    } catch (_) {}

    console.log(`[titleService] Generated title for ${sessionId}: "${title}"`);
    return title;
}

module.exports = {
    generateSessionTitle,
    sanitizeTitle,
};
