/**
 * Agent 无人值守一次性执行模式（LoopTask 专用）。
 *
 * 交互式 CLI Agent 跑完任务后不会退出进程（等待下一条输入），无法用进程退出
 * 语义判定任务完成。无人值守执行必须走各 CLI 的 headless 一次性模式：
 * Agent 执行完任务即退出进程，exitCode 0 = 成功、非 0 = 失败，语义干净。
 *
 * 支持矩阵（逐一核对各 CLI 官方文档，2026-09）：
 *   claude-code    claude -p "<prompt>"                    headless docs
 *   codebuddy      codebuddy -p "<prompt>"                 headless docs（Claude 系；
 *                  非交互下需 --dangerously-skip-permissions 才能执行工具）
 *   qwen-code      qwen -p "<prompt>"                      gemini-cli 系
 *   opencode       opencode run "<prompt>"                 非交互执行，默认自动跑工具
 *   cursor         cursor-agent -p "<prompt>"              print 模式
 *   droid          droid exec "<prompt>"                   exec 默认 auto
 *   cline          cline "<prompt>"（位置参数；注意剔除基础参数 -i，否则进 TUI）
 *                  --yolo 跳过审批且跑完即退
 *   hermes         hermes -z "<prompt>"                    纯脚本模式；--yolo 跳过危险命令确认
 *   kimi-code      kimi -p "<prompt>"                      --yolo 自动批准
 *   glm-agent      zai -p "<prompt>"                       headless 模式，工具默认自动批准
 *   github-copilot copilot -p "<prompt>"                   one-shot 模式（审批为
 *                  --allow-tool 粒度，无全局跳过 flag——写操作类任务可能受限）
 *   openclaw       openclaw agent --local --agent main --message "<prompt>"
 *                  单次 Agent turn，--local 走本地嵌入式运行时（跳过 Gateway
 *                  daemon）；agent 子命令必须带会话选择器（--agent/--session-key/
 *                  --session-id/--to），否则 CLI 报错退出
 *
 * 注：以上均经各 CLI 官方文档核对（2026-09）。
 */

const TASK_RUN_MODES = {
    'claude-code': {
        args: (prompt) => ['-p', prompt],
        autoApproveArgs: ['--dangerously-skip-permissions'],
    },
    'codebuddy': {
        args: (prompt) => ['-p', prompt],
        autoApproveArgs: ['--dangerously-skip-permissions'],
    },
    'qwen-code': {
        args: (prompt) => ['-p', prompt],
        autoApproveArgs: ['--yolo'],
    },
    'opencode': {
        args: (prompt) => ['run', prompt],
        autoApproveArgs: [],
    },
    'cursor': {
        args: (prompt) => ['-p', prompt],
        autoApproveArgs: [],
    },
    'droid': {
        args: (prompt) => ['exec', prompt],
        autoApproveArgs: [],
    },
    'cline': {
        args: (prompt) => [prompt],
        autoApproveArgs: ['--yolo'],
        removeBaseArgs: ['-i'], // 目录默认 args 带 -i（强制 TUI），一次性模式必须剔除
    },
    'hermes': {
        args: (prompt) => ['-z', prompt],
        autoApproveArgs: ['--yolo'],
    },
    'kimi-code': {
        args: (prompt) => ['-p', prompt],
        autoApproveArgs: ['--yolo'],
    },
    'glm-agent': {
        args: (prompt) => ['-p', prompt],
        autoApproveArgs: [], // zai headless 下工具默认自动批准
    },
    'github-copilot': {
        args: (prompt) => ['-p', prompt],
        autoApproveArgs: [], // 审批为 --allow-tool 粒度，无全局 flag
    },
    'openclaw': {
        // --local 强制本地嵌入式运行时（跳过 Gateway daemon），适配沙箱一次性执行。
        // openclaw agent 必须指定会话选择器（--to/--session-key/--session-id/--agent），
        // 否则 CLI 直接报 "Pass --to ... to choose a session" 退出（exit 1）。
        // 无 agents.list 配置时默认 agent id 为 main，故用 --agent main 走默认 agent。
        args: (prompt) => ['agent', '--local', '--agent', 'main', '--message', prompt],
        autoApproveArgs: [], // 权限走 OpenClaw 自身沙箱/白名单配置
    },
};

/** Agent 是否支持无人值守一次性执行 */
function isTaskRunSupported(agentId) {
    return Boolean(TASK_RUN_MODES[agentId]);
}

/**
 * 构造一次性执行的追加参数。
 * @returns {string[]|null} 不支持的 Agent 返回 null
 */
function getTaskRunArgs(agentId, prompt, { autoApprove = false } = {}) {
    const mode = TASK_RUN_MODES[agentId];
    if (!mode) return null;
    const args = mode.args(String(prompt || ''));
    if (autoApprove && Array.isArray(mode.autoApproveArgs)) {
        return [...args, ...mode.autoApproveArgs];
    }
    return args;
}

/**
 * 一次性模式下需从 Agent 基础参数中剔除的项（如 cline 的 -i）。
 * @returns {string[]}
 */
function getTaskRunRemoveArgs(agentId) {
    const mode = TASK_RUN_MODES[agentId];
    return Array.isArray(mode?.removeBaseArgs) ? mode.removeBaseArgs : [];
}

module.exports = { isTaskRunSupported, getTaskRunArgs, getTaskRunRemoveArgs };
