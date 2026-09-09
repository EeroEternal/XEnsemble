const { db } = require('../db/index');
const schema = require('../db/schema');
const { eq, and } = require('drizzle-orm');
const terminalThemes = require('../config/terminalThemes');
const platformSettings = require('./PlatformSettings');

async function getPreferences(userId) {
    const rows = await db.select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, userId));
    const out = {};
    for (const row of rows) {
        try {
            out[row.key] = JSON.parse(row.value);
        } catch {
            out[row.key] = row.value;
        }
    }
    return out;
}

async function getTerminalThemeId(userId) {
    const prefs = await getPreferences(userId);
    return typeof prefs.terminal_theme_id === 'string' ? prefs.terminal_theme_id : null;
}

async function setPreference(userId, key, value) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const existing = await db.select().from(schema.userPreferences)
        .where(and(eq(schema.userPreferences.userId, userId), eq(schema.userPreferences.key, key)));
    if (existing.length > 0) {
        await db.update(schema.userPreferences)
            .set({ value: serialized })
            .where(and(eq(schema.userPreferences.userId, userId), eq(schema.userPreferences.key, key)));
    } else {
        await db.insert(schema.userPreferences).values({ userId, key, value: serialized });
    }
}

async function updatePreferences(userId, updates = {}) {
    const settings = await platformSettings.getAll();
    const disabledIds = settings.disabled_terminal_theme_ids || [];

    if (updates.terminal_theme_id !== undefined) {
        const themeId = updates.terminal_theme_id;
        if (themeId !== null && typeof themeId !== 'string') {
            throw Object.assign(new Error('terminal_theme_id must be a string'), { statusCode: 400 });
        }
        if (themeId && !terminalThemes.isThemeSelectable(themeId, { disabledIds })) {
            throw Object.assign(new Error(`Terminal theme "${themeId}" is not available`), { statusCode: 400 });
        }
        if (themeId) {
            await setPreference(userId, 'terminal_theme_id', themeId);
        } else if (updates.terminal_theme_id === null || updates.terminal_theme_id === '') {
            await db.delete(schema.userPreferences)
                .where(and(
                    eq(schema.userPreferences.userId, userId),
                    eq(schema.userPreferences.key, 'terminal_theme_id'),
                ));
        }
    }

    if (updates.git_author_name !== undefined) {
        if (updates.git_author_name) {
            await setPreference(userId, 'git_author_name', updates.git_author_name);
        } else {
            await db.delete(schema.userPreferences)
                .where(and(
                    eq(schema.userPreferences.userId, userId),
                    eq(schema.userPreferences.key, 'git_author_name'),
                ));
        }
    }

    if (updates.git_author_email !== undefined) {
        if (updates.git_author_email) {
            await setPreference(userId, 'git_author_email', updates.git_author_email);
        } else {
            await db.delete(schema.userPreferences)
                .where(and(
                    eq(schema.userPreferences.userId, userId),
                    eq(schema.userPreferences.key, 'git_author_email'),
                ));
        }
    }

    return getPreferences(userId);
}

module.exports = {
    getPreferences,
    setPreference,
    getTerminalThemeId,
    updatePreferences,
};
