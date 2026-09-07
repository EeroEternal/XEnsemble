/**
 * Chat-mode prompt helpers.
 *
 * Two complementary sources tell the dialog view that the agent is waiting
 * for the user:
 *
 * 1. parseQuestionTool — structured question tools (Claude Code
 *    AskUserQuestion, Cline ask_followup_question, generic {question,
 *    options} shapes) recorded by the LLM proxy as tool_call entries. These
 *    carry the full question/option payload, so the chat view can render
 *    clickable cards and replay the answer as terminal keystrokes.
 *
 * 2. detectTuiPrompt — everything else (permission pickers, plan approval,
 *    y/n questions) never flows through the LLM proxy; it exists only on the
 *    terminal screen. The chat view feeds the live PTY stream into a headless
 *    xterm buffer and runs this heuristic over the screen text.
 */

// Terminal key sequences replayed over the WS input channel when the user
// answers from chat mode (same bytes the Agent view sends when navigating
// the TUI's option picker).
export const KEY_ARROW_UP = '\x1b[A';
export const KEY_ARROW_DOWN = '\x1b[B';
export const KEY_ENTER = '\r';
export const KEY_SPACE = ' ';

// Agent question tools whose TUI renders an option picker. Detection is
// primarily shape-based (works across agent CLIs); this list only unlocks
// option-less (free-text) question prompts.
const QUESTION_TOOL_NAMES = new Set([
  'askuserquestion', 'ask_user_question', 'ask_user', 'askuser', 'askquestion',
  'userquestion', 'user_questions', 'ask_questions', 'askquestions',
  'request_user_input', 'requestuserinput', 'ask_followup_question',
  'askfollowupquestion', 'ask_human', 'askhuman',
]);

/**
 * Parse a tool_call entry into a question list, or return null when the call
 * is not an agent-question prompt. Supported shapes:
 *  - Claude Code AskUserQuestion: { questions: [{ question, header, options: [{label, description}], multiSelect }] }
 *  - Cline ask_followup_question: { question } (free-text answer)
 *  - Generic: { question | prompt | text, options | choices: [...] }, or a
 *    bare array of those. Options may be strings or objects
 *    ({label|name|value|title, description}).
 */
export function parseQuestionTool(toolName, argsContent) {
  if (typeof argsContent !== 'string' || !argsContent.trim()) return null;
  const norm = String(toolName || '').toLowerCase().replace(/[^a-z_]/g, '');
  const named = QUESTION_TOOL_NAMES.has(norm);
  // Cheap pre-check so large non-question tool args (file writes, diffs)
  // skip JSON.parse entirely.
  if (!named && argsContent.length > 8192) return null;
  if (!named && !/"(questions?|options|choices|prompt)"/.test(argsContent)) return null;
  let parsed;
  try { parsed = JSON.parse(argsContent); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  let list = null;
  if (Array.isArray(parsed.questions)) list = parsed.questions;
  else if (Array.isArray(parsed)) list = parsed;
  else if (
    typeof parsed.question === 'string'
    || typeof parsed.prompt === 'string'
    || typeof parsed.text === 'string'
  ) list = [parsed];
  if (!Array.isArray(list) || list.length === 0) return null;
  const questions = [];
  for (const q of list) {
    if (!q || typeof q !== 'object') return null;
    const text = typeof q.question === 'string' ? q.question
      : (typeof q.prompt === 'string' ? q.prompt : (typeof q.text === 'string' ? q.text : ''));
    if (!text) return null;
    const rawOptions = Array.isArray(q.options) ? q.options : (Array.isArray(q.choices) ? q.choices : []);
    const options = [];
    for (const o of rawOptions) {
      if (typeof o === 'string') {
        options.push({ label: o, description: '' });
      } else if (o && typeof o === 'object') {
        const label = o.label ?? o.name ?? o.value ?? o.title;
        if (label != null) {
          options.push({ label: String(label), description: String(o.description ?? '') });
        }
      }
    }
    if (options.length === 0 && !named) return null;
    questions.push({
      text,
      header: typeof q.header === 'string' ? q.header : '',
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  return questions.length > 0 ? questions : null;
}

/**
 * Read the active viewport of a (headless) xterm buffer as plain text lines.
 */
export function readScreenLines(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < term.rows; i += 1) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines;
}

// Question-like context required around selection markers so idle TUI chrome
// (spinners, footers, command palettes) doesn't trip the detector.
const TUI_QUESTION_RE = /\?|？|\ballow\b|\bapprove\b|\bproceed\b|\bconfirm\b|\bpermission\b|选择|确认|允许|是否|批准|继续/i;

/**
 * Detect a TUI confirmation / selection prompt from the terminal's current
 * screen lines. Deliberately conservative — the result gates a user-facing
 * "waiting for input" banner:
 *  - yesno: an explicit y/n / Yes-No / 是-否 token near the tail
 *  - select: ≥2 numbered option lines (Ink pickers render "❯ 1. Yes") or a
 *    cursor marker, plus question-like context
 *  - continue: "Press Enter to continue"-style gates
 * Returns { kind, lines } with the trailing screen lines as a snapshot for
 * display, or null when nothing prompt-like is on screen.
 */
export function detectTuiPrompt(allLines) {
  const tail = (allLines || [])
    .map((l) => String(l).replace(/\s+$/g, ''))
    .filter((l) => l.trim());
  if (tail.length === 0) return null;
  const context = tail.slice(-10);
  const joined = context.join('\n');
  const snapshot = context.slice(-6);
  if (/(?:\(|\[)?y\/n(?:\)|\])?|是\/否|Yes\s*\/\s*No/i.test(joined)) {
    return { kind: 'yesno', lines: snapshot };
  }
  const numbered = context.filter((l) => /^[❯›>*·\s]*\d{1,2}[.、)）]\s*\S/.test(l));
  if (numbered.length >= 2 && TUI_QUESTION_RE.test(joined)) {
    return { kind: 'select', lines: snapshot };
  }
  // "Press Enter"-style gates also require question-like context so idle TUI
  // footers ("Press Enter to submit") don't trip the detector.
  if (/(?:press|hit)\s+enter|enter\s+to|按回车|回车继续|回车确认/i.test(joined) && TUI_QUESTION_RE.test(joined)) {
    return { kind: 'continue', lines: snapshot };
  }
  if (/❯|›/.test(joined) && TUI_QUESTION_RE.test(joined)) {
    return { kind: 'select', lines: snapshot };
  }
  return null;
}
