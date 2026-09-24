import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  stripAnsi,
  parseQuestionTool,
  detectTuiPrompt,
} from './terminalPromptHeuristics.mjs';

describe('stripAnsi', () => {
  it('strips SGR color codes and cursor moves', () => {
    assert.equal(stripAnsi('\x1b[32mOK\x1b[0m'), 'OK');
    assert.equal(stripAnsi('\x1b[2J\x1b[Hhello'), 'hello');
    assert.equal(stripAnsi('a\x1b[?2026h\x1b[?2026lb'), 'ab');
  });

  it('strips OSC window-title sequences', () => {
    assert.equal(stripAnsi('\x1b]0;my title\u0007prompt'), 'prompt');
  });

  it('leaves plain text untouched', () => {
    assert.equal(stripAnsi('Do you want to proceed? [y/n]'), 'Do you want to proceed? [y/n]');
    assert.equal(stripAnsi(''), '');
    assert.equal(stripAnsi(null), '');
  });
});

describe('parseQuestionTool', () => {
  it('parses Claude Code AskUserQuestion with options', () => {
    const q = parseQuestionTool('AskUserQuestion', JSON.stringify({
      questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'PG', description: 'postgres' }, 'SQLite'] }],
    }));
    assert.ok(Array.isArray(q) && q.length === 1);
    assert.equal(q[0].text, 'Which DB?');
    assert.deepEqual(q[0].options.map((o) => o.label), ['PG', 'SQLite']);
  });

  it('parses Cline ask_followup_question (free text, no options)', () => {
    const q = parseQuestionTool('ask_followup_question', JSON.stringify({ question: 'Use port 8080?' }));
    assert.equal(q[0].text, 'Use port 8080?');
    assert.equal(q[0].options.length, 0);
  });

  it('returns null for non-question tool args', () => {
    assert.equal(parseQuestionTool('write_file', JSON.stringify({ path: 'a.js', content: 'x' })), null);
    assert.equal(parseQuestionTool('bash', 'not json'), null);
  });
});

describe('detectTuiPrompt', () => {
  it('detects yes/no prompts', () => {
    const r = detectTuiPrompt(['Some output', 'Do you want to proceed? (y/n)']);
    assert.equal(r.kind, 'yesno');
  });

  it('detects numbered option pickers with question context', () => {
    const r = detectTuiPrompt([
      'Choose an option:',
      '❯ 1. Yes, allow once',
      '  2. Yes, always',
      '  3. No',
    ]);
    assert.equal(r.kind, 'select');
  });

  it('detects press-enter gates with question context', () => {
    const r = detectTuiPrompt(['Plan ready. Press Enter to confirm and continue…']);
    assert.equal(r.kind, 'continue');
  });

  it('ignores idle TUI chrome without question context', () => {
    assert.equal(detectTuiPrompt(['✻ Compressing… (esc to interrupt · 12s)']), null);
    assert.equal(detectTuiPrompt(['Press Enter to submit to GitHub']), null);
    assert.equal(detectTuiPrompt([]), null);
  });

  it('does not flag idle completion screens (footer "?" + bare input cursor)', () => {
    const r = detectTuiPrompt([
      '⏺ Task completed successfully',
      '⏺ All 12 tests passing',
      '⏺ Updated src/login.ts',
      '',
      'Total cost:            $0.42',
      'Total duration (API):  1m 23.4s',
      '',
      '? for shortcuts',
      '❯',
    ]);
    assert.equal(r, null);
  });

  it('does not flag numbered completion summaries without a question line', () => {
    const r = detectTuiPrompt([
      '⏺ Done! Here is what I did:',
      '  1. Fixed the login redirect loop',
      '  2. Updated tests for the new flow',
      '  3. Cleaned up unused imports',
      '? for shortcuts',
      '❯',
    ]);
    assert.equal(r, null);
  });

  it('does not flag summaries whose prose merely contains question-ish words', () => {
    const r = detectTuiPrompt([
      '任务完成。',
      '1. 修复了登录重定向',
      '2. 后续可继续优化性能',
      '❯',
    ]);
    assert.equal(r, null);
  });

  it('detects GitHub Copilot CLI permission dialogs without a question line', () => {
    // Copilot CLI 的工具权限对话框：圆角方框内只有工具名 + 命令 + 编号 Yes/No
    // 选项，整屏没有一句问话 —— 选项列表本身承载「请选择」语义。
    // 回归：两个 select 分支都强依赖 questionLine，copilot 的对话框永远
    // 凑不出问句行 → 等待通知从不触发。
    const r = detectTuiPrompt([
      '╭─ shell ──────────────────────────────╮',
      '│ npm run build                        │',
      '│                                      │',
      '│ ❯ 1. Yes                             │',
      "│   2. Yes, and don't ask again for    │",
      '│      similar commands                │',
      '│   3. No, and tell Copilot what to    │',
      '│      do differently (esc)            │',
      '╰──────────────────────────────────────╯',
    ]);
    assert.equal(r.kind, 'select');
  });

  it('detects Copilot CLI "? Allow command: <cmd>" pickers (question mark not at EOL)', () => {
    // 问句在行首、命令跟在后面 —— 问号不在行尾，行首动词是 allow。
    const r = detectTuiPrompt([
      '? Allow command: npm test',
      '❯ 1. Yes',
      "  2. Yes, and don't ask again for similar commands",
      '  3. No, tell Copilot what to do differently (esc)',
    ]);
    assert.equal(r.kind, 'select');
  });

  it('detects unnumbered Copilot CLI pickers via allow-anchored question + ❯ cursor', () => {
    const r = detectTuiPrompt([
      'Allow command: npm test',
      '❯ Yes',
      "  Yes, and don't ask again",
      '  No, tell Copilot what to do differently (esc)',
    ]);
    assert.equal(r.kind, 'select');
  });

  it('does not flag question-free numbered lists without yes/no option semantics', () => {
    // 无问句分支的负例门槛：首项必须 yes-like 且后续存在 no-like 选项。
    // 只有 yes-like 开头、没有 no-like 兄弟项的编号列表不是选择器。
    assert.equal(detectTuiPrompt([
      'Here is what happened:',
      '❯ 1. Yes-style headers were kept',
      '  2. Updated the docs accordingly',
    ]), null);
  });

  it('detects real prompts wrapped in leading decoration (indent / box / bullet)', () => {
    // Regression: real TUIs wrap the prompt block in decoration. Anchoring the
    // option cursor / question line to column 0 made every real picker
    // undetectable, so no waiting notification ever fired. Detection must
    // survive any amount of leading whitespace AND non-blank decoration.
    const picker = (q, ...opts) => detectTuiPrompt([q, ...opts])?.kind;
    // leading whitespace: any count, tabs, fullwidth space
    assert.equal(picker('Choose an option:', '❯ 1. Yes', '  2. No'), 'select');
    assert.equal(picker('   Choose an option:', '   ❯ 1. Yes', '     2. No'), 'select');
    assert.equal(picker('          Choose an option:', '          ❯ 1. Yes'), 'select');
    assert.equal(picker('\tChoose an option:', '\t❯ 1. Yes'), 'select');
    assert.equal(picker('\u3000Choose an option:', '\u3000❯ 1. Yes'), 'select');
    // non-blank decoration: box borders / bullets
    assert.equal(picker('│ Choose an option:', '│ ❯ 1. Yes', '│ 2. No'), 'select');
    assert.equal(picker('┃ Choose an option:', '┃ ❯ 1. Yes'), 'select');
    assert.equal(picker('| Choose an option:', '| ❯ 1. Yes'), 'select');
    assert.equal(picker('* Choose an option:', '* ❯ 1. Yes'), 'select');
    // question line + cursor both decorated
    assert.equal(picker('│  Trust this folder?', '│  ❯ Trust this folder'), 'select');
  });

  it('works on ANSI-laden transcript lines after stripAnsi', () => {
    const raw = ['\x1b[32m✓ Done\x1b[0m', '\x1b[1mAllow execution? (y/n)\x1b[0m'];
    const r = detectTuiPrompt(raw.map((l) => stripAnsi(l)));
    assert.equal(r.kind, 'yesno');
  });
});
