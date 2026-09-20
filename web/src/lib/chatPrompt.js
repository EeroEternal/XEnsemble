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

// parseQuestionTool / detectTuiPrompt 已收敛到 shared/terminalPromptHeuristics.mjs，
// web（xterm 屏幕扫描）与 server（attentionService transcript 尾部扫描）共用同一套规则。
export { parseQuestionTool, detectTuiPrompt } from '../../../shared/terminalPromptHeuristics.mjs';

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

