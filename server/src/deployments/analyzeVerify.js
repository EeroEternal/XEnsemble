// Stage-2 verification agent (two-stage auto-deploy).
//   The plan from stage 1 is executed for REAL inside the sandbox VM (guest), and a
//   ReAct agent (LLM = LLM_VERIFY_MODEL, same endpoint as stage 1) drives install /
//   build / serve / health-check, self-healing via edit_file + run_shell until tests pass.
//   Uses runtime.exec / runtime.fs so every command runs in the guest, not on the host.
//   Returns { ok, source, tested, finalStderr, warning } for twoStage.js to consume.

const { getRuntime } = require('../runtime/registry');

const API_KEY = process.env.LLM_ANALYZE_API_KEY || process.env.DEEPSEEK_API_KEY;
const API_URL = process.env.LLM_ANALYZE_API_URL || process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.LLM_VERIFY_MODEL || process.env.LLM_ANALYZE_MODEL || 'deepseek-chat';
const LLM_TIMEOUT_MS = 240000;
const MAX_AGENT_ROUNDS = Number(process.env.OPENCODE_VERIFY_MAX_ROUNDS) || 60;
const MAX_TOOL_OUTPUT = 6000;
const SHELL_TIMEOUT_MS = 240000;

function callLlm(messages) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    return fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: MODEL, messages, max_tokens: 16000, temperature: 0.2, response_format: { type: 'json_object' } }),
        signal: controller.signal,
    })
        .then(async (res) => {
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return { ok: false, warning: `LLM error ${res.status}: ${text.slice(0, 160)}` };
            }
            const data = await res.json();
            const choice = data.choices?.[0];
            const content = choice?.message?.content;
            console.error('[analyzeVerify] model:', MODEL, 'finish_reason:', choice?.finish_reason, 'usage:', JSON.stringify(data.usage), 'content_len:', String(content || '').length);
            return { ok: true, content, finishReason: choice?.finish_reason };
        })
        .catch((e) => ({ ok: false, warning: `LLM unavailable: ${e.message}` }))
        .finally(() => clearTimeout(timer));
}

function summarizeArgs(args) {
    const out = {};
    for (const [k, v] of Object.entries(args || {})) {
        out[k] = typeof v === 'string' ? (v.length > 80 ? `${v.slice(0, 80)}…` : v) : v;
    }
    return out;
}

function summarize(s, max = 160) {
    const t = String(s || '');
    return t.length > max ? `${t.slice(0, max)}…(+${t.length - max} chars)` : t;
}

// 控制上下文体积：消息过多时只保留 system + 最近的 N 条，中间的超长工具输出压缩为摘要，
// 防止上下文无限膨胀导致模型输出失控（超长截断）。
function trimContext(messages, keep = 40) {
    if (messages.length <= keep + 2) return messages;
    const head = [messages[0]];
    const recent = messages.slice(-keep);
    const middle = messages.slice(1, -keep).map((m) => {
        if (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Tool ')) {
            return { role: 'user', content: `${m.content.slice(0, 300)}…(summarized)` };
        }
        return m;
    });
    return [...head, ...middle, ...recent];
}

function tryParseJson(text) {
    let s = String(text || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

function shellQuote(s) {
    return `'${String(s).replace(/'/g, "'\\''")}'`;
}

async function runTool(tool, args, runtimeRef, workspacePath) {
    const runtime = getRuntime();
    try {
        if (tool === 'list_dir') {
            const path = String(args.path || '.');
            const r = await runtime.exec.exec('sh', ['-c', `ls -laF ${shellQuote(path)} 2>&1 | head -120`], {}, { runtimeRef, cwd: workspacePath });
            return (r.stdout || '(empty)').slice(0, MAX_TOOL_OUTPUT);
        }
        if (tool === 'read_file') {
            const path = String(args.path || '');
            if (!path) return '(no path)';
            const c = await runtime.fs.fsRead(workspacePath, path, { runtimeRef, encoding: 'utf8' });
            return String(c || '').slice(0, MAX_TOOL_OUTPUT);
        }
        if (tool === 'edit_file') {
            const path = String(args.path || '');
            const content = String(args.content == null ? '' : args.content);
            if (!path) return '(no path)';
            if (path.includes('..')) return '(invalid path)';
            if (content.length > 200000) return '(content too large, max 200000 bytes)';
            await runtime.fs.fsWrite(workspacePath, path, content, { runtimeRef });
            return `wrote ${content.length} bytes to ${path}`;
        }
        if (tool === 'run_shell') {
            const cmd = String(args.cmd || '').trim();
            if (!cmd) return '(no command)';
            if (cmd.length > 4000) return '(command too long, max 4000 chars)';
            // Capture the REAL exit code: piping through head would otherwise mask it with head's own status.
            const wrapped = `${cmd} > /tmp/_vt.log 2>&1; ec=$?; head -200 /tmp/_vt.log; echo "__EXIT_CODE__=\${ec}"`;
            const r = await runtime.exec.exec('sh', ['-c', wrapped], {}, {
                runtimeRef, cwd: workspacePath, maxBuffer: 4 * 1024 * 1024, timeoutMs: SHELL_TIMEOUT_MS,
            });
            let out = String(r.stdout || '');
            let ec = r.exitCode;
            const m = out.match(/__EXIT_CODE__=(-?\d+)/);
            if (m) {
                ec = parseInt(m[1], 10);
                out = out.replace(/__EXIT_CODE__=-?\d+\s*$/, '').replace(/__EXIT_CODE__=-?\d+\s*/g, '');
            }
            return `exit=${ec}\n${(out || '(no output)').slice(0, MAX_TOOL_OUTPUT)}`;
        }
        return '(unknown tool)';
    } catch (e) {
        return `(tool error: ${e.message})`;
    }
}

function buildSystemPrompt(plan) {
    const stepsJson = JSON.stringify(plan?.steps || [], null, 2);
    return [
        'You are a deployment verification agent running inside a sandbox Linux VM. Your job: execute a deploy plan for a project at /workspace, make the app actually pass a health check, and fix problems yourself until it works.',
        'Environment: Linux sandbox with node/npm/pnpm/yarn, python3/pip, go, cargo, curl. The project root is /workspace.',
        'Tools (respond with EXACTLY ONE tool call or the final answer, as valid JSON, no markdown fences):',
        '1. {"action":"tool","tool":"list_dir","args":{"path":"."}} — list a directory (relative to /workspace; "." for root).',
        '2. {"action":"tool","tool":"read_file","args":{"path":"package.json"}} — read a file.',
        '3. {"action":"tool","tool":"edit_file","args":{"path":"server/.env","content":"<full new file content>"}} — overwrite a file (creates missing dirs). Used to fix configs, scripts, missing files.',
        '4. {"action":"tool","tool":"run_shell","args":{"cmd":"npm install"}} — run a shell command in /workspace and see exit code + output. Use for install/build/start/test/curl.',
        'CRITICAL execution rules:',
        '- Every run_shell call is a FRESH shell (working dir resets to /workspace each time). Use `cd <dir> && <cmd>` inside ONE call when you need a subdirectory. Background processes started with `&` keep running in the VM.',
        '- The serve command must start the app in the background and stay running. Use e.g. `export PORT=<port>; (cd server && npm start) > /tmp/serve.log 2>&1 & sleep 5; cat /tmp/serve.log`, then health-check with curl.',
        '- Verify with an actual HTTP request, not just "process started": `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/`. A 2xx/3xx/expected response means success.',
        '- When a command fails, DO NOT just rerun it. Read the error, inspect files (read_file/list_dir), fix the root cause (edit_file), then retry.',
        'Deploy plan to execute:',
        JSON.stringify(plan?.steps || [], null, 2),
        '',
        'Workflow:',
        '1. Run the prepare steps one by one (install deps, build, migrate, prisma generate, etc.). If the project needs native build deps, `apt-get update && apt-get install -y python3 build-essential` first.',
        '2. Start the full app (frontend + backend) on a port, health-check it with curl.',
        '3. If you also see a `npm test` / test script that is quick, run it too and count it as tested.',
        '4. Iterate until the health check passes.',
        'OUTPUT SIZE RULE (MANDATORY): a TOOL CALL must be ONE compact JSON under 800 characters. NEVER paste file contents, logs or commands into your JSON — use read_file / edit_file / run_shell tools for that. If you were about to write a long reply, STOP and output the short JSON tool call instead. The FINAL answer may be up to 4000 characters so you can include the key error output in finalStderr.',
        'When the app responds correctly, output your final answer:',
        '{"action":"final","result":{"ok":true,"tested":["npm install","npm run build","curl /"],"finalStderr":"","summary":"<1-2 sentences>"}}',
        'If you cannot make it pass after exhaustive fixes, output:',
        '{"action":"final","result":{"ok":false,"tested":["..."],"finalStderr":"<the latest error output>","summary":"<what you tried and why it failed>"}}',
    ].join('\n');
}

// 断点续修提示：把上次会话的进度浓缩成一条 user 消息，指导新轮次跳过已成功的步骤、直击失败点。
function buildResumeHint(trail) {
    const t = Array.isArray(trail) ? trail : [];
    const successes = t.filter((x) => x.action === 'tool' && /^exit=0\b/.test(String(x.out || ''))).slice(-5)
        .map((s) => `${s.tool} ${JSON.stringify(s.args || {})}`);
    const lastTool = [...t].reverse().find((x) => x.action === 'tool');
    const lastInvalid = [...t].reverse().find((x) => x.action === 'invalid_json');
    const lines = [
        'CONTINUING a previous repair session. Do NOT repeat steps that already succeeded — go straight for the failing point.',
        ...(successes.length ? [`Already succeeded (skip these): ${successes.join('; ')}`] : []),
        ...(lastTool ? [`Last action before stopping: ${lastTool.tool} ${JSON.stringify(lastTool.args || {})} → ${String(lastTool.out || '').slice(0, 300)}`] : []),
        ...(lastInvalid ? ['Some of your earlier replies were too long and got truncated — keep tool-call JSON short (<800 chars).'] : []),
        'Inspect the latest error, fix it, verify with curl, then output your final answer.',
    ];
    return lines.filter(Boolean).join('\n');
}

async function runVerifyWithAgent({ workspacePath, runtimeRef, plan, projectType, onRound, resume }) {
    const defaultPort = projectType?.defaultPort || 3000;
    let messages;
    let roundStart = 0;
    if (resume && Array.isArray(resume.messages) && resume.messages.length > 0) {
        // 断点续修：接回上次的对话历史，注入进度提示后从上次轮数继续，不从头重跑。
        messages = resume.messages.slice();
        roundStart = Math.min(Number(resume.roundsUsed) || 0, MAX_AGENT_ROUNDS - 1);
        messages.push({ role: 'user', content: buildResumeHint(resume.trail) });
    } else {
        const initialUser = [
            `Project root: /workspace. Detected type: ${projectType?.type || 'unknown'}, default port: ${defaultPort}.`,
            'Start executing the plan now. Report what you run. Work until the health check passes.',
        ].join('\n');
        messages = [
            { role: 'system', content: buildSystemPrompt(plan) },
            { role: 'user', content: initialUser },
        ];
    }

    let lastResult = null;
    let prevToolSig = '';
    let repeatCount = 0;
    const trail = [];

    for (let round = roundStart; round < MAX_AGENT_ROUNDS; round++) {
        if (onRound) onRound(round);
        const llmResult = await callLlm(messages);
        if (!llmResult.ok) {
            return { ok: false, source: 'ai', warning: llmResult.warning, finalStderr: '', tested: [], trail, messages: trimContext(messages) };
        }
        const truncated = llmResult.finishReason === 'length';
        let parsed = tryParseJson(llmResult.content);
        if (!parsed) {
            const len = String(llmResult.content || '').length;
            trail.push({ round, action: 'invalid_json', truncated, len });
            console.error(`[analyzeVerify] round ${round}: INVALID JSON (truncated=${truncated}, len=${len}, finish=${llmResult.finishReason})`);
            messages.push({
                role: 'user',
                content: 'Your previous response was NOT valid JSON (it was likely truncated because it was too long). Respond with ONLY ONE valid JSON object — no thinking, no analysis text, no markdown fences. A TOOL CALL must be under 800 characters: {"action":"tool","tool":"...","args":{...}}. The FINAL answer may be up to 4000 characters: {"action":"final","result":{...}}.',
            });
            continue;
        }
        if (parsed.action === 'tool') {
            const sig = `${parsed.tool}:${JSON.stringify(parsed.args || {})}`;
            if (sig === prevToolSig) {
                repeatCount++;
                if (repeatCount >= 2) {
                    trail.push({ round, action: 'repeat', tool: parsed.tool });
                    messages.push({ role: 'user', content: 'You repeated the exact same tool call. STOP. Try a different fix or output your final answer now.' });
                    prevToolSig = '';
                    repeatCount = 0;
                    continue;
                }
            } else {
                prevToolSig = sig;
                repeatCount = 0;
            }
            const out = await runTool(parsed.tool, parsed.args || {}, runtimeRef, workspacePath);
            trail.push({ round, action: 'tool', tool: parsed.tool, args: summarizeArgs(parsed.args), out: summarize(out) });
            console.error(`[analyzeVerify] round ${round}: tool=${parsed.tool} args=${JSON.stringify(summarizeArgs(parsed.args))} out_len=${String(out).length}`);
            messages.push({ role: 'user', content: `Tool "${parsed.tool}" result:\n${out}` });
            messages = trimContext(messages);
            continue;
        }
        if (parsed.action === 'final') {
            const r = parsed.result || {};
            const ok = Boolean(r.ok);
            lastResult = {
                ok,
                tested: Array.isArray(r.tested) ? r.tested.map((t) => String(t).slice(0, 200)) : [],
                finalStderr: String(r.finalStderr || '').slice(0, 4000),
                summary: String(r.summary || '').slice(0, 500),
            };
            trail.push({ round, action: 'final', ok });
            return { ...lastResult, source: 'ai', warning: ok ? '' : 'verify agent reported failure', trail, messages: trimContext(messages), roundsUsed: round + 1 };
        }
        trail.push({ round, action: 'unknown', name: String(parsed.action).slice(0, 50) });
        messages.push({ role: 'user', content: 'Unknown action. Respond with a single tool call or the final answer JSON.' });
    }

    // 超轮数且没有 final 答案：记录完整活动轨迹，并做一次"按计划直跑"兜底，
    // 拿到真实失败步骤 + stderr（或确认服务其实可用），而不是只给一句笼统的报错。
    const fallbackResult = await runVerifyWithoutLlm({ workspacePath, runtimeRef, plan, projectType }).catch(() => null);
    const fallbackOk = !!fallbackResult?.ok;
    const fallbackFailed = fallbackResult && !fallbackResult.ok;
    const concreteStderr = fallbackFailed
        ? fallbackResult.finalStderr
        : (lastResult?.finalStderr || '');
    const ok = lastResult ? lastResult.ok : fallbackOk;
    console.error('[analyzeVerify] MAX ROUNDS reached; fallback ok=', fallbackOk, 'trail=', JSON.stringify(trail.slice(-24)));
    return {
        ...(lastResult || { ok, tested: [], finalStderr: '', summary: '' }),
        ok,
        source: 'ai',
        warning: fallbackOk
            ? `AI 自动修复达到轮数上限（${MAX_AGENT_ROUNDS} 轮），但按计划直接执行确认服务可用`
            : (fallbackFailed
                ? `AI 自动修复达到轮数上限（${MAX_AGENT_ROUNDS} 轮），已按计划直跑定位到失败步骤`
                : `AI 自动修复达到轮数上限（${MAX_AGENT_ROUNDS} 轮），未能给出最终结论`),
        finalStderr: concreteStderr,
        fallback: fallbackResult || null,
        trail: trail.slice(-40),
        messages: trimContext(messages),
        roundsUsed: MAX_AGENT_ROUNDS,
    };
}

// Fallback when no LLM is configured: execute the plan's prepare steps directly via
// runtime.exec, then try to serve + curl-probe. No self-healing.
async function runVerifyWithoutLlm({ workspacePath, runtimeRef, plan, projectType }) {
    const runtime = getRuntime();
    const tested = [];
    const port = projectType?.defaultPort || 3000;
    try {
        const steps = (plan?.steps || []).filter((s) => s.kind !== 'serve');
        for (const step of steps) {
            if (!step.command) continue;
            const r = await runtime.exec.exec('sh', ['-c', `${step.command} > /tmp/_vt.log 2>&1; ec=$?; cat /tmp/_vt.log | head -120; echo "__EXIT_CODE__=\${ec}"`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: SHELL_TIMEOUT_MS });
            let ec = r.exitCode;
            const out = String(r.stdout || '');
            const m = out.match(/__EXIT_CODE__=(-?\d+)/);
            if (m) ec = parseInt(m[1], 10);
            tested.push(`${step.name || step.id}: exit=${ec}`);
            if (ec !== 0) {
                return { ok: false, source: 'shell', tested, finalStderr: out.replace(/__EXIT_CODE__=-?\d+\s*/g, '').slice(0, 4000), warning: `step "${step.name}" failed` };
            }
        }
        const serveStep = (plan?.steps || []).find((s) => s.kind === 'serve');
        if (serveStep?.command) {
            const cmd = `export PORT=${port}; ${serveStep.command} > /tmp/serve.log 2>&1 & sleep 6; curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/ || true`;
            const r = await runtime.exec.exec('sh', ['-c', cmd], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 30000 });
            const code = String(r.stdout || '').trim();
            tested.push(`serve probe: http=${code}`);
            if (code.startsWith('2') || code.startsWith('3') || code === '404') {
                return { ok: true, source: 'shell', tested, finalStderr: '', warning: '' };
            }
            const log = await runtime.exec.exec('sh', ['-c', `cat /tmp/serve.log 2>&1 | tail -60`], {}, { runtimeRef, cwd: workspacePath });
            return { ok: false, source: 'shell', tested, finalStderr: String(log.stdout || '').slice(0, 4000), warning: 'app did not respond to health check' };
        }
        return { ok: true, source: 'shell', tested, finalStderr: '', warning: '' };
    } catch (e) {
        return { ok: false, source: 'shell', tested, finalStderr: `verify error: ${e.message}`, warning: e.message };
    }
}

async function analyzeProjectVerify({ workspacePath, runtimeRef, plan, projectType, onRound, resume }) {
    if (!API_KEY || !API_URL) {
        return runVerifyWithoutLlm({ workspacePath, runtimeRef, plan, projectType });
    }
    return runVerifyWithAgent({ workspacePath, runtimeRef, plan, projectType, onRound, resume });
}

module.exports = { analyzeProjectVerify };
