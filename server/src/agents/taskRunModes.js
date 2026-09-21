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
        // 交互式 TUI 默认逐个审批；--auto 开启自动批准（headless run 本就自动跑工具）
        interactiveAutoApproveArgs: ['--auto'],
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
        // 交互式人工审批模式必须显式空数组短路：回退 autoApproveArgs 会注入
        // --yolo，--yolo 与交互 TUI 不兼容（TUI 立即退出，run 被误判 failed）
        interactiveAutoApproveArgs: [],
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
        // 交互式 TUI 用 --yolo 开启自动批准（无 prompt 组合限制）。
        args: (prompt) => ['-p', prompt],
        autoApproveArgs: [],
        interactiveAutoApproveArgs: ['--yolo'],
    },
    'glm-agent': {
        args: (prompt) => ['-p', prompt],
        autoApproveArgs: [], // zai headless 下工具默认自动批准
        // 交互式 TUI 无免审 flag：自动批准由 loopTasks/runner 在 TUI 就绪后
        // PTY 注入 shift-tab（\x1b[Z，官方切换 auto-accept 的快捷键）实现。
        // 手动批准无需任何处理（TUI 默认逐个审批）。
        interactiveAutoApproveArgs: [],
    },
    'pi': {
        // pi -p "<prompt>" 官方非交互模式（process and exit，prompt 为位置参数）；
        // 工具（bash/edit/write）直接执行，无交互确认门，无需额外审批 flag。
        args: (prompt) => ['-p', prompt],
        autoApproveArgs: [],
        // 反向逻辑：pi 手动审批不能靠「不加 flag」（默认就是无审批直接执行），
        // 只能靠追加 -e <extension> 加载审批 gate（pi.on("tool_call") 拦截 +
        // ctx.ui.select 逐个放行）。getManualApprovalArgs 据 manualApprovalArg
        // 处理：自动批准 → 不带任何参数（原生无门即全放行）；手动批准 →
        // 追加 -e 加载 gate。
        interactiveAutoApproveArgs: [],
        manualApprovalArg: true,
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
        // 权限不走 CLI flag：exec approvals（五档 deny/allowlist/ask/auto/full）
        // 由 createAgentSession 按任务审批模式写会话隔离的 ${STATE_DIR}/openclaw.json
        //（execPolicyFor / writeOpenclawExecPolicy）：
        //   自动批准 → mode full + host 层 askFallback full（YOLO）
        //   手动批准 → mode ask + allowlist + on-miss ask（未命中白名单逐个问人）
        autoApproveArgs: [],
    },
};

/**
 * pi / openclaw 均具备完整的手动审批机制（4 象限全支持）：
 *   pi        手动审批 = 追加 -e <审批 extension>（反向逻辑，见 pi 条目 +
 *             getManualApprovalArgs）；自动批准 = 原生无审批门直接执行
 *   openclaw  手动审批 = exec approvals ask 档（${STATE_DIR}/openclaw.json 预写，
 *             会话隔离）；自动批准 = full 档 YOLO
 * 自动/手动批准均可落实，无需服务端强制 autoApprove=true。
 * 人工复核（requireReview，事后审阅结果）是 xensemble 自身机制，与 Agent 无关。
 */

/**
 * 循环任务禁用清单：交互模式注入/引导适配投入产出比过高的 Agent
 * （claude-code 欢迎屏卡注入、copilot 信任弹窗吞注入、droid --auto 拆参、
 * hermes chat 子命令特例），以及产品裁决不开放的 opencode / openclaw，
 * 不再开放新建循环任务。存量任务不受影响
 * （TASK_RUN_MODES 保留完整模式矩阵，旧任务按原配置继续执行）。
 */
const LOOP_TASK_DISABLED_AGENTS = new Set(['claude-code', 'droid', 'github-copilot', 'hermes', 'opencode', 'openclaw']);

/** Agent 是否允许创建/编辑循环任务（存量任务执行不走此门） */
function isLoopTaskAllowed(agentId) {
    return isTaskRunSupported(agentId) && !LOOP_TASK_DISABLED_AGENTS.has(agentId);
}

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

/**
 * 反向逻辑 Agent（manualApprovalArg: true，当前仅 pi）：默认无审批门，
 * 「手动批准」需要额外追加参数加载审批 gate（-e <extension> 路径）；
 * 「自动批准」反而无需任何参数。
 * @param {string} agentId
 * @param {string|null} gatePath 审批 extension 文件路径（VM 内绝对路径）
 * @returns {string[]}
 */
function getManualApprovalArgs(agentId, gatePath) {
    const mode = TASK_RUN_MODES[agentId];
    if (!mode?.manualApprovalArg || !gatePath) return [];
    return ['-e', String(gatePath)];
}

module.exports = { isTaskRunSupported, isLoopTaskAllowed, getTaskRunArgs, getTaskRunRemoveArgs, getAutoApproveArgs, getManualApprovalArgs };
