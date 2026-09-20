const path = require('path');

/**
 * Pre-approve a custom API key in claude-code's .claude.json so that
 * claude does not show the "Detected a custom API key" confirmation
 * prompt on startup.  Without this, --continue is blocked because
 * claude waits for user input on the confirmation screen.
 */
async function ensureClaudeApiKeyApproved({ runtime, runtimeRef, stateDirPath, apiKey }) {
    if (!stateDirPath || !apiKey) return;
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

    // Check if already approved
    const approved = config.customApiKeyResponses?.approved || [];
    if (approved.includes(apiKey)) return;

    // Add to approved list
    if (!config.customApiKeyResponses) {
        config.customApiKeyResponses = { approved: [], rejected: [] };
    }
    if (!Array.isArray(config.customApiKeyResponses.approved)) {
        config.customApiKeyResponses.approved = [];
    }
    if (!config.customApiKeyResponses.approved.includes(apiKey)) {
        config.customApiKeyResponses.approved.push(apiKey);
    }

    // Write back
    const jsonStr = JSON.stringify(config).replace(/'/g, "'\\''");
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
