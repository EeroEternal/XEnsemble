import { describe, it, expect, beforeEach } from 'vitest';
import {
  shouldNotifyTuiTheme,
  resetTuiThemeNotification,
} from '@/lib/terminalThemeNotify';

const GITHUB_DARK = '\x1b]10;rgb:c9c9/d1d1/d9d9\x1b\\\x1b]11;rgb:0d0d/1111/1717\x1b\\\x1b[?997;2n';
const DRACULA = '\x1b]10;rgb:f8f8/f8f8/f2f2\x1b\\\x1b]11;rgb:2828/2a2a/3636\x1b\\\x1b[?997;2n';

describe('terminal theme notification', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('never sends on first sighting (session switch must not inject bytes)', () => {
    expect(shouldNotifyTuiTheme('sess_a', GITHUB_DARK)).toBe(false);
    // 再次「看到同一会话」（组件重新挂载、重连、无关重渲染）也不发送
    expect(shouldNotifyTuiTheme('sess_a', GITHUB_DARK)).toBe(false);
    expect(shouldNotifyTuiTheme('sess_a', GITHUB_DARK)).toBe(false);
  });

  it('sends exactly once when the payload actually changes', () => {
    shouldNotifyTuiTheme('sess_a', GITHUB_DARK); // 首次登记基线
    expect(shouldNotifyTuiTheme('sess_a', DRACULA)).toBe(true);
    expect(shouldNotifyTuiTheme('sess_a', DRACULA)).toBe(false); // 去重
  });

  it('keeps a baseline per session', () => {
    shouldNotifyTuiTheme('sess_a', GITHUB_DARK);
    expect(shouldNotifyTuiTheme('sess_b', GITHUB_DARK)).toBe(false); // b 首次
    expect(shouldNotifyTuiTheme('sess_b', DRACULA)).toBe(true);
    expect(shouldNotifyTuiTheme('sess_a', DRACULA)).toBe(true); // a 也换了主题
  });

  it('ignores empty input', () => {
    expect(shouldNotifyTuiTheme('', GITHUB_DARK)).toBe(false);
    expect(shouldNotifyTuiTheme('sess_a', '')).toBe(false);
  });

  it('reset drops the baseline so the next payload is treated as first sighting', () => {
    shouldNotifyTuiTheme('sess_a', GITHUB_DARK);
    resetTuiThemeNotification('sess_a');
    expect(shouldNotifyTuiTheme('sess_a', DRACULA)).toBe(false);
  });
});
