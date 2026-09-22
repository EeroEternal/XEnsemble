import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TERMINAL_AUTH_CLOSE_CODE,
  createTerminalReconnectState,
  refreshTokenForTerminalFailure,
} from '../../../../shared/terminalReconnect.mjs';

describe('Desktop terminal reconnect protocol', () => {
  it('does not reset retries on WebSocket open', () => {
    // 默认 maxAttempts 已从 5 提升到 20，用显式小预算保持原断言语义。
    const state = createTerminalReconnectState({ maxAttempts: 5 });
    const attempts = [];
    for (let cycle = 0; cycle < 8; cycle += 1) {
      state.socketOpened();
      const next = state.nextReconnect();
      if (!next.exhausted) attempts.push(next.attempt);
    }
    assert.deepEqual(attempts, [1, 2, 3, 4, 5]);
  });

  it('refreshes the keychain-backed access token on auth close', async () => {
    let refreshCalls = 0;
    const result = await refreshTokenForTerminalFailure(
      { code: TERMINAL_AUTH_CLOSE_CODE },
      async () => {
        refreshCalls += 1;
        return 'desktop-fresh-token';
      },
    );
    assert.equal(refreshCalls, 1);
    assert.equal(result.token, 'desktop-fresh-token');
  });
});
