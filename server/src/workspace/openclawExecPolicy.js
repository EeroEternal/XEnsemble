/**
 * openclaw LoopTask 审批策略预写（会话隔离）。
 *
 * openclaw 的 exec approvals 体系（五档 mode：deny/allowlist/ask/auto/full）
 * 读两层配置：config 层（tools.exec，读 ${STATE_DIR}/openclaw.json）+ host
 * 层（approvals defaults，含 askFallback——无 UI 时审批请求的兜底动作，
 * 默认 deny）。CLI 层无审批 flag，必须 spawn 前预写。
 *
 * 历史：approvals 曾是 ${STATE_DIR}/openclaw.json5 的 exec-approvals 键，
 * 后迁 SQLite（openclaw doctor 会把 legacy 文件当冲突拦截，阻止 approvals
 * 生效）——不能写 legacy JSON，只写 config 层 tools.exec 并显式带 askFallback
 *（config 层同样被 approvals 读取为 defaults，安全）。
 *
 * 象限映射（taskAutoApprove）：
 *   自动批准 → mode "full" + askFallback "full"（YOLO，无门直跑）
 *   手动批准 → mode "ask" + allowlist 常见安全命令 + on-miss "ask"
 *             （未命中白名单逐个弹审批，TUI 内人工放行）
 *
 * 文件落会话隔离 ${STATE_DIR}/openclaw.json（OPENCLAW_STATE_DIR 已按会话
 * 指向），普通交互会话不调用本模块，与既有会话/工作区零交集。
 */

const ALLOWLIST = ['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'pwd', 'which', 'wc', 'echo', 'git status', 'git diff', 'git log', 'git show'];

/** 按审批模式解析 tools.exec 策略段 */
function execPolicyFor(taskAutoApprove) {
    if (taskAutoApprove) {
        return {
            mode: 'full',
            askFallback: 'full',
        };
    }
    return {
        mode: 'ask',
        allowlist: ALLOWLIST,
        onMiss: 'ask',
        askFallback: 'deny',
    };
}

/**
 * 把审批策略写进会话隔离的 ${STATE_DIR}/openclaw.json。
 *
 * @param {object} opts
 * @param {object} opts.runtime 执行面 runtime（runtime.fs 为 FS 适配器）
 * @param {string} [opts.runtimeRef] VM runtime 引用
 * @param {string} opts.workspaceRoot VM 内工作区根路径
 * @param {string} opts.stateDirPath 会话隔离 state dir（VM 内绝对路径）
 * @param {boolean} opts.taskAutoApprove 任务审批模式（true=自动批准）
 * @param {object} [opts.log]
 * @returns {Promise<boolean>} 是否有写入动作
 */
async function writeOpenclawExecPolicy({ runtime, runtimeRef, workspaceRoot, stateDirPath, taskAutoApprove, log }) {
    if (!stateDirPath || !runtime?.fs?.fsWrite) return false;
    const configPath = `${stateDirPath}/openclaw.json`;
    // 用户 configSchema 同路径 configFiles（defaultAgents.js openclaw 条目）
    // 先于此处写入；读取合并保证用户自定义（providers/models 等）不丢。
    // 用户若在 UI 里改过 tools.exec 段则尊重用户配置，跳过预写。
    let config = {};
    if (typeof runtime.fs.fsRead === 'function') {
        try {
            const raw = await runtime.fs.fsRead(workspaceRoot, configPath, { runtimeRef });
            config = JSON.parse(String(raw ?? '').trim() || '{}');
            if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
        } catch {
            config = {};
        }
    }
    if (config.tools?.exec?.mode) return false;

    config.tools = config.tools && typeof config.tools === 'object' ? config.tools : {};
    config.tools.exec = { ...(execPolicyFor(taskAutoApprove)), ...(config.tools.exec && typeof config.tools.exec === 'object' ? config.tools.exec : {}) };
    const content = JSON.stringify(config, null, 2);
    await runtime.fs.fsWrite(workspaceRoot, configPath, content, { runtimeRef });
    log?.info?.({ configPath, mode: config.tools.exec.mode }, '[openclaw-bootstrap] exec policy pre-seeded');
    return true;
}

module.exports = { execPolicyFor, writeOpenclawExecPolicy, OPENCLAW_ALLOWLIST: ALLOWLIST };
