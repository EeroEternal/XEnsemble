/**
 * 终端自动滚动守卫（atBottom 判据）回归测试。
 *
 * 背景：7396a16 为消除 layout thrashing 把 atBottom 从 DOM viewport 判据改为
 * buffer API，但误用了 baseY（缓冲区底部基准 = length - rows）——代入后
 * `baseY + rows >= length` 恒真，守卫形同虚设。表现为：
 *  1. agent 等待用户选择决策时，TUI spinner 高频重绘，每帧都把上滑查看
 *     历史的用户强行拉回底部（滚不上去）；
 *  2. 会话结束后空闲重绘帧同样把视口拉回底部。
 *
 * 正确判据：viewportY（= ydisp，用户当前视口）=== baseY（= ybase，贴底位置）。
 * 这里用真实 xterm headless 实例验证两种判据的行为差异，锁住修复。
 */
import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeTerminalWithHistory() {
  const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
  for (let i = 0; i < 300; i++) term.write(`line ${i}\r\n`);
  await sleep(150);
  return term;
}

// 修复前的判据（7396a16 引入）
const oldAtBottom = (buf, rows) => buf.baseY + rows >= buf.length;
// 修复后的判据
const newAtBottom = (buf) => buf.viewportY === buf.baseY;

describe('terminal atBottom guard', () => {
  it('旧判据（baseY+rows>=length）在用户上滑时仍误判为贴底（回归锁）', async () => {
    const term = await makeTerminalWithHistory();
    const buf = term.buffer.active;
    term.scrollLines(-50); // 用户上滑查看历史
    expect(buf.viewportY).not.toBe(buf.baseY);      // 确实不在底部
    expect(oldAtBottom(buf, term.rows)).toBe(true); // 但旧判据说“在底部” ← BUG
  });

  it('新判据（viewportY===baseY）在用户上滑时正确返回 false', async () => {
    const term = await makeTerminalWithHistory();
    const buf = term.buffer.active;
    term.scrollLines(-50);
    expect(buf.viewportY).not.toBe(buf.baseY);
    expect(newAtBottom(buf)).toBe(false);
  });

  it('新判据在用户贴底时返回 true（自动跟随行为保留）', async () => {
    const term = await makeTerminalWithHistory();
    const buf = term.buffer.active;
    term.scrollToBottom();
    expect(newAtBottom(buf)).toBe(true);
  });

  it('行为对比：上滑后新输出帧到达——旧判据拉回底部，新判据保持不动', async () => {
    // 旧判据路径
    const t1 = await makeTerminalWithHistory();
    t1.scrollLines(-50);
    if (oldAtBottom(t1.buffer.active, t1.rows)) t1.scrollToBottom(); // 复刻旧代码
    await sleep(50);
    expect(t1.buffer.active.viewportY).toBe(t1.buffer.active.baseY); // 被拉回 ← BUG

    // 新判据路径
    const t2 = await makeTerminalWithHistory();
    t2.scrollLines(-50);
    if (newAtBottom(t2.buffer.active)) t2.scrollToBottom(); // 复刻新代码
    await sleep(50);
    expect(t2.buffer.active.viewportY).not.toBe(t2.buffer.active.baseY); // 保持 ✓
  });
});
