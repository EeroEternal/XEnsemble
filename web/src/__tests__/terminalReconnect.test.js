import { describe, expect, it, vi } from 'vitest';

import {
  TERMINAL_AUTH_CLOSE_CODE,
  createTerminalReconnectState,
  refreshTokenForTerminalFailure,
} from '../../../shared/terminalReconnect.mjs';

describe('terminal reconnect protocol', () => {
  it('counts authenticated-handshake failures across transport opens', () => {
    // 默认 maxAttempts 已从 5 提升到 20，用显式小预算保持原断言语义。
    const state = createTerminalReconnectState({ maxAttempts: 5 });
    const attempts = [];

    for (let cycle = 0; cycle < 8; cycle += 1) {
      state.socketOpened();
      const next = state.nextReconnect();
      if (!next.exhausted) attempts.push(next.attempt);
    }

    expect(attempts).toEqual([1, 2, 3, 4, 5]);
  });

  it('refreshes before reconnecting after an unauthorized close', async () => {
    const refresh = vi.fn().mockResolvedValue('fresh-access-token');

    const result = await refreshTokenForTerminalFailure(
      { code: TERMINAL_AUTH_CLOSE_CODE, reason: 'Invalid access token' },
      refresh,
    );

    expect(refresh).toHaveBeenCalledOnce();
    expect(result).toEqual({
      authFailure: true,
      refreshed: true,
      token: 'fresh-access-token',
    });
  });

  it('resets only when the server emits application ready', () => {
    const state = createTerminalReconnectState();
    state.socketOpened();
    state.nextReconnect();
    state.socketOpened();
    expect(state.snapshot().attempts).toBe(1);

    state.authenticationSucceeded();
    expect(state.snapshot()).toMatchObject({ attempts: 0, authenticated: true });
  });
});
