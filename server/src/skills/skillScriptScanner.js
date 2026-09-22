/**
 * Skill 静态安全扫描（P0 安全治理第一版：纯规则黑名单，零依赖零 LLM）。
 *
 * 背景：OWASP Agentic Skills Top-10（AST02 供应链投毒）与 ClawHavoc 事件表明，
 * 市场分发的 SKILL.md + scripts 会以可执行载荷形式流入用户 workspace（还会进
 * git 仓库），必须在发布/导入/创建入口做最低限度的静态拦截。
 *
 * 分级：
 * - error   —— 明确恶意/高危模式，阻断发布与导入
 * - warning —— 可疑但存在合法场景，放行并在响应中提示作者自查
 *
 * 扫描对象：ERROR 级规则同时扫描 SKILL.md 正文与脚本——文档中嵌入的载荷同样
 * 会被 Agent 当作指令执行（DDIPE，arXiv:2604.03081）；WARNING 级只扫描脚本，
 * 因为文档里引用安装命令属常见合法说明。
 */

const SNIPPET_MAX = 120;

const RULES = [
    // ---- ERROR：阻断级 ----
    {
        id: 'pipe_to_shell',
        severity: 'error',
        message: '下载内容直接管道执行（curl/wget | sh）',
        patterns: [/(?:curl|wget)\b[^|;\n]{0,300}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/],
    },
    {
        id: 'reverse_shell',
        severity: 'error',
        message: '反弹 shell / 远程命令通道特征',
        patterns: [
            /\bnc\s+(?:-\S+\s+)*-e\b/,
            /\/dev\/tcp\//,
            /\b(?:bash|sh)\s+-i\b[^|\n]*>&/,
            /\bmkfifo\b[^;\n]*\bnc\b/,
        ],
    },
    {
        id: 'ssh_key_plant',
        severity: 'error',
        message: '写入或引用 SSH authorized_keys（常见提权/持久化手段）',
        patterns: [/authorized_keys/],
    },
    {
        id: 'credential_file_access',
        severity: 'error',
        message: '访问敏感凭证文件',
        patterns: [/~\/\.ssh|\/\.ssh\//, /\/etc\/shadow/, /\.aws\/credentials/],
    },
    {
        id: 'env_file_access',
        severity: 'error',
        message: '读取 .env 环境变量文件内容（典型密钥窃取手法）',
        patterns: [
            /(?:cat|type|more|less|cp|mv|Get-Content|curl|wget)\s+(?:-\S+\s+)*["']?[^"'\s|;&]*\.env\b/,
            /(?:readFile|readFileSync|read_text|open)\s*\(\s*["'`][^"'`]*\.env["'`]/,
        ],
    },
    {
        id: 'private_key_embed',
        severity: 'error',
        message: '包含 PEM 私钥内容',
        patterns: [/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
    },
    {
        id: 'hardcoded_api_key',
        severity: 'error',
        message: '硬编码 API 密钥 / 访问令牌',
        patterns: [
            /\bsk-[A-Za-z0-9]{20,}\b/,
            /\bghp_[A-Za-z0-9]{30,}\b/,
            /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
            /\bAKIA[0-9A-Z]{16}\b/,
            /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
            /\bglpat-[A-Za-z0-9_-]{20,}\b/,
        ],
    },
    {
        id: 'destructive_rm',
        severity: 'error',
        message: '对根目录 / 家目录的递归删除',
        patterns: [
            /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(?:"?\/"?\s*$|"?~"?(?:\/\s*)?$|\$HOME\s*$|\/\*)/,
        ],
    },
    {
        id: 'fork_bomb',
        severity: 'error',
        message: 'fork bomb（资源耗尽攻击）',
        patterns: [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/],
    },

    // ---- WARNING：提示级（仅扫描 scripts）----
    {
        id: 'eval_exec',
        severity: 'warning',
        message: '动态代码执行（eval/exec/Function 构造器）',
        patterns: [
            /\beval\s*\(/,
            /\bexec\s*\(/,
            /\bnew\s+Function\s*\(/,
            /__import__\s*\(/,
        ],
    },
    {
        id: 'base64_decode',
        severity: 'warning',
        message: 'base64 解码执行（常见混淆手段）',
        patterns: [/base64\s+(?:-d|--decode)\b/, /\batob\s*\(/, /FromBase64String/],
    },
    {
        id: 'plaintext_http',
        severity: 'warning',
        message: '使用明文 HTTP 传输（易被中间人篡改）',
        patterns: [/http:\/\/(?!localhost|127\.0\.0\.1)/],
    },
    {
        id: 'world_writable',
        severity: 'warning',
        message: 'chmod 777（全局可写）',
        patterns: [/chmod\s+(?:-\S+\s+)*777\b/],
    },
    {
        id: 'sudo_usage',
        severity: 'warning',
        message: '使用 sudo 提权',
        patterns: [/\bsudo\b/],
    },
    {
        id: 'crontab_persistence',
        severity: 'warning',
        message: 'crontab 持久化（定时任务写入）',
        patterns: [/crontab\s+-[ler]\b/, /\/etc\/cron\./],
    },
];

function trimSnippet(text) {
    const s = String(text || '').trim();
    return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX)}…` : s;
}

/**
 * 扫描 skill 内容与脚本。
 * @param {object} opts
 * @param {string} [opts.content] SKILL.md 全文
 * @param {Array<{path:string,content:string}>} [opts.scripts]
 * @param {Array<{path:string,content:string}>} [opts.files] 0046：references/ 与 assets/ 配套文件
 * @returns {{ ok: boolean, errors: Array, warnings: Array }}
 */
function scanSkill({ content, scripts = [], files = [] } = {}) {
    const findings = [];
    const seen = new Set();

    const scanText = (text, path, includeWarnings) => {
        const source = String(text || '');
        if (!source) return;
        for (const rule of RULES) {
            if (rule.severity === 'warning' && !includeWarnings) continue;
            const key = `${path}::${rule.id}`;
            if (seen.has(key)) continue;
            for (const re of rule.patterns) {
                const m = source.match(re);
                if (m) {
                    seen.add(key);
                    findings.push({
                        rule: rule.id,
                        severity: rule.severity,
                        path,
                        message: rule.message,
                        snippet: trimSnippet(m[0]),
                    });
                    break;
                }
            }
        }
    };

    // ERROR 级同时扫文档正文（DDIPE：文档中的代码示例会被 Agent 复用执行）
    scanText(content, 'SKILL.md', false);
    for (const s of Array.isArray(scripts) ? scripts : []) {
        scanText(s?.content, s?.path || 'scripts/script', true);
    }
    // 0046：references/ 与 assets/ 同为「文档型」载荷（模板/参考里嵌的代码示例
    // 会被 Agent 复用执行），故按 ERROR 级扫描，不触发 warning。
    for (const f of Array.isArray(files) ? files : []) {
        scanText(f?.content, f?.path || 'references/file', false);
    }

    const errors = findings.filter((f) => f.severity === 'error');
    const warnings = findings.filter((f) => f.severity === 'warning');
    return { ok: errors.length === 0, errors, warnings };
}

/**
 * 供 skillService 各写入口调用：error 级命中即抛 skill_script_blocked。
 * @returns {Array} warnings（放行但需提示作者）
 */
function assertSkillSafe({ content, scripts, files } = {}) {
    const scan = scanSkill({ content, scripts, files });
    if (!scan.ok) {
        const err = new Error(
            `skill contains blocked patterns: ${scan.errors.map((e) => `${e.path}:${e.rule}`).join(', ')}`,
        );
        err.code = 'skill_script_blocked';
        err.statusCode = 400;
        err.details = scan.errors;
        throw err;
    }
    return scan.warnings;
}

module.exports = { scanSkill, assertSkillSafe };
