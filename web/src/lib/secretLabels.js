import i18next from 'i18next';

/** Platform-wide keys (gateway / router; not tied to a single agent's env_required). */
export const PLATFORM_SECRET_KEYS = ['LLM_ROUTER_URL', 'LLM_ROUTER_API_KEY'];

export const SECRET_LABELS = {
  LLM_ROUTER_URL: 'Router Base URL',
  LLM_ROUTER_API_KEY: 'Router API Key',
  ANTHROPIC_API_KEY: 'Anthropic API Key',
  ANTHROPIC_BASE_URL: 'Anthropic Base URL',
  ANTHROPIC_AUTH_TOKEN: 'Anthropic Auth Token',
  OPENAI_API_KEY: 'OpenAI API Key',
  OPENAI_BASE_URL: 'OpenAI Base URL',
  OPENROUTER_API_KEY: 'OpenRouter API Key',
  OPENROUTER_BASE_URL: 'OpenRouter Base URL',
  KIMI_API_KEY: 'Kimi API Key',
  KIMI_BASE_URL: 'Kimi Base URL',
  AMP_API_KEY: 'AMP API Key',
  COHERE_API_KEY: 'Cohere API Key',
  HERMES_API_KEY: 'Hermes API Key',
  OPENCLAW_KEY: 'OpenClaw API Key',
  ZAI_API_KEY: 'Z.AI API Key',
  QODER_PERSONAL_ACCESS_TOKEN: 'Qoder Access Token',
  DASHSCOPE_API_KEY: 'DashScope API Key',
  MINIMAX_API_KEY: 'MiniMax API Key',
};

export const SECRET_PLACEHOLDERS = {
  KIMI_BASE_URL: 'https://api.moonshot.cn/v1',
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
};

export function getSecretLabel(key) {
  if (SECRET_LABELS[key]) return SECRET_LABELS[key];
  return key
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

export function getSecretPlaceholder(key, { saved = false } = {}) {
  if (saved) return i18next.t('settings:secret.unchanged_if_blank');
  if (SECRET_PLACEHOLDERS[key]) return SECRET_PLACEHOLDERS[key];
  return i18next.t('settings:secret.enter_label', { label: getSecretLabel(key) });
}

export function isSecretPasswordField(key) {
  return /KEY|TOKEN|SECRET/i.test(key);
}
