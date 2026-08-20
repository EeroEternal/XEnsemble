const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    resolveEffectiveTerminalThemeId,
    getThemeSpawnEnv,
    listPublicThemes,
} = require('./terminalThemes');
const {
    mergeSpawnEnvLayers,
} = require('../agents/agentEnv');

describe('terminalThemes', () => {
    it('resolves theme priority: request > user > platform > catalog', () => {
        assert.equal(
            resolveEffectiveTerminalThemeId({
                requestThemeId: 'dracula',
                userThemeId: 'nord',
                platformDefaultId: 'one-dark',
            }),
            'dracula',
        );
        assert.equal(
            resolveEffectiveTerminalThemeId({
                userThemeId: 'dracula',
                platformDefaultId: 'nord',
            }),
            'dracula',
        );
        assert.equal(
            resolveEffectiveTerminalThemeId({
                platformDefaultId: 'one-dark',
            }),
            'one-dark',
        );
    });

    it('falls back when theme is disabled by admin', () => {
        const warnings = [];
        assert.equal(
            resolveEffectiveTerminalThemeId({
                requestThemeId: 'dracula',
                platformDefaultId: 'nord',
                disabledIds: ['dracula'],
                warn: (msg) => warnings.push(msg),
            }),
            'nord',
        );
        assert.equal(warnings.length, 1);
    });

    it('falls back when theme is catalog-disabled', () => {
        assert.equal(
            resolveEffectiveTerminalThemeId({
                requestThemeId: 'solarized-light',
                platformDefaultId: 'nord',
            }),
            'nord',
        );
    });

    it('lists only enabled non-disabled themes', () => {
        const catalog = listPublicThemes({
            platformDefaultId: 'nord',
            disabledIds: ['dracula'],
        });
        assert.equal(catalog.default_id, 'nord');
        assert.ok(catalog.themes.some((t) => t.id === 'nord'));
        assert.ok(!catalog.themes.some((t) => t.id === 'dracula'));
        assert.ok(!catalog.themes.some((t) => t.id === 'solarized-light'));
    });

    it('provides COLORFGBG from dark presets', () => {
        assert.equal(getThemeSpawnEnv('nord').COLORFGBG, '15;0');
        assert.equal(getThemeSpawnEnv('dracula').COLORFGBG, '15;0');
    });
});

describe('mergeSpawnEnvLayers', () => {
    it('merges platform theme, user theme, then secrets', () => {
        const env = mergeSpawnEnvLayers({
            platformSpawnEnv: { COLORFGBG: '15;0', COLORTERM: 'truecolor' },
            themeSpawnEnv: { COLORFGBG: '15;0' },
            secretEnv: { ANTHROPIC_API_KEY: 'sk-test' },
        });
        assert.equal(env.COLORFGBG, '15;0');
        assert.equal(env.COLORTERM, 'truecolor');
        assert.equal(env.ANTHROPIC_API_KEY, 'sk-test');
    });
});
