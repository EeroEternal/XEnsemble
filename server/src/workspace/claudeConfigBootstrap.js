const path = require('path');

/**
 * Pre-approve custom API key(s) in claude-code's .claude.json so that
 * claude does not show the "Detected a custom API key" confirmation
 * prompt on startup.  Without this, --continue is blocked because
 * claude waits for user input on the confirmation screen.
 *
 * 批准 ANTHROPIC_API_KEY 之外，还会把 ANTHROPIC_AUTH_TOKEN 的值一并写入
 * approved：环境里两者并存时（gateway 织入 / 用户 customEnv），claude 会
 * 对两个值分别弹确认，漏一个就卡在确认屏。
 *
 * @param {string|string[]} [apiKeys] 单个 key 或多个（调用方把实际生效的
 *   凭证值都传进来；值可能相同，函数内部去重）。
 */
async function ensureClaudeApiKeyApproved({ runtime, runtimeRef, stateDirPath, apiKeys, apiKey }) {
    if (!stateDirPath) return;
    // 兼容旧签名 apiKey（单值）；新代码统一传 apiKeys 数组
    const keys = [...new Set([apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [apiKeys])]
        .filter((k) => typeof k === 'string' && k.trim()))];
    if (keys.length === 0) return;
    const configPath = path.join(stateDirPath, '.claude.json');

    // Read current .claude.json via VM exec
    const readScript = `cat '${configPath}' 2>/dev/null || echo '{}'`;
    const readResult = await runtime.exec.exec(
        'sh', ['-c', readScript], {}, { runtimeRef, cwd: '/' },
    );
    let config;
    try {
        config = JSON.parse(readResult.stdout || '{}');
    } catch {
        config = {};
    }

    if (!config.customApiKeyResponses) {
        config.customApiKeyResponses = { approved: [], rejected: [] };
    }
    if (!Array.isArray(config.customApiKeyResponses.approved)) {
        config.customApiKeyResponses.approved = [];
    }

    const approved = config.customApiKeyResponses.approved;
    const missing = keys.filter((k) => !approved.includes(k));
    if (missing.length === 0) return;

    // Add to approved list
    approved.push(...missing);

    // Write back
    const writeScript = `cat > '${configPath}' << 'CLAUDE_JSON_EOF'
${JSON.stringify(config, null, 2)}
CLAUDE_JSON_EOF`;
    await runtime.exec.exec(
        'sh', ['-c', writeScript], {}, { runtimeRef, cwd: '/' },
    );
}

/**
 * Pre-seed claude-code's .claude.json so the first interactive launch skips the
 * onboarding flow (theme picker / trust-folder dialog). The per-session state
 * dir means every new session gets a fresh HOME — without this, unattended
 * sessions (LoopTask review mode) stall on the onboarding screen and the
 * injected task prompt is swallowed by it.
 */
async function ensureClaudeOnboardingCompleted({ runtime, runtimeRef, stateDirPath, cwd, theme = 'dark', log }) {
    if (!stateDirPath || !cwd) return;
    const configPath = path.join(stateDirPath, '.claude.json');

    const readResult = await runtime.exec.exec(
        'sh', ['-c', `cat '${configPath}' 2>/dev/null || echo '{}'`], {}, { runtimeRef, cwd: '/' },
    );
    let config;
    try {
        config = JSON.parse(readResult.stdout || '{}');
    } catch {
        config = {};
    }

    // 逐项按需补齐：已手动完成 onboarding 的目录不覆盖用户选的主题，
    // 但缺失的 bypass 接受标记/信任标记仍要补写
    let changed = false;
    if (!config.hasCompletedOnboarding) {
        config.hasCompletedOnboarding = true;
        changed = true;
    }
    if (!config.theme) {
        config.theme = theme;
        changed = true;
    }
    // --dangerously-skip-permissions 首次使用的一次性接受对话框：新状态目录没有
    // 这个标记，交互式首启会弹「Bypass Permissions … Yes, I accept」等确认，
    // 无人值守场景会卡住。任务配置自动批准时由调用方注入该 flag，这里预接受。
    if (!config.bypassPermissionsModeAccepted) {
        config.bypassPermissionsModeAccepted = true;
        changed = true;
    }
    // 工作区信任对话框按 cwd 记忆
    if (!config.projects || typeof config.projects !== 'object') config.projects = {};
    const projectEntry = (config.projects[cwd] && typeof config.projects[cwd] === 'object')
        ? config.projects[cwd]
        : {};
    if (projectEntry.hasTrustDialogAccepted !== true) {
        changed = true;
    }
    config.projects[cwd] = {
        ...projectEntry,
        hasTrustDialogAccepted: true,
        allowedTools: projectEntry.allowedTools || [],
    };

    if (!changed) return;

    const writeScript = `cat > '${configPath}' << 'CLAUDE_JSON_EOF'\n${JSON.stringify(config, null, 2)}\nCLAUDE_JSON_EOF`;
    await runtime.exec.exec(
        'sh', ['-c', writeScript], {}, { runtimeRef, cwd: '/' },
    );
    log?.info?.({ stateDirPath }, '[claude-bootstrap] onboarding seeded (theme + workspace trust)');
}

module.exports = { ensureClaudeApiKeyApproved, ensureClaudeOnboardingCompleted };
