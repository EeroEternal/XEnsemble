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

  it('works on ANSI-laden transcript lines after stripAnsi', () => {
    const raw = ['\x1b[32m✓ Done\x1b[0m', '\x1b[1mAllow execution? (y/n)\x1b[0m'];
    const r = detectTuiPrompt(raw.map((l) => stripAnsi(l)));
    assert.equal(r.kind, 'yesno');
  });
});
