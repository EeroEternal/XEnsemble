import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_TERMINAL_THEME_ID,
  XTERM_MINIMUM_CONTRAST_RATIO,
  getDefaultTerminalThemeId,
  getTerminalTheme,
  listTerminalThemes,
  mergeTerminalCatalog,
} from './terminalThemes.js';

const REQUIRED_XTERM_KEYS = [
  'background',
  'foreground',
  'cursor',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
];

describe('terminalThemes', () => {
  it('lists built-in presets', () => {
    const themes = listTerminalThemes();
    const ids = themes.map((t) => t.id);
    assert.ok(themes.length >= 15, 'expected many built-in themes');
    assert.ok(ids.includes('nord'));
    assert.ok(ids.includes('dracula'));
    assert.ok(ids.includes('tokyo-night'));
    assert.ok(ids.includes('one-dark'));
    assert.ok(ids.includes('catppuccin-mocha'));
  });

  it('defaults to github-dark', () => {
    assert.strictEqual(getDefaultTerminalThemeId(), DEFAULT_TERMINAL_THEME_ID);
    assert.strictEqual(getDefaultTerminalThemeId(), 'github-dark');
  });

  it('exports minimum contrast ratio', () => {
    assert.strictEqual(XTERM_MINIMUM_CONTRAST_RATIO, 7);
  });

  for (const preset of listTerminalThemes()) {
    it(`${preset.id} has complete xterm theme and spawn env`, () => {
      assert.strictEqual(preset.appearance, 'dark');
      assert.strictEqual(preset.spawnEnv.COLORFGBG, '15;0');
      for (const key of REQUIRED_XTERM_KEYS) {
        assert.ok(preset.xterm[key], `missing xterm.${key}`);
      }
      assert.ok(Array.isArray(preset.xterm.extendedAnsi));
      assert.strictEqual(preset.xterm.extendedAnsi.length, 240);
      assert.ok(preset.xterm.extendedAnsi[216], 'missing gray ramp start');
    });
  }

  it('falls back unknown ids to default preset', () => {
    assert.strictEqual(getTerminalTheme('unknown').id, 'github-dark');
  });

  it('merges server catalog with local palettes', () => {
    const merged = mergeTerminalCatalog([
      { id: 'dracula', label: 'Dracula (server)' },
      { id: 'missing', label: 'Missing' },
    ]);
    assert.strictEqual(merged.length, listTerminalThemes().length);
    const dracula = merged.find((t) => t.id === 'dracula');
    assert.strictEqual(dracula.label, 'Dracula (server)');
    assert.ok(dracula.xterm.background);
  });

  it('mergeTerminalCatalog falls back when server list empty', () => {
    const count = listTerminalThemes().length;
    assert.strictEqual(mergeTerminalCatalog([]).length, count);
    assert.strictEqual(mergeTerminalCatalog(null).length, count);
  });
});
