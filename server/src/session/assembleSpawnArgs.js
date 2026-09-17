/**
 * 组装 agent spawn 参数（含 droid 一次性模式的参数顺序特例）。
 *
 * droid 一次性模式：BYOK / Gateway 注入的 `--model`（spawnArgs.append）必须落在
 * `exec` 子命令之后、prompt 之前 —— 置于 exec 之前会被 droid 顶层解析劫持、跳过
 * exec 分发，进程落入交互 TUI（无人值守任务挂死到超时；droid 0.221 实测复现）。
 *
 * ⚠️ 空数组是 truthy：交互式会话传进来的 `taskArgs` 是 `[]`（调用方写的是
 * `taskRunArgs || []`）。若判真值写成 `if (taskArgs && ...)`，交互式会话也会走进
 * 下面的 droid 特例分支，`taskArgs[-1]` 取到 `undefined` 被追加到参数末尾；数组
 * 里的 `undefined` 经 `JSON.stringify` 会变成 `null`，boxlite 按 `Vec<String>`
 * 反序列化时直接拒掉整次 spawn：
 *   422 Failed to deserialize the JSON body into the target type:
 *       args[2]: invalid type: null, expected a string
 * 触发条件是「交互式 droid 会话 + 配了模型」（append = ['--model', …] 非空，
 * 于是 null 正好落在 index 2）：一次性任务路径正常，未配模型的 droid 也正常，
 * 所以只在人手动新建 droid 会话时暴露。必须判 `length`，不能判真值。
 */
function assembleSpawnArgs({
    agentId,
    prepend = [],
    stateArgs = [],
    baseArgs = [],
    append = [],
    taskArgs = [],
} = {}) {
    const extra = Array.isArray(taskArgs) ? taskArgs : [];
    if (agentId === 'droid' && append.length > 0 && extra.length > 0) {
        return [...prepend, ...stateArgs, ...baseArgs, ...extra.slice(0, -1), ...append, extra[extra.length - 1]];
    }
    return [...prepend, ...stateArgs, ...baseArgs, ...append, ...extra];
}

module.exports = { assembleSpawnArgs };
