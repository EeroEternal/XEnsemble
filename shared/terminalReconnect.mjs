export const TERMINAL_AUTH_CLOSE_CODE = 4401;

const DEFAULT_MAX_RECONNECTS = 20;

const AUTH_FAILURE_PATTERN = /\b(?:401|invalid access token|access_token is required)\b/i;

export function isTerminalAuthFailure(failure) {
  if (!failure) return false;
  if (failure.code === TERMINAL_AUTH_CLOSE_CODE || failure.status === 401) return true;
  const text = [failure.message, failure.reason, failure.data]
    .filter(Boolean)
    .join(' ');
  return AUTH_FAILURE_PATTERN.test(text);
}

export function createTerminalReconnectState({
  maxAttempts = DEFAULT_MAX_RECONNECTS,
  baseDelayMs = 500,
  maxDelayMs = 5000,
} = {}) {
  let attempts = 0;
  let authenticated = false;

  return {
    socketOpened() {
      authenticated = false;
      return { attempts, authenticated };
    },

    authenticationSucceeded() {
      attempts = 0;
      authenticated = true;
      return { attempts, authenticated };
    },

    nextReconnect() {
      authenticated = false;
      if (attempts >= maxAttempts) {
        return { exhausted: true, attempt: attempts, maxAttempts, delayMs: null };
      }
      attempts += 1;
      return {
        exhausted: false,
        attempt: attempts,
        maxAttempts,
        delayMs: Math.min(baseDelayMs * attempts, maxDelayMs),
      };
    },

    snapshot() {
      return { attempts, authenticated, maxAttempts };
    },
  };
}

export async function refreshTokenForTerminalFailure(failure, refreshAccessToken) {
  const authFailure = isTerminalAuthFailure(failure);
  if (!authFailure) return { authFailure: false, refreshed: false, token: null };

  try {
    const token = await refreshAccessToken();
    return { authFailure: true, refreshed: Boolean(token), token: token || null };
  } catch (error) {
    return {
      authFailure: true,
      refreshed: false,
      token: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
