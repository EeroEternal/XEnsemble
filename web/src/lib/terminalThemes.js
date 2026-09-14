/** Terminal theme presets — https://terminalcolors.com/ */

export const XTERM_MINIMUM_CONTRAST_RATIO = 7;
export const DEFAULT_TERMINAL_THEME_ID = 'nord';

function buildDarkGrayRamp(stops) {
  const colors = new Array(240);
  for (let i = 0; i < 16; i += 1) {
    colors[216 + i] = stops[i];
  }
  return colors;
}

function inferGrayRamp(bg, black, mid, brightBlack) {
  return buildDarkGrayRamp([
    bg, bg, black, black,
    black, mid, mid, mid,
    brightBlack, brightBlack, brightBlack, brightBlack,
    brightBlack, mid, black, bg,
  ]);
}

function mixHex(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((c, i) => Math.round(c + (pb[i] - c) * t).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 256-color grayscale ramp (ANSI 232–255) retuned for light backgrounds.
 * The standard ramp ends near-white (#EEEEEE), which vanishes on a light
 * canvas — compress the light half into readable mid grays instead, the
 * same approach as VS Code Light+. Dark half stays dark.
 */
function buildLightGrayRamp(black, mid) {
  return buildDarkGrayRamp(Array.from({ length: 16 }, (_, i) => mixHex(black, mid, i / 15)));
}

function createDarkPreset({
  id,
  label,
  background,
  foreground,
  cursor,
  cursorAccent,
  selectionBackground,
  selectionForeground,
  palette,
  grayRamp,
}) {
  return {
    id,
    label,
    appearance: 'dark',
    spawnEnv: { COLORFGBG: '15;0', COLORTERM: 'truecolor' },
    xterm: {
      background,
      foreground,
      cursor,
      cursorAccent: cursorAccent ?? background,
      selectionBackground,
      selectionForeground,
      ...palette,
      extendedAnsi: grayRamp ?? buildLightGrayRamp(palette.black, palette.brightBlack),
    },
  };
}

function createLightPreset({
  id,
  label,
  background,
  foreground,
  cursor,
  cursorAccent,
  selectionBackground,
  selectionForeground,
  palette,
  grayRamp,
}) {
  return {
    id,
    label,
    appearance: 'light',
    // COLORFGBG 0;15 = 前景黑、背景白（浅色终端的标准反转，与 dark 的 15;0 相反）
    spawnEnv: { COLORFGBG: '0;15', COLORTERM: 'truecolor' },
    xterm: {
      background,
      foreground,
      cursor,
      cursorAccent: cursorAccent ?? background,
      selectionBackground,
      selectionForeground,
      ...palette,
      extendedAnsi: grayRamp ?? inferGrayRamp(background, palette.black, palette.brightBlack, palette.white),
    },
  };
}

const NORD = createDarkPreset({
  id: 'nord',
  label: 'Nord',
  background: '#2E3440',
  foreground: '#D8DEE9',
  cursor: '#88C0D0',
  selectionBackground: '#434C5E99',
  selectionForeground: '#ECEFF4',
  palette: {
    black: '#3B4252', red: '#BF616A', green: '#A3BE8C', yellow: '#EBCB8B',
    blue: '#81A1C1', magenta: '#B48EAD', cyan: '#88C0D0', white: '#E5E9F0',
    brightBlack: '#4C566A', brightRed: '#BF616A', brightGreen: '#A3BE8C', brightYellow: '#EBCB8B',
    brightBlue: '#5E81AC', brightMagenta: '#B48EAD', brightCyan: '#8FBCBB', brightWhite: '#ECEFF4',
  },
  grayRamp: inferGrayRamp('#2E3440', '#3B4252', '#434C5E', '#4C566A'),
});

const DRACULA = createDarkPreset({
  id: 'dracula',
  label: 'Dracula',
  background: '#282A36',
  foreground: '#F8F8F2',
  cursor: '#F8F8F0',
  selectionBackground: '#44475A99',
  selectionForeground: '#F8F8F2',
  palette: {
    black: '#21222C', red: '#FF5555', green: '#50FA7B', yellow: '#F1FA8C',
    blue: '#BD93F9', magenta: '#FF79C6', cyan: '#8BE9FD', white: '#F8F8F2',
    brightBlack: '#6272A4', brightRed: '#FF6E6E', brightGreen: '#69FF94', brightYellow: '#FFFFA5',
    brightBlue: '#D6ACFF', brightMagenta: '#FF92DF', brightCyan: '#A4FFFF', brightWhite: '#FFFFFF',
  },
  grayRamp: inferGrayRamp('#282A36', '#21222C', '#343746', '#6272A4'),
});

const TOKYO_NIGHT = createDarkPreset({
  id: 'tokyo-night',
  label: 'Tokyo Night',
  background: '#1A1B26',
  foreground: '#C0CAF5',
  cursor: '#7AA2F7',
  selectionBackground: '#33467C99',
  selectionForeground: '#C0CAF5',
  palette: {
    black: '#15161E', red: '#F7768E', green: '#9ECE6A', yellow: '#E0AF68',
    blue: '#7AA2F7', magenta: '#BB9AF7', cyan: '#7DCFFF', white: '#A9B1D6',
    brightBlack: '#414868', brightRed: '#F7768E', brightGreen: '#9ECE6A', brightYellow: '#E0AF68',
    brightBlue: '#7AA2F7', brightMagenta: '#BB9AF7', brightCyan: '#7DCFFF', brightWhite: '#C0CAF5',
  },
  grayRamp: inferGrayRamp('#1A1B26', '#15161E', '#1F2335', '#414868'),
});

const ONE_DARK = createDarkPreset({
  id: 'one-dark',
  label: 'One Dark',
  background: '#282C34',
  foreground: '#ABB2BF',
  cursor: '#528BFF',
  selectionBackground: '#3E445199',
  selectionForeground: '#ABB2BF',
  palette: {
    black: '#282C34', red: '#E06C75', green: '#98C379', yellow: '#E5C07B',
    blue: '#61AFEF', magenta: '#C678DD', cyan: '#56B6C2', white: '#ABB2BF',
    brightBlack: '#545862', brightRed: '#E06C75', brightGreen: '#98C379', brightYellow: '#E5C07B',
    brightBlue: '#61AFEF', brightMagenta: '#C678DD', brightCyan: '#56B6C2', brightWhite: '#C8CCD4',
  },
});

const SOLARIZED_DARK = createDarkPreset({
  id: 'solarized-dark',
  label: 'Solarized Dark',
  background: '#002B36',
  foreground: '#839496',
  cursor: '#839496',
  selectionBackground: '#07364299',
  selectionForeground: '#93A1A1',
  palette: {
    black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900',
    blue: '#268BD2', magenta: '#D33682', cyan: '#2AA198', white: '#EEE8D5',
    brightBlack: '#586E75', brightRed: '#CB4B16', brightGreen: '#859900', brightYellow: '#B58900',
    brightBlue: '#268BD2', brightMagenta: '#D33682', brightCyan: '#2AA198', brightWhite: '#FDF6E3',
  },
});

const GRUVBOX_DARK = createDarkPreset({
  id: 'gruvbox-dark',
  label: 'Gruvbox Dark',
  background: '#282828',
  foreground: '#EBDBB2',
  cursor: '#EBDBB2',
  selectionBackground: '#50494599',
  selectionForeground: '#FBF1C7',
  palette: {
    black: '#282828', red: '#CC241D', green: '#98971A', yellow: '#D79921',
    blue: '#458588', magenta: '#B16286', cyan: '#689D6A', white: '#A89984',
    brightBlack: '#928374', brightRed: '#FB4934', brightGreen: '#B8BB26', brightYellow: '#FABD2F',
    brightBlue: '#83A598', brightMagenta: '#D3869B', brightCyan: '#8EC07C', brightWhite: '#EBDBB2',
  },
});

const MONOKAI = createDarkPreset({
  id: 'monokai',
  label: 'Monokai',
  background: '#272822',
  foreground: '#F8F8F2',
  cursor: '#F8F8F0',
  selectionBackground: '#49483E99',
  selectionForeground: '#F8F8F2',
  palette: {
    black: '#272822', red: '#F92672', green: '#A6E22E', yellow: '#F4BF75',
    blue: '#66D9EF', magenta: '#AE81FF', cyan: '#A1EFE4', white: '#F8F8F2',
    brightBlack: '#75715E', brightRed: '#F92672', brightGreen: '#A6E22E', brightYellow: '#F4BF75',
    brightBlue: '#66D9EF', brightMagenta: '#AE81FF', brightCyan: '#A1EFE4', brightWhite: '#F9F8F5',
  },
});

const CATPPUCCIN_MOCHA = createDarkPreset({
  id: 'catppuccin-mocha',
  label: 'Catppuccin Mocha',
  background: '#1E1E2E',
  foreground: '#CDD6F4',
  cursor: '#F5E0DC',
  selectionBackground: '#45475A99',
  selectionForeground: '#CDD6F4',
  palette: {
    black: '#45475A', red: '#F38BA8', green: '#A6E3A1', yellow: '#F9E2AF',
    blue: '#89B4FA', magenta: '#F5C2E7', cyan: '#94E2D5', white: '#BAC2DE',
    brightBlack: '#585B70', brightRed: '#F38BA8', brightGreen: '#A6E3A1', brightYellow: '#F9E2AF',
    brightBlue: '#89B4FA', brightMagenta: '#F5C2E7', brightCyan: '#94E2D5', brightWhite: '#A6ADC8',
  },
});

const GITHUB_DARK = createDarkPreset({
  id: 'github-dark',
  label: 'GitHub Dark',
  background: '#0D1117',
  foreground: '#C9D1D9',
  cursor: '#58A6FF',
  selectionBackground: '#264F7899',
  selectionForeground: '#C9D1D9',
  palette: {
    black: '#484F58', red: '#FF7B72', green: '#3FB950', yellow: '#D29922',
    blue: '#58A6FF', magenta: '#BC8CFF', cyan: '#39C5CF', white: '#B1BAC4',
    brightBlack: '#6E7681', brightRed: '#FFA198', brightGreen: '#56D364', brightYellow: '#E3B341',
    brightBlue: '#79C0FF', brightMagenta: '#D2A8FF', brightCyan: '#56D4DD', brightWhite: '#F0F6FC',
  },
});

const ROSE_PINE_MOON = createDarkPreset({
  id: 'rose-pine-moon',
  label: 'Rosé Pine Moon',
  background: '#232136',
  foreground: '#E0DEF4',
  cursor: '#E0DEF4',
  selectionBackground: '#39355299',
  selectionForeground: '#E0DEF4',
  palette: {
    black: '#393552', red: '#EB6F92', green: '#3E8FB0', yellow: '#F6C177',
    blue: '#9CCFD8', magenta: '#C4A7E7', cyan: '#EA9A97', white: '#E0DEF4',
    brightBlack: '#6E6A86', brightRed: '#EB6F92', brightGreen: '#31748F', brightYellow: '#F6C177',
    brightBlue: '#9CCFD8', brightMagenta: '#C4A7E7', brightCyan: '#EA9A97', brightWhite: '#E0DEF4',
  },
});

const AYU_DARK = createDarkPreset({
  id: 'ayu-dark',
  label: 'Ayu Dark',
  background: '#0A0E14',
  foreground: '#B3B1AD',
  cursor: '#FFCC66',
  selectionBackground: '#25334099',
  selectionForeground: '#B3B1AD',
  palette: {
    black: '#01060E', red: '#FF3333', green: '#BAE67E', yellow: '#FFA759',
    blue: '#73D0FF', magenta: '#D4BFFF', cyan: '#95E6CB', white: '#B3B1AD',
    brightBlack: '#686868', brightRed: '#FF3333', brightGreen: '#BAE67E', brightYellow: '#FFA759',
    brightBlue: '#73D0FF', brightMagenta: '#D4BFFF', brightCyan: '#95E6CB', brightWhite: '#F3F4F5',
  },
});

const EVERFOREST_DARK = createDarkPreset({
  id: 'everforest-dark',
  label: 'Everforest Dark',
  background: '#2D353B',
  foreground: '#D3C6AA',
  cursor: '#E69875',
  selectionBackground: '#42505999',
  selectionForeground: '#D3C6AA',
  palette: {
    black: '#475258', red: '#E67E80', green: '#A7C080', yellow: '#DBBC7F',
    blue: '#7FBBB3', magenta: '#D699B6', cyan: '#83C092', white: '#D3C6AA',
    brightBlack: '#859289', brightRed: '#E67E80', brightGreen: '#A7C080', brightYellow: '#DBBC7F',
    brightBlue: '#7FBBB3', brightMagenta: '#D699B6', brightCyan: '#83C092', brightWhite: '#D3C6AA',
  },
});

const TOMORROW_NIGHT = createDarkPreset({
  id: 'tomorrow-night',
  label: 'Tomorrow Night',
  background: '#1D1F21',
  foreground: '#C5C8C6',
  cursor: '#C5C8C6',
  selectionBackground: '#373B4199',
  selectionForeground: '#C5C8C6',
  palette: {
    black: '#1D1F21', red: '#CC6666', green: '#B5BD68', yellow: '#F0C674',
    blue: '#81A2BE', magenta: '#B294BB', cyan: '#8ABEB7', white: '#C5C8C6',
    brightBlack: '#969896', brightRed: '#CC6666', brightGreen: '#B5BD68', brightYellow: '#F0C674',
    brightBlue: '#81A2BE', brightMagenta: '#B294BB', brightCyan: '#8ABEB7', brightWhite: '#FFFFFF',
  },
});

const ZENBURN = createDarkPreset({
  id: 'zenburn',
  label: 'Zenburn',
  background: '#3F3F3F',
  foreground: '#DCDCCC',
  cursor: '#FFFFEF',
  selectionBackground: '#54545499',
  selectionForeground: '#FFFFEF',
  palette: {
    black: '#1E2320', red: '#CC9393', green: '#7F9F7F', yellow: '#D0A060',
    blue: '#506070', magenta: '#CFAFAF', cyan: '#94BFFF', white: '#DCDCCC',
    brightBlack: '#709080', brightRed: '#CC9393', brightGreen: '#7F9F7F', brightYellow: '#D0A060',
    brightBlue: '#506070', brightMagenta: '#CFAFAF', brightCyan: '#94BFFF', brightWhite: '#FFFFEF',
  },
});

const OCEANIC_NEXT = createDarkPreset({
  id: 'oceanic-next',
  label: 'Oceanic Next',
  background: '#1B2B34',
  foreground: '#D8DEE9',
  cursor: '#6699CC',
  selectionBackground: '#4F5B6699',
  selectionForeground: '#D8DEE9',
  palette: {
    black: '#1B2B34', red: '#EC5F67', green: '#99C794', yellow: '#FAC863',
    blue: '#6699CC', magenta: '#C594C5', cyan: '#5FB3B3', white: '#C0C5CE',
    brightBlack: '#65737E', brightRed: '#EC5F67', brightGreen: '#99C794', brightYellow: '#FAC863',
    brightBlue: '#6699CC', brightMagenta: '#C594C5', brightCyan: '#5FB3B3', brightWhite: '#D8DEE9',
  },
});

const PALENIGHT = createDarkPreset({
  id: 'palenight',
  label: 'Palenight',
  background: '#292D3E',
  foreground: '#A6ACCD',
  cursor: '#FFCC00',
  selectionBackground: '#43475899',
  selectionForeground: '#A6ACCD',
  palette: {
    black: '#292D3E', red: '#F07178', green: '#C3E88D', yellow: '#FFCB6B',
    blue: '#82AAFF', magenta: '#C792EA', cyan: '#89DDFF', white: '#A6ACCD',
    brightBlack: '#676E95', brightRed: '#F07178', brightGreen: '#C3E88D', brightYellow: '#FFCB6B',
    brightBlue: '#82AAFF', brightMagenta: '#C792EA', brightCyan: '#89DDFF', brightWhite: '#EEFFFF',
  },
});

const NIGHT_OWL = createDarkPreset({
  id: 'night-owl',
  label: 'Night Owl',
  background: '#011627',
  foreground: '#D6DEEB',
  cursor: '#80A4C2',
  selectionBackground: '#1D3B5399',
  selectionForeground: '#D6DEEB',
  palette: {
    black: '#011627', red: '#EF5350', green: '#22DA6E', yellow: '#FFEB95',
    blue: '#82AAFF', magenta: '#C792EA', cyan: '#21C7A8', white: '#D6DEEB',
    brightBlack: '#575656', brightRed: '#EF5350', brightGreen: '#22DA6E', brightYellow: '#FFEB95',
    brightBlue: '#82AAFF', brightMagenta: '#C792EA', brightCyan: '#21C7A8', brightWhite: '#FFFFFF',
  },
});

const MATERIAL_DARKER = createDarkPreset({
  id: 'material-darker',
  label: 'Material Darker',
  background: '#212121',
  foreground: '#EEFFFF',
  cursor: '#FFCC00',
  selectionBackground: '#32323299',
  selectionForeground: '#EEFFFF',
  palette: {
    black: '#212121', red: '#F07178', green: '#C3E88D', yellow: '#FFCB6B',
    blue: '#82AAFF', magenta: '#C792EA', cyan: '#89DDFF', white: '#EEFFFF',
    brightBlack: '#545454', brightRed: '#F07178', brightGreen: '#C3E88D', brightYellow: '#FFCB6B',
    brightBlue: '#82AAFF', brightMagenta: '#C792EA', brightCyan: '#89DDFF', brightWhite: '#FFFFFF',
  },
});

const SYNTHWAVE = createDarkPreset({
  id: 'synthwave',
  label: 'Synthwave \'84',
  background: '#241B2F',
  foreground: '#F0EFF1',
  cursor: '#FF7EDB',
  selectionBackground: '#34294F99',
  selectionForeground: '#F0EFF1',
  palette: {
    black: '#241B2F', red: '#FE4450', green: '#72F1B8', yellow: '#FEDE5D',
    blue: '#36F9F6', magenta: '#FF7EDB', cyan: '#36F9F6', white: '#F0EFF1',
    brightBlack: '#848BBD', brightRed: '#FE4450', brightGreen: '#72F1B8', brightYellow: '#FEDE5D',
    brightBlue: '#36F9F6', brightMagenta: '#FF7EDB', brightCyan: '#36F9F6', brightWhite: '#FFFFFF',
  },
});

const GITHUB_LIGHT = createLightPreset({
  id: 'github-light',
  label: 'GitHub Light',
  background: '#FFFFFF',
  foreground: '#1F2328',
  cursor: '#0969DA',
  selectionBackground: '#0969DA33',
  selectionForeground: '#1F2328',
  // GitHub 官方浅色终端配色（Primer）：白底上所有 ANSI 色 ≥ 4.5:1 对比度
  palette: {
    black: '#24292F', red: '#CF222E', green: '#116329', yellow: '#9A6700',
    blue: '#0969DA', magenta: '#8250DF', cyan: '#1B7C83', white: '#57606A',
    brightBlack: '#57606A', brightRed: '#A40E26', brightGreen: '#1A7F37', brightYellow: '#633C01',
    brightBlue: '#218BFF', brightMagenta: '#A475F9', brightCyan: '#3192AA', brightWhite: '#6E7781',
  },
});

const SOLARIZED_LIGHT = createLightPreset({
  id: 'solarized-light',
  label: 'Solarized Light',
  background: '#FDF6E3',
  foreground: '#657B83',
  cursor: '#657B83',
  selectionBackground: '#EEE8D599',
  selectionForeground: '#586E75',
  palette: {
    black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900',
    blue: '#268BD2', magenta: '#D33682', cyan: '#2AA198', white: '#EEE8D5',
    brightBlack: '#586E75', brightRed: '#CB4B16', brightGreen: '#859900', brightYellow: '#B58900',
    brightBlue: '#268BD2', brightMagenta: '#D33682', brightCyan: '#2AA198', brightWhite: '#FDF6E3',
  },
});

const PRESETS = [
  NORD, DRACULA, TOKYO_NIGHT, ONE_DARK, SOLARIZED_DARK, GRUVBOX_DARK,
  MONOKAI, CATPPUCCIN_MOCHA, GITHUB_DARK, ROSE_PINE_MOON, AYU_DARK,
  EVERFOREST_DARK, TOMORROW_NIGHT, ZENBURN, OCEANIC_NEXT, PALENIGHT,
  NIGHT_OWL, MATERIAL_DARKER, SYNTHWAVE,
  GITHUB_LIGHT, SOLARIZED_LIGHT,
];

const PRESET_BY_ID = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

export function listTerminalThemes() {
  return PRESETS.slice();
}

export function getTerminalTheme(id) {
  return PRESET_BY_ID[id] ?? PRESET_BY_ID[DEFAULT_TERMINAL_THEME_ID];
}

export function getDefaultTerminalThemeId() {
  return DEFAULT_TERMINAL_THEME_ID;
}

export function mergeTerminalCatalog(serverThemes) {
  const local = listTerminalThemes();
  if (!Array.isArray(serverThemes) || serverThemes.length === 0) {
    return local;
  }
  const serverById = Object.fromEntries(serverThemes.map((entry) => [entry.id, entry]));
  return local.map((preset) => {
    const remote = serverById[preset.id];
    if (!remote) return preset;
    return {
      ...preset,
      label: remote.label || preset.label,
      appearance: remote.appearance === 'light' ? 'light' : 'dark',
    };
  });
}
