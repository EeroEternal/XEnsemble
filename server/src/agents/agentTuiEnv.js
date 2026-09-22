/**
 * Agent TUI 稳定性 env（spawn 前按 agentId 注入；新建会话与 L2 resume 共用，
 * 用户在会话配置里显式设置的同名变量后写入、可覆盖）。
 */

function applyAgentTuiEnv(env, agentId) {
    if (!env || typeof env !== 'object') return env;
    if (agentId === 'cline') {
        // 事故复盘（2026-09，cline@3.0.55 二进制核实）：cline TUI 首启弹
        // "Try ClinePass" 促销 modal（shown 标记写 ${CLINE_DATA_DIR}/settings/
        // cli-notices.json，每会话新状态目录必然再弹）。modal 激活期间吞掉全部
        // 非修饰键（enter=开浏览器、其余键一律 dismiss），LoopTask 审批态闭环
        // 校验（loopTasks/runner verifyClineApprovalState）注入的 Shift+Tab
        // 首按只会把弹窗关掉、auto-approve 纹丝不动，fail-closed 误杀 run
        //（"approval-state verification failed"）。官方开关置 1 完全禁弹；
        // 人类会话同样受益（少一个无人值守时更碍事的广告屏）。
        env.CLINE_DISABLE_CLINE_PASS_NOTICE = '1';
    }
    return env;
}

module.exports = { applyAgentTuiEnv };
