import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TERMINAL_AUTH_CLOSE_CODE,
  createTerminalReconnectState,
  refreshTokenForTerminalFailure,
} from './terminalReconnect.mjs';

describe('terminal reconnect state', () => {
  it('does not reset retry attempts when only the transport opens', () => {
    // 默认 maxAttempts 已从 5 提升到 20（7b41191 之后），本用例只验证
    // 「transport open 不重置计数」：用显式小预算让断言可穷尽。
    const state = createTerminalReconnectState({ maxAttempts: 5 });
    const displayedAttempts = [];

    for (let cycle = 0; cycle < 8; cycle += 1) {
      state.socketOpened();
      const next = state.nextReconnect();
      if (!next.exhausted) displayedAttempts.push(next.attempt);
    }

    assert.deepEqual(displayedAttempts, [1, 2, 3, 4, 5]);
    assert.equal(state.snapshot().attempts, 5);
  });

  it('resets attempts only after application authentication succeeds', () => {
    const state = createTerminalReconnectState();
    state.socketOpened();
    assert.equal(state.nextReconnect().attempt, 1);
    state.socketOpened();
    assert.equal(state.snapshot().attempts, 1);
    state.authenticationSucceeded();

    assert.equal(state.nextReconnect().attempt, 1);
  });

  it('refreshes a token for message, close-code, and HTTP-style auth failures', async () => {
    const failures = [
      { message: 'Invalid access token' },
      { code: TERMINAL_AUTH_CLOSE_CODE, reason: 'Invalid access token' },
      { status: 401 },
    ];
    let refreshCalls = 0;
    for (const failure of failures) {
      const result = await refreshTokenForTerminalFailure(failure, async () => {
        refreshCalls += 1;
        return `fresh-token-${refreshCalls}`;
      });
      assert.equal(result.refreshed, true);
    }

    assert.equal(refreshCalls, 3);
  });

  it('does not refresh tokens for ordinary transport failures', async () => {
    let refreshCalls = 0;
    const result = await refreshTokenForTerminalFailure(
      { code: 1006, reason: 'network lost' },
      async () => {
        refreshCalls += 1;
        return 'unused';
      },
    );

    assert.equal(result.authFailure, false);
    assert.equal(refreshCalls, 0);
  });
});
