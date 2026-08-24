const AGENT_LIFECYCLE = {
    'kimi-code': {
        install: 'npm install -g @moonshot-ai/kimi-code',
        uninstall: 'npm uninstall -g @moonshot-ai/kimi-code',
        update: 'npm install -g @moonshot-ai/kimi-code@latest',
        npmPackage: '@moonshot-ai/kimi-code',
    },
    'claude-code': {
        install: 'npm install -g @anthropic-ai/claude-code',
        uninstall: 'npm uninstall -g @anthropic-ai/claude-code',
        update: 'npm install -g @anthropic-ai/claude-code@latest',
        npmPackage: '@anthropic-ai/claude-code',
    },
    'cursor': {
        install: 'curl https://cursor.com/install -fsS | bash',
        uninstall: 'rm -f "$HOME/.local/bin/cursor" "$HOME/.local/bin/cursor-agent" "$HOME/.local/bin/agent"',
        update: 'curl https://cursor.com/install -fsS | bash',
    },
    'amp': {
        install: 'curl -fsSL https://ampcode.com/install.sh | bash',
        uninstall: 'npm uninstall -g @ampcode/cli @sourcegraph/amp 2>/dev/null; rm -f "$HOME/.local/bin/amp"',
        update: 'amp update 2>/dev/null || curl -fsSL https://ampcode.com/install.sh | bash',
        npmPackage: '@ampcode/cli',
    },
    'droid': {
        install: 'curl -fsSL https://app.factory.ai/cli | sh',
        uninstall: 'npm uninstall -g @factory/cli droid 2>/dev/null; rm -f "$HOME/.local/bin/droid" "$HOME/.local/bin/factoryd"',
        update: 'curl -fsSL https://app.factory.ai/cli | sh',
        npmPackage: '@factory/cli',
    },
    'commandcode': {
        install: 'npm install -g command-code@latest',
        uninstall: 'npm uninstall -g command-code',
        update: 'npm install -g command-code@latest',
        npmPackage: 'command-code',
    },
    'hermes': {
        preInstall: 'rm -rf "$HOME/.hermes/hermes-agent" "$HOME/.hermes"/hermes-agent.broken-* 2>/dev/null; true',
        install: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-setup',
        uninstall: 'rm -rf "$HOME/.hermes"; rm -f "$HOME/.local/bin/hermes"',
        update: 'hermes update',
    },
    'openclaw': {
        install: 'npm install -g openclaw@latest',
        uninstall: 'npm uninstall -g openclaw; rm -rf "$HOME/.openclaw"',
        update: 'npm install -g openclaw@latest',
        npmPackage: 'openclaw',
    },
    'opencode': {
        install: 'curl -fsSL https://opencode.ai/install | bash',
        uninstall: 'npm uninstall -g opencode-ai 2>/dev/null; rm -f "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode"',
        update: 'npm install -g opencode-ai@latest',
        npmPackage: 'opencode-ai',
    },
    'cline': {
        install: 'npm install -g cline@3.0.55',
        uninstall: 'npm uninstall -g cline',
        update: 'npm install -g cline@3.0.55',
        npmPackage: 'cline',
    },
    'codebuddy': {
        install: 'npm install -g @tencent-ai/codebuddy-code',
        uninstall: 'npm uninstall -g @tencent-ai/codebuddy-code',
        update: 'npm install -g @tencent-ai/codebuddy-code@latest',
        npmPackage: '@tencent-ai/codebuddy-code',
    },
    'glm-agent': {
        install: 'npm install -g @guizmo-ai/zai-cli',
        uninstall: 'npm uninstall -g @guizmo-ai/zai-cli',
        update: 'npm install -g @guizmo-ai/zai-cli@latest',
        npmPackage: '@guizmo-ai/zai-cli',
    },
    'qoder': {
        install: 'npm install -g @qoder-ai/qodercli',
        uninstall: 'npm uninstall -g @qoder-ai/qodercli',
        update: 'npm install -g @qoder-ai/qodercli@latest',
        npmPackage: '@qoder-ai/qodercli',
    },
    'qwen-code': {
        install: 'npm install -g @qwen-code/qwen-code@latest',
        uninstall: 'npm uninstall -g @qwen-code/qwen-code',
        update: 'npm install -g @qwen-code/qwen-code@latest',
        npmPackage: '@qwen-code/qwen-code',
    },
    'minimax-cli': {
        install: 'npm install -g mmx-cli',
        uninstall: 'npm uninstall -g mmx-cli',
        update: 'npm install -g mmx-cli@latest',
        npmPackage: 'mmx-cli',
    },
    'pi': {
        install: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
        uninstall: 'npm uninstall -g @earendil-works/pi-coding-agent',
        update: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest',
        npmPackage: '@earendil-works/pi-coding-agent',
    },
    'github-copilot': {
        install: 'npm install -g @github/copilot',
        uninstall: 'npm uninstall -g @github/copilot',
        update: 'npm install -g @github/copilot@latest',
        npmPackage: '@github/copilot',
    },
};

function getManifest(agentId, cmd) {
    if (AGENT_LIFECYCLE[agentId]) return AGENT_LIFECYCLE[agentId];
    const pkg = cmd || agentId;
    return {
        install: `npm install -g ${pkg}`,
        uninstall: `npm uninstall -g ${pkg}`,
        update: `npm install -g ${pkg}@latest`,
        npmPackage: pkg,
    };
}

function getInstallCommand(agentId) {
    return getManifest(agentId).install;
}

module.exports = {
    AGENT_LIFECYCLE,
    getManifest,
    getInstallCommand,
};
