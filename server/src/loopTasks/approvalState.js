/**
 * cline TUI auto-approve 状态解析（loopTasks/runner verifyClineApprovalState 用）。
 *
 * 事故复盘（2026-09，cline@3.0.55 二进制核实）：cline 首启弹 "Try ClinePass"
 * 促销 modal，激活期间吞掉全部非修饰键（enter=开浏览器、其余键一律 dismiss）
 * ——Shift+Tab 首按只把弹窗关掉、auto-approve 纹丝不动，重绘帧仍含 enabled 串，
 * 旧「单串 includes」判定会误读中间态而 fail-closed 误杀 run。根治是 spawn env
 * 注入官方开关 CLINE_DISABLE_CLINE_PASS_NOTICE=1（agents/agentTuiEnv）；此处
 * 解析器是闭环校验的兜底判定：
 *   扫描窗口内可能同时出现「Esc dismiss 弹窗后的主屏重绘（enabled）」与
 *   「Shift+Tab toggle 后的重绘（disabled）」——两串各自取最后出现位置，较新者
 *   胜（TUI 重绘按时间序落转录，最后渲染即当前态）；都不在窗口内返回 null
 *  （状态未知，调用方应重试而非盲切收口）。
 */

const ENABLED_MARK = 'auto-approve all enabled';
const DISABLED_MARK = 'auto-approve all disabled';

/**
 * @param {string} stripped 已 stripAnsi + toLowerCase 的转录文本
 * @returns {boolean|null} true=enabled / false=disabled / null=未知
 */
function parseApprovalState(stripped) {
    const e = stripped.lastIndexOf(ENABLED_MARK);
    const d = stripped.lastIndexOf(DISABLED_MARK);
    if (e < 0 && d < 0) return null;
    if (d < 0) return true;
    if (e < 0) return false;
    return e > d;
}

module.exports = { parseApprovalState, ENABLED_MARK, DISABLED_MARK };
