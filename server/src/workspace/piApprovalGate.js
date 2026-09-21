/**
 * pi LoopTask 手动审批 gate。
 *
 * pi 原生无审批门（ Philosophy "No permission popups"，bash/edit/write 直接
 * 执行），「手动批准」无法靠不加 flag 实现——必须通过官方 extension 机制
 * （`-e <file>` 加载，project trust 决策前加载、不触发信任弹窗）挂审批门：
 * `pi.on("tool_call")` 拦截改动型工具调用，`ctx.ui.select` 弹框逐个放行。
 *
 * 骨架来自官方 examples/extensions/permission-gate.ts，改为全量拦截
 * （不限危险模式）。自动批准模式不加载本文件（原生无门即全放行，
 * 见 taskRunModes.js pi 条目的反向逻辑）。
 *
 * 文件落会话隔离 state dir（pi 的 --session-dir 已指向同目录），不污染
 * 全局/其他会话；普通交互会话不调用本模块。
 */

const GATE_FILENAME = 'xensemble-approval-gate.ts';

// 注意：本字符串会原样写入 VM 内的 .ts 文件——模板串里 \n 需写成 \\n
const GATE_SOURCE = `/**
 * xensemble LoopTask approval gate (loaded via "pi -e <this file>").
 * Intercepts all mutating tool calls (bash/edit/write) and asks the user
 * to allow or deny each one. Read-only tools pass through untouched.
 * Auto-approve loop tasks do NOT load this extension (pi is gateless by
 * default and runs tools directly).
 */
const GUARDED_TOOLS = new Set(["bash", "edit", "write"]);

export default function (pi) {
    pi.on("tool_call", async (event, ctx) => {
        if (!GUARDED_TOOLS.has(event.toolName)) return undefined;
        if (!ctx.hasUI) {
            return { block: true, reason: "Manual approval mode: no UI available to approve tool calls" };
        }
        const detail = typeof event.input === "string"
            ? event.input
            : JSON.stringify(event.input);
        const title = "xensemble approval required - " + event.toolName + "\\n\\n" + String(detail ?? "").slice(0, 400);
        const choice = await ctx.ui.select(title, ["Yes", "No"]);
        if (choice !== "Yes") {
            return { block: true, reason: "Denied by user in approval dialog" };
        }
        return undefined;
    });
}
`;

/**
 * 把审批 gate extension 写入会话隔离 state dir。
 *
 * @param {object} opts
 * @param {object} opts.runtime 执行面 runtime（runtime.fs 为 FS 适配器）
 * @param {string} [opts.runtimeRef] VM runtime 引用
 * @param {string} opts.workspaceRoot VM 内工作区根路径
 * @param {string} opts.stateDirPath 会话隔离 state dir（VM 内绝对路径）
 * @param {object} [opts.log]
 * @returns {Promise<string|null>} gate 文件 VM 内绝对路径（失败返回 null）
 */
async function writePiApprovalGate({ runtime, runtimeRef, workspaceRoot, stateDirPath, log }) {
    if (!stateDirPath || !runtime?.fs?.fsWrite) return null;
    const gatePath = `${stateDirPath}/${GATE_FILENAME}`;
    await runtime.fs.fsWrite(workspaceRoot, gatePath, GATE_SOURCE, { runtimeRef });
    log?.info?.({ gatePath }, '[pi-bootstrap] approval gate extension written');
    return gatePath;
}

module.exports = { writePiApprovalGate, GATE_FILENAME };
