const MODEL_CONTEXT_LENGTHS = {
    'glm-5.2': 1048576,
    'glm-5-2': 1048576,
    'glm-5.3': 1048576,
    'glm-5-3': 1048576,
    'deepseek-v4': 1048576,
    'kimi-k2': 256000,
    'kimi-k3': 256000,
    'claude-sonnet': 200000,
    'claude-opus': 200000,
    'gpt-4o': 128000,
    'gpt-4-turbo': 128000,
};

const DEFAULT_CONTEXT_LENGTH = 1048576;

function guessContextLength(modelId) {
    const lower = (modelId || '').toLowerCase();
    for (const [prefix, len] of Object.entries(MODEL_CONTEXT_LENGTHS)) {
        if (lower.includes(prefix)) return len;
    }
    return DEFAULT_CONTEXT_LENGTH;
}

module.exports = { guessContextLength, DEFAULT_CONTEXT_LENGTH };
