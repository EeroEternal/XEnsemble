/**
 * BoxLite 沙箱内 exec 身份适配工具。
 *
 * 沙箱的 workspace 是 virtiofs idmap 挂载（host 0 ↔ guest 1000），idmap 不提供
 * DAC override——任一身份只能写自己拥有的文件。若 node_modules 与源码分属
 * 不同身份（root 写源码、1000 写 node_modules；或反之），vite/npm 这类
 * "读源码 + 写产物" 的工具就因 EACCES 崩。
 *
 * 根治办法：所有 workspace 路径的 exec 统一以 uid 1000（VM 用户身份）跑，
 * 让 .vite/.npm 等产物与源码同属一个身份。系统级操作（apt-get、pkill、
 * /etc/ 写入、postgres service）需显式 uid: 0 跳过本注入，仍以 root 跑。
 *
 * 注入方式：把 setpriv 作为新 command，前置 --reuid/--regid/--clear-groups，
 * 原 command 与 args 整体后移。boxlite spawn 协议（command/args 独立字段）
 * 原生支持，不经 shell 解析，零注入风险。
 */
function applyUidToExec({ command, args }, { uid = 1000, gid } = {}) {
    const baseCmd = String(command || 'sh');
    const baseArgs = Array.isArray(args) ? args : [];
    const targetUid = Number.isInteger(uid) ? uid : 1000;
    const targetGid = Number.isInteger(gid) ? gid : targetUid;
    if (targetUid === 0) {
        return { command: baseCmd, args: baseArgs };
    }
    return {
        command: 'setpriv',
        args: [
            `--reuid=${targetUid}`,
            `--regid=${targetGid}`,
            '--clear-groups',
            baseCmd,
            ...baseArgs,
        ],
    };
}

module.exports = { applyUidToExec };
