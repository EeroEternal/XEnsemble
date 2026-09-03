// Stage-2 verification agent (two-stage auto-deploy).
//   The plan from stage 1 is executed for REAL inside the sandbox VM (guest), and a
//   ReAct agent (LLM = LLM_VERIFY_MODEL, same endpoint as stage 1) drives install /
//   build / serve / health-check, self-healing via edit_file + run_shell until tests pass.
//   Uses runtime.exec / runtime.fs so every command runs in the guest, not on the host.
//   Returns { ok, source, tested, finalStderr, warning } for twoStage.js to consume.

const { getRuntime } = require('../runtime/registry');
const { detectRuntimeToolchain, renderToolchainBlock } = require('./runtimeToolchain');

const API_KEY = process.env.LLM_ANALYZE_API_KEY;
const API_URL = process.env.LLM_ANALYZE_API_URL || 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.LLM_VERIFY_MODEL || process.env.LLM_ANALYZE_MODEL || 'deepseek-chat';
const LLM_TIMEOUT_MS = 240000;
const MAX_AGENT_ROUNDS = Number(process.env.OPENCODE_VERIFY_MAX_ROUNDS) || 60;
const MAX_TOOL_OUTPUT = 6000;
const SHELL_TIMEOUT_MS = 240000;

const LLM_RETRIES = 2;

// 对 LLM API 的瞬时故障（5xx / 429 / 网络错误）自动重试，避免一次网关抖动直接让部署失败。
async function callLlm(messages, abortSignal) {
    let lastWarning = '';
    for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
        // If an external abort signal is provided, link it to our controller
        if (abortSignal) {
            abortSignal.addEventListener('abort', () => controller.abort());
        }
        try {
            const res = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
                body: JSON.stringify({ model: MODEL, messages, max_tokens: 16000, temperature: 0.2, response_format: { type: 'json_object' } }),
                signal: controller.signal,
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                lastWarning = `LLM error ${res.status}: ${text.slice(0, 160)}`;
                if ((res.status >= 500 || res.status === 429) && attempt < LLM_RETRIES) {
                    console.error(`[analyzeVerify] LLM error ${res.status}, retry ${attempt + 1}/${LLM_RETRIES}`);
                    await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 4000));
                    continue;
                }
                return { ok: false, warning: lastWarning };
            }
            const data = await res.json();
            const choice = data.choices?.[0];
            const content = choice?.message?.content;
            console.error('[analyzeVerify] model:', MODEL, 'finish_reason:', choice?.finish_reason, 'usage:', JSON.stringify(data.usage), 'content_len:', String(content || '').length);
            return { ok: true, content, finishReason: choice?.finish_reason };
        } catch (e) {
            lastWarning = `LLM unavailable: ${e.message}`;
            if (attempt < LLM_RETRIES) {
                console.error(`[analyzeVerify] LLM unavailable (${e.message}), retry ${attempt + 1}/${LLM_RETRIES}`);
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

function summarizeArgs(args) {
    const out = {};
    for (const [k, v] of Object.entries(args || {})) {
        out[k] = typeof v === 'string' ? (v.length > 80 ? `${v.slice(0, 80)}…` : v) : v;
    }
    return out;
}

// 语义化命令签名：剥离 shell 装饰（日志重定向、tail/echo 收尾、cd 前缀、nohup/括号包裹、后台 &），
// 只保留核心命令本身。用于跨工具调用的命令级去重——agent 换个日志文件名就绕过精确匹配的情况。
function normalizeCmdSig(rawCmd) {
    let c = String(rawCmd || '');
    // 去掉重定向与 2>&1 / 2>/dev/null
    c = c.replace(/\s*(?:2>&1|\d?>\/dev\/null|>>?\s*[^\s;&|]+)/g, ' ');
    // 去掉管道收尾（| head / | tail / | grep …）
    c = c.replace(/\s*\|\s*(?:head|tail|grep|cat|wc|awk|sed)\b[^;]*$/g, '');
    // 去掉 ; echo / ; sleep / ; tail 等收尾装饰（到下一个 ; 为止）
    c = c.replace(/\s*;\s*(?:echo|printf|sleep|tail|head|cat|test|\[)\b[^;]*/g, ' ');
    // 去掉前导 cd X && / cd X; 以及 nohup/setsid、括号包裹、结尾 &
    c = c.replace(/^(?:cd\s+[^;]+?\s*(?:&&|;)\s*)+/, '');
    c = c.replace(/\s*(?:nohup|setsid)\s+/g, ' ');
    c = c.replace(/^[([]+/, '').replace(/[)\]]+\s*$/, '');
    c = c.replace(/\s*&\s*$/, '');
    return c.replace(/\s+/g, ' ').trim().toLowerCase();
}

// 泛化判定：pkill/kill 是否指向安装/构建类进程（agent 常误杀自己刚起的 install/build）。
function isKillingOwnInstall(rawCmd) {
    const c = String(rawCmd || '').toLowerCase();
    if (!/\b(pkill|killall|kill)\b/.test(c)) return false;
    return /(npm|pnpm|yarn|bun|pip|pip3|uv|apt|go mod|maven|gradle|composer|poetry)\s*(install|add|build|ci)|install|build|pnpm\s*install/.test(c) && /(-9\b|force|f\b)/.test(c) || /pkill\s+-9\s+-f.*(install|build)/.test(c);
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

// 目录列表/源码树页面特征（python http.server 的 "Directory listing for"，及 serve 等的 "Index of"）。
function isDirectoryListing(body) {
    return /<title>\s*Index of\b/i.test(body)
        || /<title>\s*Directory listing for\b/i.test(body)
        || /\bIndex of \//.test(body)
        || /\bDirectory listing for \//.test(body);
}

// box 沙箱默认预览页特征（guest 常驻的 "Workspace ready" 页，不是用户应用）。
function isBoxDefaultPage(body) {
    return /Workspace ready/.test(body) && /Edit files here/.test(body);
}

// 单端口探测：curl 一个端口，判定是否为"真实应用内容"。
// boxDefaultPorts: box 沙箱常驻默认预览端口的集合（[3000, 5173]）。其中：
//   - 5173 是 box 的默认 preview 服务（preview.json 的 serve . --listen 5173），常驻且
//     verify 的 pkill npx serve 杀不掉，应用几乎不可能监听它 → 无条件排除，避免误选
//     box 默认页/workspace 根内容为 appPort；
//   - 3000 是 box 欢迎页常驻端口，但 agent 也可能把应用 serve 到 3000，因此仅当内容
//     确为默认欢迎页时才排除。
async function probePort({ runtimeRef, workspacePath, port, boxDefaultPorts }) {
    const runtime = getRuntime();
    try {
        // 注意：curl 的 -w 标记追加在 body 末尾，若再 `| head -c 3000` 截断，
        // 长 HTML 页面会把 __HTTPCODE__ 标记一起截掉 → httpCode 解析失败误判 down。
        // 改为先拿 code（-o /dev/null），再单独拿 body 前 3000 字节，两者互不影响。
        const r = await runtime.exec.exec(
            'sh',
            ['-c', `CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/ 2>/dev/null); BODY=$(curl -s -m 8 http://127.0.0.1:${port}/ 2>/dev/null | head -c 3000); printf '%s\\n__HTTPCODE__:%s' "$BODY" "$CODE"`],
            {},
            { runtimeRef, cwd: workspacePath, timeoutMs: 25000 },
        );
        const out = String(r.stdout || '');
        const codeMatch = out.match(/__HTTPCODE__:(\d{3})/);
        const httpCode = codeMatch ? codeMatch[1] : '000';
        const body = out.replace(/__HTTPCODE__:\d{3}/, '').trim();
        if (httpCode === '000') {
            return { ok: false, listen: false, reason: `端口 ${port} 连不上` };
        }
        if (!httpCode.startsWith('2') && !httpCode.startsWith('3')) {
            return { ok: false, listen: true, reason: `端口 ${port} HTTP ${httpCode}` };
        }
        if (isDirectoryListing(body)) {
            return { ok: false, listen: true, reason: `端口 ${port} 是目录列表` };
        }
        if (port === 5173 || (boxDefaultPorts.includes(port) && isBoxDefaultPage(body))) {
            return { ok: false, listen: true, reason: `端口 ${port} 是沙箱默认页` };
        }
        if (!body) {
            return { ok: false, listen: true, reason: `端口 ${port} 空响应` };
        }
        return { ok: true, httpCode, snippet: body.slice(0, 120) };
    } catch (e) {
        return { ok: false, listen: false, reason: `端口 ${port} 探测失败: ${e.message}` };
    }
}

// 列出 guest 实际监听的 TCP 端口：优先 ss；blink guest 里 ss 常不可用，
// 退回 /proc/net/tcp（不依赖 ss）。assertAppIsServed 与后端端口监听检查共用。
async function listGuestListenPorts(runtimeRef, workspacePath) {
    const runtime = getRuntime();
    try {
        const r = await runtime.exec.exec(
            'sh',
            ['-c', 'ss -tln 2>/dev/null | awk \'{print $4}\' | grep -oE \":[0-9]+$\" | cut -d: -f2 | sort -un | head -60'],
            {},
            { runtimeRef, cwd: workspacePath, timeoutMs: 10000 },
        );
        const ports = (r.stdout || '').split('\n').map((s) => Number(s)).filter((n) => n > 0 && n < 65535);
        if (ports.length) return ports;
    } catch { /* ss unavailable */ }
    try {
        // /proc/net/tcp + /proc/net/tcp6: st=0A 是 LISTEN；local_address 端口为十六进制
        // （如 0F30 = 3888）。必须同时读 IPv4 与 IPv6 表——serve 等进程常绑定 IPv6 通配
        // 地址 ::（只出现在 /proc/net/tcp6），只看 IPv4 会漏掉真实应用端口。
        const r = await runtime.exec.exec(
            'sh',
            ['-c', 'awk \'function h2d(h,i,c,v,r){r=0;for(i=1;i<=length(h);i++){c=tolower(substr(h,i,1));v=(c~/[0-9]/)?c:index("abcdef",c)+9;r=r*16+v;}return r;} NR>1 && $4=="0A" {split($2,a,":"); print h2d(a[2])}\' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -un | head -60'],
            {},
            { runtimeRef, cwd: workspacePath, timeoutMs: 10000 },
        );
        return (r.stdout || '').split('\n').map((s) => Number(s)).filter((n) => n > 0 && n < 65535);
    } catch { /* ignore */ }
    return [];
}

// 系统侧独立健康检查（多端口）：verify agent 声称 ok 后，扫描 guest 实际监听端口，
// 找到"真正 serve 应用内容"的端口（排除目录列表 / 空页 / box 默认页 / 源码树），
// 并返回该端口供 preview tunnel 使用。agent 用哪个端口运行不写死，灵活处理端口占用。
async function assertAppIsServed({ runtimeRef, workspacePath, preferredPort }) {
    const preferred = Number(preferredPort) || 0;
    const listenPorts = await listGuestListenPorts(runtimeRef, workspacePath);
    // 常见应用端口，用于给真实监听端口的探测排序（preferred 排最前，其余常见端口次之）。
    const commonPorts = [3000, 3888, 3889, 5173, 4173, 8080, 8000, 9000, 5000, 3001, 4000, 8081];
    // box 沙箱常驻默认预览端口：3000（欢迎页）与 5173（preview.json serve . --listen 5173）。
    const boxDefaultPorts = [Number(process.env.BOXLITE_DEFAULT_PREVIEW_PORT || 3000), 5173];

    // 收敛：优先只探测真实监听的端口（避免对 down 端口空 curl 等待），
    // 顺序 preferred → 监听中的常见端口 → 其余监听端口。
    // 轮询重试：verify agent 刚报告 ok 时应用进程可能还在启动（serve/vite/dsh 冷启动
    // 常需数秒），一轮探测全 down 就失败会让真实应用被误判为"未发现监听端口"。
    const probeAttempts = async () => {
        const probeDetail = [];
        const errors = [];
        const probeLoop = async (ports) => {
            for (const port of ports) {
                const res = await probePort({ runtimeRef, workspacePath, port, boxDefaultPorts });
                probeDetail.push(`${port}=${res.httpCode || (res.listen ? 'listen' : 'down')}${res.ok ? '(app)' : ''}`);
                if (res.ok) {
                    return { ok: true, port, httpCode: res.httpCode, snippet: res.snippet };
                }
                if (res.listen) errors.push(res.reason);
            }
            return null;
        };
        if (listenPorts.length) {
            const listened = new Set(listenPorts);
            const ordered = [];
            if (preferred && listened.has(preferred)) ordered.push(preferred);
            for (const p of commonPorts) {
                if (p !== preferred && listened.has(p)) ordered.push(p);
            }
            for (const p of [...listenPorts].sort((a, b) => a - b)) {
                if (!ordered.includes(p)) ordered.push(p);
            }
            const hit = await probeLoop(ordered);
            if (hit) return { hit, detail: probeDetail, errors };
            // 监听端口里没找到真实应用（可能 ss/proc 漏报、serve 刚起来、或监听端口非 HTTP），
            // 回退探测常见应用端口（preferred + commonPorts），避免漏掉真实应用端口。
            const probed = new Set(ordered);
            const fallback = [preferred, ...commonPorts].filter((p) => p > 0 && !probed.has(p));
            if (fallback.length) {
                const fbHit = await probeLoop(fallback);
                if (fbHit) return { hit: fbHit, detail: probeDetail, errors };
            }
        } else {
            // 保底：ss + /proc/net/tcp 都拿不到监听端口时，回退全量 base 探测（curl 已收窄 2s）。
            const base = [...new Set([preferred, ...commonPorts])];
            const hit = await probeLoop(base);
            if (hit) return { hit, detail: probeDetail, errors };
        }
        return { hit: null, detail: probeDetail, errors };
    };

    // 最多 3 轮、每轮间隔 5s：给冷启动（serve/vite/dsh/webpack）留出监听时间。
    for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await probeAttempts();
        if (result.hit) return result.hit;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 5000));
        console.error(`[analyzeVerify] app port discovery attempt ${attempt}/3 failed. listenPorts=${JSON.stringify(listenPorts)} probes=${result.detail.join(', ')} errors=${result.errors.join('; ')}`);
    }
    return { ok: false, reason: `未发现监听的应用端口（3 次探测均无可用端口）` };
}

// API/后端健康探测：根路径 200 不代表应用可用——前后端分离项目（前端代理到本地
// 后端）前端单独起来也能 200，但后端没启动时浏览器里就是白屏。
// 探测依据全部来自 verify agent 读代码后的上报，不做任何写死路径猜测：
//   1) agent 报了 apiEndpoints（真实 API 路由）→ 在前端端口上 GET 探测：
//      2xx/3xx/401/403/405 判活（405 = 路由存在但方法不符），5xx 判后端挂了，
//      全 404 判 inconclusive 放行（避免路径/方法误判）
//   2) 没报 apiEndpoints 但报了 backendPort（后端监听端口，如 next rewrites
//      destination 里的 8080）→ 只检查该端口是否 LISTEN，不发任何 HTTP 请求
//   3) 两者都没报 → 无法判定（纯前端站 / agent 未识别出后端）→ 放行并记录
// 返回 { ok, verdict, reason?, probed, endpoints }。
function sanitizeApiEndpoints(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
        const s = String(item || '').trim();
        if (!s || s.length > 120 || !s.startsWith('/') || /\s/.test(s)) continue;
        if (!out.includes(s)) out.push(s);
        if (out.length >= 5) break;
    }
    return out;
}

function sanitizeBackendPorts(raw) {
    const list = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw]);
    const out = [];
    for (const item of list) {
        const n = Number(item);
        if (!Number.isInteger(n) || n <= 0 || n >= 65535) continue;
        if (!out.includes(n)) out.push(n);
        if (out.length >= 5) break;
    }
    return out;
}

async function probeApiHealth({ runtimeRef, workspacePath, port, endpoints, backendPorts }) {
    const targets = sanitizeApiEndpoints(endpoints);

    // 分支 1：agent 上报了真实 API 路由 → 在前端端口上 HTTP 探测
    if (targets.length) {
        const p = Number(port) || 0;
        if (!p) return { ok: true, verdict: 'skipped', probed: [], endpoints: targets };
        const runtime = getRuntime();
        const cmd = targets
            .map((path) => `echo "${path} $(curl -s -o /dev/null -m 4 -w '%{http_code}' http://127.0.0.1:${p}${path} 2>/dev/null)"`)
            .join('; ');
        try {
            const r = await runtime.exec.exec('sh', ['-c', cmd], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 40000 });
            const probed = String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
            const results = probed
                .map((l) => { const m = l.match(/^(\S+) (\d{3})$/); return m ? { path: m[1], code: m[2] } : null; })
                .filter(Boolean);
            if (!results.length) return { ok: true, verdict: 'no_result', probed, endpoints: targets };
            const alive = results.find((x) => x.code.startsWith('2') || x.code.startsWith('3') || ['401', '403', '405'].includes(x.code));
            if (alive) return { ok: true, verdict: 'alive', probed, endpoints: targets };
            const broken = results.filter((x) => x.code.startsWith('5'));
            if (broken.length) {
                return {
                    ok: false,
                    verdict: 'backend_down',
                    reason: `API 健康探测失败：${broken.map((x) => `${x.path}=${x.code}`).join(', ')}（根路径 200 但 API 5xx —— 前端代理的后端服务大概率没启动/连不上数据库）`,
                    probed,
                    endpoints: targets,
                };
            }
            // 全 404/000：没有可判定的 API 面（方法不符且框架回 404 / 代理前缀差异），不误判
            return { ok: true, verdict: 'inconclusive', probed, endpoints: targets };
        } catch (e) {
            // 探测本身失败不阻断部署（网络抖动等），交给根路径检查兜底
            console.error(`[analyzeVerify] api health probe error (non-fatal): ${e.message}`);
            return { ok: true, verdict: 'probe_error', probed: [], endpoints: targets };
        }
    }

    // 分支 2：agent 只报了后端端口 → 检查端口是否监听（不发 HTTP，零路径猜测）
    const ports = sanitizeBackendPorts(backendPorts);
    if (ports.length) {
        const listening = await listGuestListenPorts(runtimeRef, workspacePath);
        const listenSet = new Set(listening);
        const down = ports.filter((bp) => !listenSet.has(bp));
        if (down.length) {
            return {
                ok: false,
                verdict: 'backend_not_listening',
                reason: `后端端口未监听：${down.join(', ')}（前端正常但后端进程没起来）`,
                probed: ports.map((bp) => `port ${bp}: ${listenSet.has(bp) ? 'listening' : 'down'}`),
                endpoints: ports.map((bp) => `port:${bp}`),
            };
        }
        return {
            ok: true,
            verdict: 'backend_listening',
            probed: ports.map((bp) => `port ${bp}: listening`),
            endpoints: ports.map((bp) => `port:${bp}`),
        };
    }

    // 分支 3：agent 未识别出后端（纯前端站或未上报）→ 放行
    return { ok: true, verdict: 'skipped', probed: [], endpoints: [] };
}

/**
 * Code-side post-verify constraint: re-probe the sandbox toolchain and
 * flag any tool the plan's serve step still needs but is missing. This
 * is the "code is the stable constraint" check the user asked for —
 * even if the LLM's final answer says `ok: true`, we refuse success
 * when the binary the serve step needs is still not on PATH.
 *
 * Only flags tools that the plan actually invokes AND the plan does
 * NOT already install via apt-get in some prepare step.
 *
 * @param {object} plan
 * @param {string} runtimeRef
 * @param {string} workspacePath
 * @returns {Promise<{tool:string, reason:string}[]>}
 */
async function findMissingPlanTools(plan, runtimeRef, workspacePath) {
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    if (steps.length === 0) return [];
    // Collect tools used by non-apt-get steps.
    const toolRe = /(?:^|\s|;|&&|\|\|)(go|cargo|rustc|python3|pip|pip3|java|mvn|gradle|make|gcc|node|pnpm|npm|yarn|corepack)\b/g;
    const aptRe = /apt-get\s+install/;
    const used = new Set();
    for (const step of steps) {
        if (aptRe.test(step.command || '')) continue; // apt-get install is the install, not a dep
        for (const m of String(step.command || '').matchAll(toolRe)) {
            used.add(m[1]);
        }
    }
    if (used.size === 0) return [];
    const inv = await detectRuntimeToolchain(runtimeRef, workspacePath).catch(() => []);
    const byCmd = Object.fromEntries(inv.map((i) => [i.command, i]));
    const missing = [];
    for (const tool of used) {
        const info = byCmd[tool];
        if (!info || !info.available) {
            missing.push({ tool, reason: `plan step calls "${tool}" but boxlite sandbox does not have it on PATH` });
        }
    }
    return missing;
}

function buildSystemPrompt(plan, toolchain) {
    const stepsJson = JSON.stringify(plan?.steps || [], null, 2);
    const toolchainBlock = renderToolchainBlock(toolchain || []);
    return [
        'You are a deployment verification agent running inside a sandbox Linux VM. Your job: execute a deploy plan for a project at /workspace, make the app actually pass a health check, and fix problems yourself until it works.',
        toolchainBlock,
        'Tools (respond with EXACTLY ONE tool call or the final answer, as valid JSON, no markdown fences):',
        '1. {"action":"tool","tool":"list_dir","args":{"path":"."}} — list a directory (relative to /workspace; "." for root).',
        '2. {"action":"tool","tool":"read_file","args":{"path":"package.json"}} — read a file.',
        '3. {"action":"tool","tool":"edit_file","args":{"path":"server/.env","content":"<full new file content>"}} — overwrite a file (creates missing dirs). Used to fix configs, scripts, missing files.',
        '4. {"action":"tool","tool":"run_shell","args":{"cmd":"npm install"}} — run a shell command in /workspace and see exit code + output. Use for install/build/start/test/curl.',
        'CRITICAL execution rules:',
        '- Every run_shell call is a FRESH shell (working dir resets to /workspace each time). Use `cd <dir> && <cmd>` inside ONE call when you need a subdirectory. Background processes started with `&` keep running in the VM.',
        '- The serve command must start the app in the background and stay running. Use e.g. `export PORT=<port>; (cd server && npm start) > /tmp/serve.log 2>&1 & sleep 5; cat /tmp/serve.log`, then health-check with curl.',
        '- Keep the serve process alive even after your shell exits: start it with nohup / setsid and disown. Pick any free port (export PORT=<port> if the app reads it; prefer the default port when free) — the platform auto-detects the real app port for the preview, so do not waste rounds fighting over one specific port.',
        '- Verify with an actual HTTP request, not just "process started": `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/`. A 2xx/3xx/expected response means success.',
        '- FULL-STACK requirement: a root page 200 is NOT enough. If the project is frontend+backend (the frontend proxies /api to a local backend), the backend process MUST be running and reachable, or every browser page will be blank. Before outputting final, curl a REAL API route from the code yourself: 2xx/3xx/401 (auth required) / 405 (method mismatch) means the backend is alive; 5xx means the backend is down or cannot reach its database — start it / provision the DB / migrate, then re-check. The platform re-runs this check using the apiEndpoints / backendPort you report in your final answer and will REJECT a frontend-only success.',
        '- When a command fails, DO NOT just rerun it. Read the error, inspect files (read_file/list_dir), fix the root cause (edit_file), then retry.',
        // 改动 4 配套：CRITICAL 规则改为 per-subpackage —— 之前是整项目 boolean，
        // 会让 agent 在 monorepo 里把 server/node_modules 命中当作全 CACHED、跳过 web install。
        '- NEVER run install for the same sub-package twice. The DEPENDENCY CACHE block below is the authoritative per-sub-package install decision (platform-checked by mtime vs package.json / lockfile). If a sub-package is CACHED, skip its install; if STALE/MISSING/STALE_LOCK/STALE_PKG, you MUST install THAT sub-package exactly once. In a monorepo each sub-package is independent — installing the root does NOT cover subdirs unless the root has a "workspaces" / pnpm-workspace.yaml / yarn workspaces config.',
        '- NEVER run `npm run build` / `vite build` / `make` more than once. If the build artifact (web/dist, build/, out/) already exists and the source has not changed, SKIP rebuild and serve the existing artifact.',
        '- Do NOT waste rounds on environment inspection (`free -m`, `nproc`, `which`, `node -v`, `cat package.json`) — those were already provided. Only run a check if it directly unblocks a failing step.',
        'Deploy plan to execute:',
        JSON.stringify(plan?.steps || [], null, 2),
        '',
        (plan?.context?.successRun?.length
            ? [
                'PREVIOUS SUCCESSFUL RUN (from the last successful deploy of this project — follow it to go fast, verify each step still works):',
                plan.context.successRun.map((c) => `  - ${c}`).join('\n'),
                '- Execute these commands in order. Each one previously succeeded, so do NOT re-explore or wonder how to install/build/serve — just re-run them. Only deviate / fix if one actually fails (e.g. port already in use, dependency changed).',
                '- If the list contains DUPLICATE commands (e.g. `npm install` twice, or `npm run build` appears more than once), run each UNIQUE command only ONCE and skip the duplicates — they were historical retries, not required steps.',
                '',
            ].join('\n')
            : ''),
        'Config files to create/verify (from analysis; create/overwrite with edit_file as needed):',
        JSON.stringify(plan?.configFiles || [], null, 2),
        '',
        'Project structure (from analysis — DO NOT re-explore):',
        (plan?.context?.tree || '(none)'),
        '',
        (() => {
            // 改动 4：per-subpackage deps 状态。优先用 depsStatus（精确到子包），
            // 退化到旧 depsCached boolean。Stale sub-package 必须 install，否则缺包 → 运行时 fail。
            const ds = plan?.context?.depsStatus;
            if (ds && Object.keys(ds).length) {
                const lines = ['DEPENDENCY CACHE (per sub-package, platform-checked authoritative):'];
                let anyStale = false;
                for (const [k, v] of Object.entries(ds)) {
                    if (v === 'CACHED') {
                        lines.push(`  - ${k}: CACHED`);
                    } else {
                        lines.push(`  - ${k}: ${v}  → MUST install this sub-package (run: cd ${k} && <pm> install)`);
                        anyStale = true;
                    }
                }
                lines.push('');
                lines.push(anyStale
                    ? 'OVERALL: STALE — install the sub-packages marked above BEFORE build/serve. The plan\'s install steps (if any) should target these sub-packages; do not skip them.'
                    : 'OVERALL: CACHED — skip all install steps, go straight to build/serve.');
                return lines.join('\n');
            }
            return 'DEPENDENCY CACHE:\n' + (plan?.context?.depsCached
                ? '- The workspace already has node_modules installed and its package-manager lockfile is unchanged from the previous deploy. SKIP the install step and go straight to build/serve. Only reinstall if a later step actually fails with a missing-dependency error.'
                : '- Dependencies are NOT cached — run the install step normally.');
        })(),
        '',
        'IMPORTANT: The project has already been analyzed — structure, configs, the plan, and the project tree above are all provided. DO NOT call list_dir / read_file to explore the project or re-read files already covered (package.json, README, configs, server files). Execute the plan steps directly. Read a specific file ONLY if a step fails and you need its exact contents to fix it — never to re-discover what is already described above.',
        '',
        'Workflow:',
        '1. Run the prepare steps one by one (install deps, build, migrate, prisma generate, etc.). If the project needs native build deps, `apt-get update && apt-get install -y python3 build-essential` first.',
        '2. Start the full app (frontend + backend) on a port, then CONFIRM it is actually up with ONE curl: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/`. If it is 2xx/3xx, output your final answer IMMEDIATELY — do NOT curl the same port again.',
        '3. If you also see a `npm test` / test script that is quick, run it too and count it as tested.',
        '4. When a health check fails, READ the app log / error output to find the ROOT CAUSE (port in use, missing env/config, build or startup error) and fix it with edit_file / correct command — do not blindly rerun the same thing or keep checking the process. Iterate until the health check passes.',
        'RUNTIME ENGINE VERSION (MANDATORY): many modern repos pin a minimum runtime version (package.json "engines", .nvmrc, .tool-versions, .python-version, go.mod go directive). If install/build/start emits "Unsupported engine" / "engine ... wanted ... current ..." or the build exits 0 but produces NO output files (empty dist/), that is usually a silently-failing engine mismatch — DO NOT retry the same build. First check the pinned version (cat package.json engines / .nvmrc / .tool-versions / .python-version), then install it: for Node use `nvm install <ver> && nvm use <ver>` (or `n` / `fnm`), for Python use `pyenv install <ver>` or apt-get the matching version, then rerun install + build WITH that runtime in PATH. Before declaring a build successful, verify the expected artifacts actually exist (e.g. `ls web/dist`, `ls build/`) — a 0-exit build with no artifacts is a FAILURE, not success.',
        'OUTPUT SIZE RULE (MANDATORY): a TOOL CALL must be ONE compact JSON under 800 characters. NEVER paste file contents, logs or commands into your JSON — use read_file / edit_file / run_shell tools for that. If you were about to write a long reply, STOP and output the short JSON tool call instead. The FINAL answer may be up to 4000 characters so you can include the key error output in finalStderr.',
        'HEALTH CHECK (MANDATORY):',
        '- Confirm the app is up with ONE successful curl (2xx/3xx). Then IMMEDIATELY output your final answer.',
        '- Never curl / pgrep / ps the same port repeatedly. Repeating curls wastes rounds — once a single 2xx/3xx curl succeeds, the platform performs the final port discovery and health verification itself.',
        '- If a curl fails, do NOT just curl again — read the log, fix the root cause, restart if needed, then curl ONCE to confirm.',
        'SERVING RULES (MANDATORY):',
        '- Exception for plain static sites: IF the project really is a static site — its root has a NON-EMPTY index.html and there is NO package.json / build tooling / backend — then serving that directory is CORRECT (e.g. `python3 -m http.server` or `npx serve .`). This is the ONLY case where serving a workspace dir is allowed.',
        '- In EVERY other case: NEVER serve the raw workspace root or source directories (no `npx serve .`, `serve -s .`, `python3 -m http.server`, `caddy file-server` at /workspace or inside src/). That would expose source code and is a FAILURE. Serve ONLY a built artifact directory (e.g. `web/dist`, `build/`, `out/`) or the real app entry; for a monorepo, build and serve the frontend app under the correct subdir, and start the backend too when present.',
        '- The sandbox may already run its OWN placeholder services on ports 3000 and 5173 — they are NOT your app. Start your app on a free port and confirm YOUR process is the one answering (pgrep -af "<serve cmd>" + curl its port several times).',
        '- A "directory listing" page (titles like "Index of /" or "Directory listing for /") or an EMPTY index.html is NOT a valid app — treat it as FAILURE. Never fake a pass with a static file server.',
        '- Health check must return the REAL application content (HTML with a <title> and app markup, or the backend API JSON). A 200 on a file listing or an empty page is NOT success.',
        '- If you cannot install deps / build / start the app for real, report ok:false with the real reason. Do NOT fake success to satisfy the check.',
        'MONOREPO / WEB APP DISCOVERY (MANDATORY): if the repo root is a monorepo (has apps/*, packages/*, or a workspace root with sub-projects), do NOT serve whatever static index.html happens to exist at the root, in docs/, website/, or anywhere else — that is usually a docs site / landing page, NOT the real application. The REAL web app is the subproject whose package.json has a frontend build/dev script (`vite build` / `dev: vite` / `npm run dev` / `next build` / `nuxt build` / `react-scripts build`), typically under apps/web, apps/frontend, apps/ui, packages/web, or a dedicated client/ dir. Find that subproject, install its deps, build it, and serve its dist output. If the app also has a backend (server/, api/, apps/api, apps/cli), start it too and verify a real API endpoint responds. Serving a docs site (vitepress/docusaurus/docsify etc.) or a project landing page instead of the actual app is a FAILURE even if it returns 200.',
        'DATABASE SETUP (MANDATORY when the backend needs a database):',
        (plan?.context?.dbReady
            ? (plan?.context?.dbName
                ? `- PostgreSQL is ALREADY installed, run, and the database \`${plan.context.dbName}\` (user \`${plan.context.dbUser}\`) has ALREADY been created by the platform. SKIP installing PG / creating user / creating database. Point the app at 127.0.0.1 and run migrations directly — do NOT run any CREATE USER / CREATE DATABASE.`
                : '- PostgreSQL is ALREADY installed and started by the platform inside this sandbox. SKIP installing/starting it. Create the user/database only if the app config requires names that do not exist yet, then run migrations.')
            : '- Detect it: the backend uses pg/postgres (server/package.json deps, a db/ dir, or DATABASE_URL / POSTGRES_* in .env files). A backend whose DB-dependent endpoints hang or error is NOT a passing app.'),
        ...(plan?.context?.dbReady ? [] : [
            '- BEFORE apt install, clear stale apt/dpkg locks left by previous runs: `pkill -9 apt-get; pkill -9 dpkg; sleep 1; rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock; sleep 1`. Then `apt-get update -qq && apt-get install -y postgresql postgresql-contrib`. If a lock error still appears, retry the clear+install once.',
            '- Install and start PostgreSQL INSIDE the sandbox: after install run `service postgresql start` (or `pg_ctlcluster <ver> main start`).',
        ]),
        '- Create a user + database matching the app config. Run psql as the postgres user via `su postgres -c "psql -c \\"...\\""` — in this sandbox `su postgres -c` is the CORRECT way; do NOT waste rounds trying `sudo -u postgres` / `runuser -u postgres` variants. Create the user, then `CREATE DATABASE mydb OWNER myuser;`, and run each CREATE only ONCE.',
        '- MIGRATIONS / PRE-START SCRIPTS RUN EXACTLY ONCE: `alembic upgrade`, `npm run db:migrate`, `prestart.sh`, `prisma migrate` etc. are typically idempotent or only need ONE successful run. Before running one, check whether it has already succeeded (table exists / previous exit=0 with no error in output / `alembic current` already up to date); if yes, SKIP it. NEVER re-run the same migration/prestart command just because a later step failed for an unrelated reason.',
        '- Create the tables: look for schema.sql / init.sql / migrations / README "Database Schema" section / the SQL in code (db/*.db.js), and run the DDL so real queries work.',
        '- Point the app at the LOCAL database: edit server/.env (and client env if needed) so POSTGRES_HOST/DATABASE_URL use 127.0.0.1 (or localhost), with the user/password/database you created.',
        '- SECURITY (MANDATORY) — the sandbox shares a network with the HOST machine. NEVER point the app at a database on the host or anywhere outside the sandbox: no host / LAN IP (e.g. 172.28.x.x, 10.x.x.x, 192.168.x.x), no cloud hostname. The database MUST run INSIDE the sandbox at 127.0.0.1. If a repo .env already contains a DATABASE_URL / POSTGRES_HOST, always re-point its host to 127.0.0.1 and start local PostgreSQL. Using the host database is a hard FAILURE: it breaks isolation and lets the preview authenticate with host accounts.',
        '- Then start the backend and verify a DB-backed endpoint actually returns rows (e.g. GET /api/... that reads from the DB), not just an empty 200 from the root.',
        'FRONTEND API BASE (MANDATORY): if the frontend calls its backend through an env like VITE_API_URL / REACT_APP_API_URL / NEXT_PUBLIC_API_URL / axios baseURL, set it to a RELATIVE path so it works under the preview sub-path (e.g. build with VITE_API_URL=./api, or use /api if the backend routes are under /api). NEVER leave it as an absolute http://localhost:... address — the user browser cannot reach the sandbox localhost. Check the frontend config (.env / axios.config / build script) and REBUILD the frontend with the correct relative API base if the current dist has no/absolute baseURL. In the sandbox, verify the frontend-to-backend path works: curl -s http://127.0.0.1:<frontendPort>/api/... returns the backend JSON, not an HTML page.',
        'SELF-CONTAINED FULLSTACK SERVERS: some backends also serve their own built frontend, so a single port answers both HTML and API. If the project works that way:',
        '- Detect: the backend reads a built frontend dir (dist / public / build) and serves it, and there is no separate frontend dev server needed for the app to be usable.',
        '- Build the frontend into the location the server expects (check its config / README for the expected output dir), then start the backend WITH the config it needs — many servers do NOT auto-load their .env, so source it or export the required DATABASE_URL etc. (e.g. `cd server && set -a && . ./.env && set +a && npm start`).',
        '- The app answers on the backend port: verify it returns real HTML for / and JSON for an API endpoint. That port IS the app — do not start a second static file server on top of it.',
        'API ENDPOINTS REPORT (important for full-stack apps): the platform runs a code-side backend check after your final answer to detect a dead backend (root 200 but backend dead = white-screen app). It uses ONLY what you report — there is no path guessing. Include "apiEndpoints": 1-3 REAL API paths that pass through the frontend proxy to the backend — read them from the code (router definitions, next.config rewrites destination, vite proxy target, axios/fetch baseURL + routes, e.g. "/api/v1/auth/login"). GET is used for probing, so a method-restricted route answering 405 still counts as alive. If you cannot name concrete API paths but know the backend listens on a fixed port (e.g. rewrites destination http://localhost:8080, vite proxy target), include "backendPort": 8080 instead — the platform only checks that the port is LISTENING. Report neither field only if the app truly has no backend.',
        'When the app responds correctly, output your final answer:',
        '{"action":"final","result":{"ok":true,"tested":["npm install","npm run build","curl /"],"apiEndpoints":["/api/v1/auth/login"],"backendPort":8080,"finalStderr":"","summary":"<1-2 sentences>"}}',
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

async function runVerifyWithAgent({ workspacePath, runtimeRef, plan, projectType, onRound, onSubstage, resume, isAborted }) {
    const defaultPort = projectType?.defaultPort || 3000;
    // Live-probe the sandbox toolchain so the LLM is told the truth about
    // what is and isn't installed. The previous prompt claimed
    // "node/python/go/cargo" were all available — that was a lie on
    // boxlite (only node ships in the base image) and wasted 14 minutes
    // per deploy trying to go build with no go binary.
    const toolchain = await detectRuntimeToolchain(runtimeRef, workspacePath).catch(() => []);
    let messages;
    let roundStart = 0;

    // Create an AbortSignal that can be triggered by isAborted()
    const abortController = new AbortController();
    const abortSignal = abortController.signal;
    const checkAborted = () => {
        if (isAborted?.()) {
            abortController.abort();
            return true;
        }
        return false;
    };

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
            { role: 'system', content: buildSystemPrompt(plan, toolchain) },
            { role: 'user', content: initialUser },
        ];
    }

    let lastResult = null;
    let prevToolSig = '';
    let repeatCount = 0;
    const trail = [];
    // 泛化防重复：按"语义化命令签名"记录最近一次执行及其成败（agent 换日志文件名也拦得住）。
    // 同一条核心命令（install/build/start）已跑过且期间没有 edit_file → 阻止重复执行。
    const ranCmds = new Map();
    let lastEditRound = -1;
    let lastNudgeRound = -1;
    // API 健康探测 nudge 计数：根路径 200 但 API 5xx（前端代理的后端没起）时，
    // 先推回给 agent 自修复；超过上限才硬失败，避免纯静态站被误伤或无限循环。
    let apiNudges = 0;
    const MAX_API_NUDGES = 2;
    // 阶段 B 内子阶段上报（prepare/install/build/serve/check/fix）：让前端分步展示，
    // 驱动信号来自每轮实际执行的工具/命令，不影响 verify 逻辑本身。
    let lastSubstage = null;
    const reportSubstage = (s, hint) => {
        if (s && s !== lastSubstage) {
            lastSubstage = s;
            if (onSubstage) onSubstage(s, hint);
        }
    };

    for (let round = roundStart; round < MAX_AGENT_ROUNDS; round++) {
        if (isAborted?.()) {
            return { ok: false, source: 'ai', aborted: true, warning: '部署已中止', finalStderr: '', tested: [], trail, messages: trimContext(messages), roundsUsed: round };
        }
        if (onRound) onRound(round);
        if (checkAborted()) {
            return { ok: false, source: 'ai', aborted: true, warning: '部署已中止', finalStderr: '', tested: [], trail, messages: trimContext(messages), roundsUsed: round };
        }
        const llmResult = await callLlm(messages, abortSignal);
        if (checkAborted()) {
            return { ok: false, source: 'ai', aborted: true, warning: '部署已中止', finalStderr: '', tested: [], trail, messages: trimContext(messages), roundsUsed: round };
        }
        if (!llmResult.ok) {
            return { ok: false, source: 'ai', warning: llmResult.warning, finalStderr: '', tested: [], trail, messages: trimContext(messages) };
        }
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
            // 子阶段推断：仅用于前端分步展示，不影响 verify 逻辑。优先按工具类型/命令关键字
            // 归类（prepare=装依赖、build=构建、serve=起服务、check=健康检查、fix=改代码）。
            if (onSubstage) {
                const rawCmd = String(parsed.tool === 'run_shell' ? (parsed.args?.cmd || parsed.args?.command || '') : '');
                const norm = rawCmd.toLowerCase();
                let sub = 'check';
                if (parsed.tool === 'edit_file' || parsed.tool === 'write_file' || parsed.tool === 'create_file') sub = 'fix';
                else if (parsed.tool === 'run_shell') {
                    if (/(install|add|ci|setup|bundle|composer|apt-get|apk add|go mod download|pip install|pnpm i\b|npm i\b|corepack)/.test(norm)) sub = 'prepare';
                    else if (/(build|bundle|tsc|transpile|vite build|next build|nuxt build|make\b|gcc|webpack)/.test(norm)) sub = 'build';
                    else if (/(serve|start|run (dev|prod)|uvicorn|gunicorn|pm2|forever|\.\/bin|nohup|setsid|listen|port)/.test(norm)) sub = 'serve';
                    else if (/(curl|wget|health|check|nc -z|pgrep|ps aux|ss -t)/.test(norm)) sub = 'check';
                }
                reportSubstage(sub, rawCmd.slice(0, 120));
            }
            // 记录编辑轮次：edit_file 之后允许重新构建/重装（源已变化，重复执行是合理的）
            if (parsed.tool === 'edit_file') {
                lastEditRound = round;
            }
            // 泛化防自杀式杀进程：pkill/kill 指向 install/build 类进程时阻止并提示等待
            if (parsed.tool === 'run_shell' && isKillingOwnInstall(parsed.args?.cmd)) {
                trail.push({ round, action: 'kill_install', cmd: summarizeArgs(parsed.args) });
                messages.push({
                    role: 'user',
                    content: 'Your command kills an install/build process (npm/pnpm/pip/apt/go …). If that install is still running, KILLING it then re-running wastes the whole install. Wait for it to finish (poll the process or the generated node_modules/site-packages dirs) instead of killing it. Only kill processes you are sure are stuck for minutes.',
                });
                continue;
            }
            // 泛化命令级去重：同一条核心命令（install/build/start）刚跑过、期间无 edit_file → 阻止重复执行，
            // 而不是让 agent 换日志文件名再跑一次。成功过的命令还可能是"产物没找到"型循环的根因。
            let dupSig = null;
            if (parsed.tool === 'run_shell') {
                dupSig = normalizeCmdSig(parsed.args?.cmd);
                const prev = dupSig ? ranCmds.get(dupSig) : null;
                if (prev && lastEditRound < prev.round) {
                    trail.push({ round, action: 'repeat_cmd', cmd: dupSig, prevOk: prev.ok });
                    messages.push({
                        role: 'user',
                        content: prev.ok
                            ? `You already ran \`${dupSig}\` successfully earlier and have not edited any files since. Do NOT re-run it. If its output is missing, read the build/dev script (package.json / scripts/*) to find where it outputs, then serve that; do not rebuild.`
                            : `You already ran \`${dupSig}\` and it failed, with no file edits since. Re-running the same command won't fix it. Inspect the previous error, fix the root cause (edit_file), or start the app / output final with the real reason.`,
                    });
                    prevToolSig = '';
                    repeatCount = 0;
                    continue;
                }
            }
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
            // 记录命令结果：exit=0 视为成功（用于后续去重提示"已成功过"）
            if (parsed.tool === 'run_shell' && dupSig) {
                const m = String(out).match(/^exit=(\d+)/);
                ranCmds.set(dupSig, { round, ok: !!m && m[1] === '0' });
            }
            const trailEntry = { round, action: 'tool', tool: parsed.tool, args: summarizeArgs(parsed.args), out: summarize(out) };
            // 保留完整命令，供成功后提取「成功执行轨迹」复用（summarizeArgs 会截断长命令）
            if (parsed.tool === 'run_shell') trailEntry.cmd = String(parsed.args?.cmd || '');
            trail.push(trailEntry);
            console.error(`[analyzeVerify] round ${round}: tool=${parsed.tool} args=${JSON.stringify(summarizeArgs(parsed.args))} out_len=${String(out).length}`);
            messages.push({ role: 'user', content: `Tool "${parsed.tool}" result:\n${out}` });
            messages = trimContext(messages);
            // 收敛兜底 nudge：命令级去重已处理"重复执行同一条命令"，这里只在 agent 长时间
            // 没有任何文件修改（即一直空转探查/尝试，而非在修复）时提醒收敛，避免误伤正常诊断。
            // 阈值放宽到 30 轮且最近 12 轮无 edit_file：复杂 monorepo 前十几轮都在探明结构/构建产物，
            // 过早 nudge 会让模型提前输出 final 失败，反而比超时更糟。
            if (round >= roundStart + 30 && round - lastEditRound >= 12 && round - lastNudgeRound >= 8) {
                lastNudgeRound = round;
                messages.push({
                    role: 'user',
                    content: `You have been working for ${round + 1 - roundStart} rounds and have not edited any file for a long time. If you are stuck repeating exploration/build attempts, STOP: locate the root cause and fix it with edit_file, then rebuild. If the app is up, output final with ok:true and its port; if it cannot be fixed, output final with ok:false and the REAL error in finalStderr.`,
                });
                messages = trimContext(messages);
            }
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
            // Code-side constraint: re-probe the toolchain right before
            // declaring victory. The LLM may have claimed the install
            // worked but apt-get can silently fail on lock contention or
            // network blips. If a tool the plan needed is still missing,
            // refuse success — the caller will see a real failure reason
            // instead of "agent says ok but server can't start".
            const toolsStillMissing = await findMissingPlanTools(plan, runtimeRef, workspacePath);
            if (toolsStillMissing.length) {
                trail.push({ round, action: 'toolchain_still_missing', tools: toolsStillMissing });
                lastResult = {
                    ...lastResult,
                    ok: false,
                    warning: `tools still missing after verify: ${toolsStillMissing.map((t) => `${t.tool} (${t.reason})`).join(', ')}`,
                    finalStderr: `code-side toolchain check found ${toolsStillMissing.length} missing tool(s):\n${toolsStillMissing.map((t) => `  - ${t.tool}: ${t.reason}`).join('\n')}\n\n${lastResult.finalStderr || ''}`.slice(0, 4000),
                };
            }
            let appPort = null;
            if (ok && lastResult.ok) {
                const probe = await assertAppIsServed({ runtimeRef, workspacePath, preferredPort: defaultPort });
                if (!probe.ok) {
                    trail.push({ round, action: 'app_check_failed', reason: probe.reason });
                    const failedResult = {
                        ...lastResult,
                        ok: false,
                        warning: probe.reason,
                        finalStderr: `${probe.reason}\n${lastResult.finalStderr || ''}`.slice(0, 4000),
                    };
                    return { ...failedResult, source: 'ai', trail, messages: trimContext(messages), roundsUsed: round + 1 };
                }
                // API/后端健康探测：前端 200 但后端没起 = 前后端分离项目白屏根因。
                // 依据全部来自 agent 上报：apiEndpoints（HTTP 探测）或 backendPort（监听检查），
                // 无写死路径猜测。失败先 nudge 自修复（启动后端/补数据库/migrate），超限硬失败。
                const apiEndpoints = Array.isArray(r.apiEndpoints) ? r.apiEndpoints : [];
                const api = await probeApiHealth({ runtimeRef, workspacePath, port: probe.port, endpoints: apiEndpoints, backendPorts: r.backendPort });
                if (!api.ok) {
                    trail.push({ round, action: 'api_probe_failed', verdict: api.verdict, reason: api.reason, endpoints: api.endpoints, nudges: apiNudges });
                    console.error(`[analyzeVerify] round ${round}: API probe FAILED (nudge ${apiNudges + 1}/${MAX_API_NUDGES}, verdict=${api.verdict}, endpoints=${JSON.stringify(api.endpoints)}): ${api.reason}`);
                    if (apiNudges < MAX_API_NUDGES) {
                        apiNudges++;
                        const fixHint = api.verdict === 'backend_not_listening'
                            ? `The backend port(s) ${api.endpoints.join(', ')} are NOT listening. Start the backend process first (find the entrypoint: server/, api/, go.mod main, Dockerfile CMD; e.g. nohup ./bin/server > /tmp/backend.log 2>&1 &). If the port in your backendPort was wrong, read the frontend proxy config (next.config rewrites / vite proxy / axios baseURL) for the real port and report it.`
                            : `The API endpoints return 5xx — the backend behind the frontend is NOT running (or cannot reach its database). Fix it: (1) start the backend (server/, api/, go.mod main, Dockerfile CMD; e.g. nohup ./bin/server > /tmp/backend.log 2>&1 &); (2) if it needs PostgreSQL/MySQL, ensure the DB is running (service postgresql start), create the user/database from DATABASE_URL, and run migrations; (3) confirm with curl that the API endpoints (${api.endpoints.join(', ')}) return non-5xx — adjust apiEndpoints in your final answer if the paths were wrong.`;
                        messages.push({
                            role: 'user',
                            content: `Code-side health check REJECTED your final answer: the root page serves HTTP 200, but the backend is down — ${api.reason} ${fixHint} Then output final again with ok:true.`,
                        });
                        messages = trimContext(messages);
                        continue;
                    }
                    const failedResult = {
                        ...lastResult,
                        ok: false,
                        warning: api.reason,
                        finalStderr: `${api.reason}\n${lastResult.finalStderr || ''}`.slice(0, 4000),
                    };
                    return { ...failedResult, source: 'ai', trail, messages: trimContext(messages), roundsUsed: round + 1 };
                }
                appPort = probe.port;
                // 探测结果统一入 trail（不推给 LLM，省 token）：agent 上报端点全 404 时的
                // inconclusive 场景可事后排查（路径拼错 / 代理前缀不对 / GET 不可达）。
                trail.push({ round, action: 'api_probe', verdict: api.verdict, endpoints: api.endpoints, probed: api.probed });
            }
            return { ...lastResult, appPort, source: 'ai', warning: ok ? '' : 'verify agent reported failure', trail, messages: trimContext(messages), roundsUsed: round + 1 };
        }
        trail.push({ round, action: 'unknown', name: String(parsed.action).slice(0, 50) });
        messages.push({ role: 'user', content: 'Unknown action. Respond with a single tool call or the final answer JSON.' });
    }

    // 超轮数且没有 final 答案：记录完整活动轨迹，并做一次"按计划直跑"兜底，
    // 拿到真实失败步骤 + stderr（或确认服务其实可用），而不是只给一句笼统的报错。
    const fallbackResult = await runVerifyWithoutLlm({ workspacePath, runtimeRef, plan, projectType }).catch(() => null);
    let fallbackOk = !!fallbackResult?.ok;
    let fallbackFailed = fallbackResult && !fallbackResult.ok;
    let concreteStderr = fallbackFailed
        ? fallbackResult.finalStderr
        : (lastResult?.finalStderr || '');
    let appPort = fallbackResult?.appPort || null;
    if (fallbackOk) {
        const probe = await assertAppIsServed({ runtimeRef, workspacePath, preferredPort: defaultPort });
        if (!probe.ok) {
            fallbackOk = false;
            fallbackFailed = true;
            concreteStderr = probe.reason;
        } else {
            appPort = probe.port;
        }
    }
    const ok = lastResult ? lastResult.ok : fallbackOk;
    console.error('[analyzeVerify] MAX ROUNDS reached; fallback ok=', fallbackOk, 'appPort=', appPort, 'trail=', JSON.stringify(trail.slice(-24)));
    return {
        ...(lastResult || { ok, tested: [], finalStderr: '', summary: '' }),
        ok,
        appPort,
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
            const cmd = `export PORT=${port}; ${serveStep.command} > /tmp/serve.log 2>&1 & sleep 6; curl -s -m 8 -w "\\n__HTTPCODE__:%{http_code}" http://127.0.0.1:${port}/ | head -c 1500 || true`;
            const r = await runtime.exec.exec('sh', ['-c', cmd], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 30000 });
            const out = String(r.stdout || '');
            const codeMatch = out.match(/__HTTPCODE__:(\d{3})/);
            const code = codeMatch ? codeMatch[1] : '000';
            const body = out.replace(/__HTTPCODE__:\d{3}/, '').trim();
            tested.push(`serve probe: http=${code}`);
            const ok2xx = code.startsWith('2') || code.startsWith('3');
            const boxDefaultPorts = [Number(process.env.BOXLITE_DEFAULT_PREVIEW_PORT || 3000), 5173];
            const isBoxDefaultPort = port === 5173 || (boxDefaultPorts.includes(port) && isBoxDefaultPage(body));
            if (ok2xx && (isDirectoryListing(body) || isBoxDefaultPort || !body)) {
                const log = await runtime.exec.exec('sh', ['-c', `cat /tmp/serve.log 2>&1 | tail -60`], {}, { runtimeRef, cwd: workspacePath });
                return { ok: false, source: 'shell', tested, finalStderr: String(log.stdout || '').slice(0, 4000), warning: 'served directory listing / box default page / empty, not the app' };
            }
            if (ok2xx) {
                // 无 LLM 兜底路径：没有 agent 上报的 apiEndpoints/backendPort，无法做
                // 后端探测（探测依据只来自 agent 上报，不做写死路径猜测），仅根路径检查。
                return { ok: true, source: 'shell', tested, finalStderr: '', warning: '', appPort: port };
            }
            const log = await runtime.exec.exec('sh', ['-c', `cat /tmp/serve.log 2>&1 | tail -60`], {}, { runtimeRef, cwd: workspacePath });
            return { ok: false, source: 'shell', tested, finalStderr: String(log.stdout || '').slice(0, 4000), warning: 'app did not respond to health check' };
        }
        return { ok: true, source: 'shell', tested, finalStderr: '', warning: '' };
    } catch (e) {
        return { ok: false, source: 'shell', tested, finalStderr: `verify error: ${e.message}`, warning: e.message };
    }
}

async function analyzeProjectVerify({ workspacePath, runtimeRef, plan, projectType, onRound, onSubstage, resume, isAborted }) {
    if (!API_KEY || !API_URL) {
        return runVerifyWithoutLlm({ workspacePath, runtimeRef, plan, projectType });
    }
    return runVerifyWithAgent({ workspacePath, runtimeRef, plan, projectType, onRound, onSubstage, resume, isAborted });
}

module.exports = { analyzeProjectVerify, assertAppIsServed };
