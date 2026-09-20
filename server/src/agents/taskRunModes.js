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
 *   droid          droid exec --auto high "<prompt>"       exec 默认 Auto (Off) 全部要审批，
 *                  --auto high 完全自治（否则无人值守挂死）；BYOK 的 --model 必须由
 *                  createAgentSession 插到 exec 之后（顶层 --model 会劫持解析进 TUI）
 *   cline          cline "<prompt>"（位置参数；注意剔除基础参数 -i，否则进 TUI）
 *                  --yolo 跳过审批且跑完即退
 *   hermes         hermes -z "<prompt>"                    顶层 oneshot 模式（审批自动绕过，
 *                  须剔除基础参数的 chat 子命令，否则 -z 不被识别）
 *   kimi-code      kimi -p "<prompt>"                      headless 即 auto 权限
 *                  （--yolo 禁止与 --prompt 组合）
 *   glm-agent      zai -p "<prompt>"                       headless 模式，工具默认自动批准
 *   pi             pi -p "<prompt>"                        官方非交互模式（process and exit），
 *                  工具直接执行无确认门
 *   github-copilot copilot -p "<prompt>" --allow-all-tools  非交互必须 --allow-all-tools
 *                  （+paths/urls 关闭全部确认门，等价官方 --yolo）
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
        // droid exec 默认 Auto (Off)——所有动作都要审批，无人应答直接挂死到超时。
        // 二进制内官方指引：exec 模式用 --auto low|medium|high 提升自治等级；
        // high = 完全自治不询问（与 --skip-permissions-unsafe 互斥）。
        // --auto 置于 prompt 之前（droid 0.221 实测位置参数后仍可解析，但顺序
        // 与官方文档一致更稳）；prompt 固定为最后一个元素——createAgentSession
        // 依赖该约定把 BYOK 的 --model 插到它前面。
        args: (prompt) => ['exec', '--auto', 'high', prompt],
        // 交互式（人工复核模式）同样默认 Auto (Off)，TUI 内每个动作都弹审批。
        // --auto 是全局 flag（官方 CLI Reference「Global CLI Flags」表），
        // 顶层 `droid --auto high` 拉起 TUI 即 High 自治，无需手动切档。
        autoApproveArgs: [],
        interactiveAutoApproveArgs: ['--auto', 'high'],
    },
    'cline': {
        args: (prompt) => [prompt],
        autoApproveArgs: ['--yolo'],
        removeBaseArgs: ['-i'], // 目录默认 args 带 -i（强制 TUI），一次性模式必须剔除
    },
    'hermes': {
        // hermes -z "<prompt>" 为顶层 oneshot 模式（内部自动设 HERMES_YOLO_MODE=1，
        // 所有审批自动绕过，无需 --yolo）。必须剔除基础参数的 `chat` 子命令：
        // chat 有独立子解析器，其后的 -z（顶层专属 flag）不被识别，
        // argparse 报 "unrecognized arguments: -z ..."。
        args: (prompt) => ['-z', prompt],
        autoApproveArgs: [],
        removeBaseArgs: ['chat'],
    },
    'kimi-code': {
        // kimi -p 即 headless 一次性模式，且新建会话固定 permission: "auto"
        //（完全自治，不问问题）；--yolo/--auto 均禁止与 --prompt 组合
        //（CLI 报 "Cannot combine --prompt with --yolo."，exit 1）。
        args: (prompt) => ['-p', prompt],
        autoApproveArgs: [],
    },
    'glm-agent': {
        args: (prompt) => ['-p', prompt],
        autoApproveArgs: [], // zai headless 下工具默认自动批准
    },
    'pi': {
        // pi -p "<prompt>" 官方非交互模式（process and exit，prompt 为位置参数）；
        // 工具（bash/edit/write）直接执行，无交互确认门，无需额外审批 flag。
        args: (prompt) => ['-p', prompt],
        autoApproveArgs: [],
    },
    'github-copilot': {
        // copilot -p 非交互模式必须 --allow-all-tools（帮助原文 "required for
        // non-interactive mode"），否则工具审批无人应答挂死到超时；补 paths/urls
        // 关闭其余确认门（三者组合即官方 --yolo 语义）。
        args: (prompt) => ['-p', prompt],
        autoApproveArgs: ['--allow-all-tools', '--allow-all-paths', '--allow-all-urls'],
        // 交互式（复核/等待人工场景）同样需要三件套，否则逐个审批无人应答
        interactiveAutoApproveArgs: ['--allow-all-tools', '--allow-all-paths', '--allow-all-urls'],
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
 * 交互式会话的自动批准追加参数（LoopTask 人工复核模式拉起用：无一次性
 * prompt，但仍需工具审批自动放行，否则交互 TUI 停在审批处等输入）。
 * @returns {string[]}
 */
function getAutoApproveArgs(agentId) {
    const mode = TASK_RUN_MODES[agentId];
    if (!mode) return [];
    // 交互式批准参数可与一次性模式不同（如 copilot 的三件套），显式配置优先
    if (Array.isArray(mode.interactiveAutoApproveArgs)) {
        return [...mode.interactiveAutoApproveArgs];
    }
    return Array.isArray(mode.autoApproveArgs) ? [...mode.autoApproveArgs] : [];
}

/**
 * 一次性模式下需从 Agent 基础参数中剔除的项（如 cline 的 -i）。
 * @returns {string[]}
 */
function getTaskRunRemoveArgs(agentId) {
    const mode = TASK_RUN_MODES[agentId];
    return Array.isArray(mode?.removeBaseArgs) ? mode.removeBaseArgs : [];
}

module.exports = { isTaskRunSupported, getTaskRunArgs, getTaskRunRemoveArgs, getAutoApproveArgs };
