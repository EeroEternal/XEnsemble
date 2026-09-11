/**
 * LoopTask TaskAgent —— 控制面 ReAct 任务执行循环。
 *
 * 模式与部署 verify agent（deployments/analyzeVerify.js）同构：
 *   LLM 推理在控制面（平台级 key），工具执行在沙箱内（runtime.exec / runtime.fs），
 *   不创建 Session、不依赖任何 CLI Agent（Architecture.md §5.3 Task Automation）。
 *
 * 工具集（精简自 verify agent）：
 *   run_shell  —— 沙箱内 shell（每条命令全新 shell，cwd 重置为 workspace）
 *   read_file  —— 读 workspace 文件（相对路径）
 *   list_dir   —— 列 workspace 目录
 *   edit_file  —— 写/覆盖 workspace 文件（相对路径，自动建父目录）
 *   final      —— 结束任务（ok + summary）
 *
 * 防失控（沿袭 verify agent 的实战参数）：
 *   - MAX_ROUNDS 轮次上限
 *   - 总超时（deadline 每轮检查）
 *   - 同命令重复拦截（去重签名 + 强纠偏注入）
 *   - LLM 瞬时故障重试（5xx/429/网络，thinking 参数 400 自愈降级）
 */

const LONG_CMD_RE = /\b(npm|pnpm|yarn|bun|pip3?|poetry|uv|composer|bundle|apt-get|apt|apk)\s+[^|;&]*(install|ci\b|add\b|update\b|upgrade\b)|\b(cargo\s+build|go\s+build|go\s+mod|go\s+install|mvn|gradle|make|cmake)\b|\bbuild\b|\btest\b|\bmigrate\b/i;
const SHELL_TIMEOUT_MS = Number(process.env.LOOP_TASK_SHELL_TIMEOUT_MS) || 240_000;
const LONG_SHELL_TIMEOUT_MS = Number(process.env.LOOP_TASK_LONG_SHELL_TIMEOUT_MS) || 600_000;
const MAX_TOOL_OUTPUT = 6000;
const REPEAT_CMD_LIMIT = Number(process.env.LOOP_TASK_REPEAT_CMD_LIMIT) || 4;
const LLM_TIMEOUT_MS = 240_000;
const LLM_RETRIES = 2;

// 不支持 thinking 参数的模型：首次 400 指向 thinking 后本进程内降级（同 analyzeVerify）
const noThinkingModels = new Set();

function chatCompletionsUrl(url) {
    const u = String(url || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions\/?$/i.test(u)) return u;
    return `${u}/chat/completions`;
}

function resolveLlmConfig() {
    const apiKey = process.env.LLM_TASK_API_KEY || process.env.LLM_ANALYZE_API_KEY;
    const apiUrl = chatCompletionsUrl(
        process.env.LLM_TASK_API_URL || process.env.LLM_ANALYZE_API_URL || 'https://api.deepseek.com/chat/completions',
    );
    const model = process.env.LLM_TASK_MODEL || process.env.LLM_ANALYZE_MODEL || 'deepseek-chat';
    return { apiKey, apiUrl, model };
}

// LLM 调用（瞬时故障重试；thinking 参数不支持时自愈降级——对齐 analyzeVerify.callLlm）
async function callLlm({ messages, abortSignal }) {
    const { apiKey, apiUrl, model } = resolveLlmConfig();
    if (!apiKey) {
        return { ok: false, warning: 'LLM_TASK_API_KEY / LLM_ANALYZE_API_KEY is not configured' };
    }
    let lastWarning = '';
    for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
        if (abortSignal) {
            const onAbort = () => controller.abort();
            abortSignal.addEventListener('abort', onAbort, { once: true });
        }
        try {
            const bodyObj = { model, messages, max_tokens: 8000, temperature: 0.2 };
            if (!noThinkingModels.has(model)) bodyObj.thinking = { type: 'disabled' };
            const res = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify(bodyObj),
                signal: controller.signal,
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                lastWarning = `LLM error ${res.status}: ${text.slice(0, 160)}`;
                if (res.status === 400 && /thinking/i.test(text) && !noThinkingModels.has(model)) {
                    noThinkingModels.add(model);
                    clearTimeout(timer);
                    continue;
                }
                if ((res.status >= 500 || res.status === 429) && attempt < LLM_RETRIES) {
                    await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 4000));
                    continue;
                }
                return { ok: false, warning: lastWarning };
            }
            const data = await res.json();
            const content = data.choices?.[0]?.message?.content;
            return { ok: true, content };
        } catch (e) {
            lastWarning = `LLM unavailable: ${e?.message || e}`;
            if (abortSignal?.aborted) return { ok: false, warning: lastWarning, aborted: true };
            if (attempt < LLM_RETRIES) {
                await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 4000));
                continue;
            }
            return { ok: false, warning: lastWarning };
        } finally {
            clearTimeout(timer);
        }
    }
    return { ok: false, warning: lastWarning };
}

// 从 LLM 输出提取 JSON（围栏/前后缀容错——对齐 analyzeVerify 的三层解析第一层）
function extractJson(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidates = [];
    if (fenced) candidates.push(fenced[1]);
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));
    candidates.push(raw);
    for (const c of candidates) {
        try {
            const parsed = JSON.parse(c.trim());
            if (parsed && typeof parsed === 'object') return parsed;
        } catch { /* try next */ }
    }
    return null;
}

// 语义化命令签名（剥掉装饰后取核心）——同命令重复检测用，简化自 analyzeVerify.normalizeCmdSig
function normalizeCmdSig(rawCmd) {
    let c = String(rawCmd || '');
    c = c.replace(/\s*(?:2>&1|\d?>\/dev\/null|>>?\s*[^\s;&|]+)/g, ' ');
    c = c.replace(/\s*\|\s*(?:head|tail|grep|cat|wc|awk|sed|tee)\b[^;]*$/g, '');
    c = c.replace(/^(?:cd\s+[^;]+?\s*(?:&&|;)\s*)+/, '');
    c = c.replace(/\s*&\s*$/, '');
    c = c.replace(/^\s*(?:[A-Z_][A-Z0-9_]*=[^\s;]+\s*)+/, '');
    const parts = c.replace(/\s+/g, ' ').trim().toLowerCase().split(/\s+/);
    return (parts[0] || '') === 'cd' ? '' : parts.join(' ').slice(0, 160);
}

function truncate(s, n = MAX_TOOL_OUTPUT) {
    const str = String(s || '');
    return str.length > n ? `${str.slice(0, n / 2)}\n...[truncated]...\n${str.slice(-n / 2)}` : str;
}

function buildSystemPrompt() {
    return [
        'You are an autonomous task execution agent operating inside a Linux sandbox VM.',
        'The user workspace is mounted at /workspace (all file paths you provide are RELATIVE to /workspace).',
        '',
        'You operate in a strict loop. EVERY reply must be EXACTLY ONE compact JSON object (< 800 chars), no prose outside JSON:',
        '  {"action":"tool","tool":"run_shell","args":{"cmd":"npm test"}}',
        '  {"action":"tool","tool":"read_file","args":{"path":"src/index.js"}}',
        '  {"action":"tool","tool":"list_dir","args":{"path":"src"}}',
        '  {"action":"tool","tool":"edit_file","args":{"path":"README.md","content":"<full new file content>"}}',
        '  {"action":"final","ok":true,"summary":"<what was done, up to 2000 chars>"}',
        '  {"action":"final","ok":false,"summary":"<why the task failed, up to 2000 chars>"}',
        '',
        'Tool rules:',
        '- run_shell: every call is a FRESH shell (cwd resets to /workspace). Use `cd <dir> && <cmd>` inside ONE call for subdirectories. Output is truncated; pipe through `tail` for logs.',
        '- read_file/list_dir: use to inspect state before editing. Prefer read_file over guessing file contents.',
        '- edit_file: overwrite the WHOLE file (dirs auto-created). Never paste file contents into your JSON — use tools.',
        '',
        'Guardrails:',
        '- When a command fails, READ the error and fix the ROOT CAUSE (read_file/edit_file). Do NOT blindly rerun the same command — identical repeated commands are blocked.',
        '- NEVER make irreversible changes without explicit instruction (no git push, no deleting data, no external posts).',
        '- Work efficiently: you have a LIMITED number of rounds. When the task is done (or genuinely blocked), output final.',
        '- The final.summary is shown to the user: state clearly what was done / changed / verified, or the real blocking reason.',
    ].join('\n');
}

function buildTaskPrompt(task) {
    return [
        `# Task: ${task.title}`,
        '',
        task.prompt,
        '',
        `Current time: ${new Date().toISOString()}`,
        'Begin. Reply with exactly one JSON action.',
    ].join('\n');
}

/**
 * 执行一次 LoopTask。
 * @param {object} p
 * @param {object} p.runtime runtime 行（含 provider 关联；工具经 runtime.exec / runtime.fs）
 * @param {string} p.runtimeRef
 * @param {string} p.workspacePath 沙箱内 workspace 路径
 * @param {{title: string, prompt: string}} p.task
 * @param {number} [p.maxRounds]
 * @param {number} [p.timeoutMs]
 * @param {AbortSignal} [p.abortSignal]
 * @param {(entry: object) => void} [p.onRound] 每轮回调（日志落库/SSE 用）
 * @returns {Promise<{ok: boolean, status: string, summary: string, rounds: number, error: string|null}>}
 */
async function executeTask(p) {
    const {
        runtime, runtimeRef, workspacePath, task,
        maxRounds = Number(process.env.LOOP_TASK_MAX_ROUNDS) || 30,
        timeoutMs = Number(process.env.LOOP_TASK_TIMEOUT_MS) || 30 * 60_000,
        abortSignal,
        onRound,
    } = p;

    const deadline = Date.now() + timeoutMs;
    const exec = runtime.exec;
    const fs = runtime.fs;
    const execOpts = { runtimeRef, cwd: workspacePath };
    const logs = [];
    const cmdHistory = new Map(); // sig -> { count, blocked }
    let rounds = 0;

    const messages = [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildTaskPrompt(task) },
    ];

    const pushLog = (entry) => {
        logs.push({ ts: Date.now(), ...entry });
        if (logs.length > 200) logs.splice(0, logs.length - 200); // 只保留尾部 200 条
        try { onRound?.(entry); } catch { /* 回调异常不影响主流程 */ }
    };

    // —— 工具派发（全部经 exec/fs 适配器，落沙箱内）——
    async function dispatchTool(name, args) {
        try {
            if (name === 'run_shell') {
                const cmd = String(args?.cmd || '').trim();
                if (!cmd) return 'run_shell failed: cmd is required';
                const long = LONG_CMD_RE.test(cmd);
                const r = await exec.exec('sh', ['-c', cmd], {}, {
                    ...execOpts,
                    timeoutMs: long ? LONG_SHELL_TIMEOUT_MS : SHELL_TIMEOUT_MS,
                });
                const ec = Number(r?.exitCode ?? r?.code ?? 0);
                return truncate(`exit=${ec}\n${r?.stdout || ''}${r?.stderr ? `\n[stderr]\n${r.stderr}` : ''}`) || 'exit=0 (no output)';
            }
            if (name === 'read_file') {
                const rel = String(args?.path || '');
                if (!rel) return 'read_file failed: path is required';
                const content = await fs.fsRead(workspacePath, rel, { runtimeRef });
                return truncate(typeof content === 'string' ? content : JSON.stringify(content));
            }
            if (name === 'list_dir') {
                const rel = String(args?.path || '.');
                const r = await exec.exec('sh', ['-c', `ls -la -- ${JSON.stringify(rel)}`], {}, { ...execOpts, timeoutMs: 30_000 });
                return truncate(`${r?.stdout || ''}${r?.stderr ? `\n[stderr]\n${r.stderr}` : ''}`) || '(empty)';
            }
            if (name === 'edit_file') {
                const rel = String(args?.path || '');
                const content = args?.content;
                if (!rel || typeof content !== 'string') return 'edit_file failed: path and content are required';
                const r = await fs.fsWrite(workspacePath, rel, content, { runtimeRef });
                return `written: ${r?.path || rel} (${r?.size ?? Buffer.byteLength(content)} bytes)`;
            }
            return `unknown tool: ${name}. Available: run_shell, read_file, list_dir, edit_file, final`;
        } catch (e) {
            return truncate(`tool ${name} failed: ${e?.message || e}`);
        }
    }

    try {
        while (rounds < maxRounds) {
            if (Date.now() > deadline) {
                pushLog({ round: rounds, action: 'timeout', summary: 'task timed out' });
                return { ok: false, status: 'timeout', summary: '', rounds, error: 'task timed out' };
            }
            if (abortSignal?.aborted) {
                pushLog({ round: rounds, action: 'cancelled', summary: 'task cancelled' });
                return { ok: false, status: 'cancelled', summary: '', rounds, error: 'task cancelled' };
            }

            rounds += 1;
            const llm = await callLlm({ messages, abortSignal });
            if (!llm.ok) {
                pushLog({ round: rounds, action: 'llm_error', summary: llm.warning });
                return { ok: false, status: 'failed', summary: '', rounds, error: llm.warning };
            }

            const parsed = extractJson(llm.content);
            if (!parsed || typeof parsed !== 'object') {
                pushLog({ round: rounds, action: 'parse_error', summary: String(llm.content || '').slice(0, 200) });
                messages.push({ role: 'assistant', content: String(llm.content || '') });
                messages.push({
                    role: 'user',
                    content: 'ERROR: your reply was not valid JSON. Reply with EXACTLY ONE compact JSON object per the schema.',
                });
                continue;
            }

            if (parsed.action === 'final' || parsed.tool === 'final') {
                const ok = parsed.ok === true;
                pushLog({ round: rounds, action: 'final', summary: String(parsed.summary || '').slice(0, 300) });
                return { ok, status: ok ? 'succeeded' : 'failed', summary: String(parsed.summary || ''), rounds, error: ok ? null : String(parsed.summary || 'agent reported failure') };
            }

            const tool = String(parsed.tool || '');
            const args = parsed.args || {};
            let resultText;
            if (tool === 'run_shell') {
                // 同命令重复拦截（对齐 verify agent：重复注入强纠偏，超限强制要求换策略）
                const sig = normalizeCmdSig(args?.cmd);
                const prev = sig ? cmdHistory.get(sig) : null;
                if (prev) {
                    prev.count += 1;
                    if (prev.count >= REPEAT_CMD_LIMIT) {
                        pushLog({ round: rounds, action: 'repeat_blocked', summary: sig });
                        messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
                        messages.push({
                            role: 'user',
                            content: `CRITICAL: \`${sig}\` has been run ${prev.count} times with no progress. Repeating it is FORBIDDEN. Change strategy NOW: inspect the real error output with read_file/list_dir, fix the root cause with edit_file, or output final with ok:false and the REAL reason.`,
                        });
                        continue;
                    }
                } else if (sig) {
                    cmdHistory.set(sig, { count: 1 });
                }
                resultText = await dispatchTool('run_shell', args);
            } else if (['read_file', 'list_dir', 'edit_file'].includes(tool)) {
                resultText = await dispatchTool(tool, args);
            } else {
                resultText = `unknown tool: ${tool}. Available: run_shell, read_file, list_dir, edit_file, final`;
            }

            const actionName = tool || 'invalid';
            pushLog({ round: rounds, action: actionName, summary: truncate(
                tool === 'run_shell' ? String(args?.cmd || '') : String(args?.path || ''),
                160,
            ) });

            messages.push({ role: 'assistant', content: String(llm.content || JSON.stringify(parsed)) });
            messages.push({ role: 'user', content: `TOOL RESULT (${actionName}):\n${resultText}\n\nContinue. Reply with exactly one JSON action.` });
        }

        pushLog({ round: rounds, action: 'max_rounds', summary: 'round budget exhausted' });
        return { ok: false, status: 'failed', summary: '', rounds, error: `max rounds (${maxRounds}) exhausted` };
    } catch (e) {
        pushLog({ round: rounds, action: 'error', summary: String(e?.message || e).slice(0, 300) });
        return { ok: false, status: 'failed', summary: '', rounds, error: String(e?.message || e) };
    }
}

module.exports = { executeTask };
