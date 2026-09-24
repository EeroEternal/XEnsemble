/**
 * Terminal prompt heuristics shared by web (xterm screen scan) and server
 * (attention service over transcript tails).
 *
 * Two complementary sources tell the UI that the agent is waiting for the
 * user, both agent-agnostic:
 *
 * 1. parseQuestionTool — structured question tools (Claude Code
 *    AskUserQuestion, Cline ask_followup_question, generic {question,
 *    options} shapes) recorded by the LLM proxy as tool_call entries.
 *
 * 2. detectTuiPrompt — everything else (permission pickers, plan approval,
 *    y/n questions) never flows through the LLM proxy; it exists only on the
 *    terminal screen. The web feeds the live PTY stream into a headless xterm
 *    buffer; the server strips ANSI from transcript tails. Both funnel the
 *    resulting text lines into detectTuiPrompt.
 *
 * Deliberately conservative — results gate user-facing notifications.
 */

// Standard ANSI/OSC escape sequence pattern (colors, cursor moves, window
// title set, synchronized-update brackets) so raw transcript bytes can be
// scanned as plain text.
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d ]*(?:;[-a-zA-Z\d/#&.:=?%@~_ ]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '');
}

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

// Question-like context required around selection markers so idle TUI chrome
// (spinners, footers, command palettes) doesn't trip the detector.
const TUI_QUESTION_RE = /\?|？|\ballow\b|\bapprove\b|\bproceed\b|\bconfirm\b|\bpermission\b|选择|确认|允许|是否|批准|继续/i;

// Persistent status-bar / footer chrome on Cline / Claude Code style TUIs —
// never a question. The bare "?" in "? for shortcuts" used to satisfy the
// question-context check on idle completion screens (false "waiting" pings
// every time a task finished), so these lines are dropped before scanning.
const TUI_CHROME_RE =
  /\?\s*for\s+(?:shortcuts|context|commands|help|keys)|esc\s+to\s+\w+|ctrl\+[a-z]|auto-accept|bypass\s+permissions|plan\s+mode\b|(?:total\s+)?(?:cost|duration)\s*[·:]|\d[\d,.]*\s+tokens?\b/i;

// Leading TUI decoration (indentation, box-drawing borders, bullets) that wraps
// a prompt block without carrying meaning. Real TUIs render pickers as
// "│   ❯ 1. Yes" / "* Choose an option:" / "   Trust this folder?", so the
// column-0 anchors below would otherwise miss every real prompt.
// NOTE: ❯/› are deliberately NOT stripped — they are the option cursor and
// carry meaning, so they must survive normalization for the checks below.
const TUI_LEADING_DECOR_RE =
  /^[\s\u3000│┃┆┊|┌┐└┘├┤┬┴┼─━═╔╗╚╝║╠╣╦╩╬>*·●○◆▪▫•‣∙]+/;

// A line that itself asks something: ends with "?" (or fullwidth ？) or starts
// with an explicit question verb. Loose keyword hits anywhere in the scrollback
// ("继续" inside a completion summary) no longer count as question context.
// Anchored at column 0 after decoration is stripped (see normalizeTuiLine).
// "allow" anchors the Copilot CLI style question whose "?" is NOT at end of
// line — it appends the command after the question: "? Allow command: npm test".
const QUESTION_LINE_RE =
  /(?:\?|？)\s*$|^(?:choose|select|pick|approve|proceed|confirm|permission|allow|是否|允许|确认|批准|选择|请选)/i;

// Option-text semantics for pickers that carry NO question sentence at all:
// GitHub Copilot CLI's tool-permission dialog renders tool name + command +
// numbered Yes/No options inside a box — the option list itself carries the
// interrogative semantics. Deliberately tight (gates user notifications):
// the FIRST option must be yes-like and a LATER one no-like — completion
// summaries ("1. Fixed the login loop") never open their list with Yes/Allow.
const YES_OPTION_RE = /^(?:yes\b|allow\b|approve\b|是|允许|批准)/i;
const NO_OPTION_RE = /^(?:no\b|never\b|deny\b|skip\b|cancel\b|否|拒绝|取消)/i;

/** "❯ 1. Yes, allow once" → "Yes, allow once" (strip cursor + number prefix). */
function numberedOptionText(line) {
  return String(line).replace(/^[❯›>*·\s]*\d{1,2}[.、)）]\s*/, '');
}

/** Strip trailing blanks + leading decoration; used before the anchored checks. */
function normalizeTuiLine(line) {
  return String(line).replace(/[\s\u3000]+$/g, '').replace(TUI_LEADING_DECOR_RE, '');
}

/**
 * Detect a TUI confirmation / selection prompt from screen text lines.
 * Returns { kind: 'yesno'|'select'|'continue', lines } with the trailing
 * lines as a snapshot, or null when nothing prompt-like is on screen.
 */
export function detectTuiPrompt(allLines) {
  const tail = (allLines || [])
    .map(normalizeTuiLine)
    .filter((l) => l.trim())
    .filter((l) => !TUI_CHROME_RE.test(l));
  if (tail.length === 0) return null;
  const context = tail.slice(-10);
  const joined = context.join('\n');
  const snapshot = context.slice(-6);
  if (/(?:\(|\[)?y\/n(?:\)|\])?|是\/否|Yes\s*\/\s*No/i.test(joined)) {
    return { kind: 'yesno', lines: snapshot };
  }
  const questionLine = context.some((l) => QUESTION_LINE_RE.test(l));
  const numbered = context.filter((l) => /^[❯›>*·\s]*\d{1,2}[.、)）]\s*\S/.test(l));
  if (numbered.length >= 2 && questionLine) {
    return { kind: 'select', lines: snapshot };
  }
  // Question-free numbered picker (GitHub Copilot CLI permission dialog):
  // tool name + command + numbered Yes/No options, no question sentence —
  // the option list itself says "choose". First option yes-like, a later one
  // no-like (see YES_OPTION_RE/NO_OPTION_RE for the false-positive bar).
  if (numbered.length >= 2
    && YES_OPTION_RE.test(numberedOptionText(numbered[0]))
    && numbered.slice(1).some((l) => NO_OPTION_RE.test(numberedOptionText(l)))) {
    return { kind: 'select', lines: snapshot };
  }
  // "Press Enter"-style gates also require question-like context so idle TUI
  // footers ("Press Enter to submit") don't trip the detector.
  if (/(?:press|hit)\s+enter|enter\s+to|按回车|回车继续|回车确认/i.test(joined) && TUI_QUESTION_RE.test(joined)) {
    return { kind: 'continue', lines: snapshot };
  }
  // ❯/› must carry option text ("❯ 1. Yes") — a bare "❯" is the idle input
  // cursor every Cline/Claude Code screen shows, not a picker.
  const optionCursor = context.some((l) => /^[❯›]\s*\S/.test(l));
  if (optionCursor && questionLine) {
    return { kind: 'select', lines: snapshot };
  }
  return null;
}
