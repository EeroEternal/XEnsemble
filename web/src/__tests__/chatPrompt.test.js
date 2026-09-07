import { describe, it, expect } from 'vitest';
import {
  parseQuestionTool,
  detectTuiPrompt,
  KEY_ARROW_DOWN,
  KEY_ARROW_UP,
  KEY_ENTER,
  KEY_SPACE,
} from '@/lib/chatPrompt';

describe('parseQuestionTool', () => {
  it('parses Claude Code AskUserQuestion args with questions/options', () => {
    const args = JSON.stringify({
      questions: [
        {
          question: 'Which database?',
          header: 'DB',
          options: [
            { label: 'PostgreSQL', description: 'default' },
            { label: 'SQLite' },
          ],
          multiSelect: false,
        },
      ],
    });
    const questions = parseQuestionTool('AskUserQuestion', args);
    expect(questions).not.toBeNull();
    expect(questions).toHaveLength(1);
    expect(questions[0].text).toBe('Which database?');
    expect(questions[0].header).toBe('DB');
    expect(questions[0].options).toEqual([
      { label: 'PostgreSQL', description: 'default' },
      { label: 'SQLite', description: '' },
    ]);
    expect(questions[0].multiSelect).toBe(false);
  });

  it('accepts a choices alias and plain-string options for unknown tool names', () => {
    const args = JSON.stringify({ question: '继续吗?', choices: ['是', '否'] });
    const questions = parseQuestionTool('SomeAgentAsk', args);
    expect(questions).not.toBeNull();
    expect(questions[0].options.map((o) => o.label)).toEqual(['是', '否']);
  });

  it('parses option-less question tools as free-text prompts', () => {
    const args = JSON.stringify({ question: 'What is your preferred stack?' });
    const questions = parseQuestionTool('ask_followup_question', args);
    expect(questions).not.toBeNull();
    expect(questions[0].options).toHaveLength(0);
  });

  it('parses a bare array shape and {name} option objects', () => {
    const args = JSON.stringify([
      { question: 'Q1', options: [{ name: 'A' }] },
      { question: 'Q2', options: ['B'] },
    ]);
    const questions = parseQuestionTool('AskUserQuestion', args);
    expect(questions).not.toBeNull();
    expect(questions).toHaveLength(2);
    expect(questions[0].options[0].label).toBe('A');
    expect(questions[1].options[0].label).toBe('B');
  });

  it('returns null for non-question tool calls (large args, no shape match)', () => {
    const bigFile = 'x'.repeat(9000);
    expect(parseQuestionTool('Write', JSON.stringify({ file_path: 'a.js', content: bigFile }))).toBeNull();
    expect(parseQuestionTool('Bash', JSON.stringify({ command: 'ls', options: [] }))).toBeNull();
    expect(parseQuestionTool('Read', 'not json')).toBeNull();
    expect(parseQuestionTool('Read', '')).toBeNull();
  });
});

describe('detectTuiPrompt', () => {
  it('detects y/n confirmation prompts', () => {
    const lines = ['', 'Do you want to allow this command? (y/n)', ''];
    const detected = detectTuiPrompt(lines);
    expect(detected?.kind).toBe('yesno');
    expect(detected.lines.length).toBeGreaterThan(0);
  });

  it('detects numbered option pickers (Claude Code permission style)', () => {
    const lines = [
      'Allow Bash command?',
      '❯ 1. Yes',
      '  2. Yes, and don\'t ask again',
      '  3. No',
    ];
    expect(detectTuiPrompt(lines)?.kind).toBe('select');
  });

  it('detects press-enter gates only with question context', () => {
    expect(detectTuiPrompt(['Deploy complete.', 'Proceed? Press Enter to continue...'])?.kind).toBe('continue');
    // Idle footer without question context must NOT fire.
    expect(detectTuiPrompt(['type your message', 'press enter to submit'])).toBeNull();
  });

  it('returns null for ordinary terminal output', () => {
    expect(detectTuiPrompt(['$ npm install', 'added 52 packages', 'done in 3s'])).toBeNull();
    expect(detectTuiPrompt([])).toBeNull();
  });

  it('ignores cursor markers without question context', () => {
    expect(detectTuiPrompt(['❯ feature/main', 'main'])).toBeNull();
  });
});

describe('key constants', () => {
  it('uses CSI arrow sequences, CR for Enter and space for toggle', () => {
    expect(KEY_ARROW_DOWN).toBe('\x1b[B');
    expect(KEY_ARROW_UP).toBe('\x1b[A');
    expect(KEY_ENTER).toBe('\r');
    expect(KEY_SPACE).toBe(' ');
  });
});
