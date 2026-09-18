import { describe, it, expect } from 'vitest';
import {
  HOVER_MOUSE_DOWNGRADE_AGENTS,
  isHoverMouseDowngradeAgent,
  downgradeHoverMouseMode,
} from './terminalMouseMode';

describe('isHoverMouseDowngradeAgent', () => {
  it('仅对白名单内的 agent 启用', () => {
    expect(HOVER_MOUSE_DOWNGRADE_AGENTS).toEqual(['opencode']);
    expect(isHoverMouseDowngradeAgent('opencode')).toBe(true);
    expect(isHoverMouseDowngradeAgent('OpenCode')).toBe(true);
  });

  it('其他 agent 一律不启用（字节流不变）', () => {
    for (const id of ['qwen-code', 'pi', 'cline', 'claude-code', 'kimi-code', '', null, undefined]) {
      expect(isHoverMouseDowngradeAgent(id)).toBe(false);
    }
  });
});

describe('downgradeHoverMouseMode', () => {
  it('把 opencode 的 1003h 四连降级为 DRAG，点击/拖动/滚轮保留', () => {
    const input = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';
    expect(downgradeHoverMouseMode(input)).toBe('\x1b[?1000h\x1b[?1002h\x1b[?1002h\x1b[?1006h');
  });

  it('DECRST 一并改写（保持变换对称；xterm 中 1000l/1002l/1003l 语义相同）', () => {
    const input = '\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l';
    expect(downgradeHoverMouseMode(input)).toBe('\x1b[?1002l\x1b[?1002l\x1b[?1000l\x1b[?1006l');
  });

  it('绝不触碰 1000h / 1002h / 1006h —— 滚轮与点击链路必须原样保留', () => {
    // 98964d5 回滚上一版方案，正是因为整族剥离让 TUI 收不到滚轮。
    const keep = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
    expect(downgradeHoverMouseMode(keep)).toBe(keep);
  });

  it('处理带分号的组合参数，且不影响同组其他模式', () => {
    expect(downgradeHoverMouseMode('\x1b[?1000;1003h')).toBe('\x1b[?1000;1002h');
    expect(downgradeHoverMouseMode('\x1b[?1002;1003;1006h')).toBe('\x1b[?1002;1002;1006h');
  });

  it('不误伤含 1003 子串的其他参数（精确按分号分段比较）', () => {
    // 11003 / 10030 不是 1003，必须原样保留。
    expect(downgradeHoverMouseMode('\x1b[?11003h')).toBe('\x1b[?11003h');
    expect(downgradeHoverMouseMode('\x1b[?10030h')).toBe('\x1b[?10030h');
  });

  it('不含 1003 的序列逐字节不变', () => {
    const chunk = '\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[2J\x1b[H\x1b[?1006h';
    expect(downgradeHoverMouseMode(chunk)).toBe(chunk);
  });

  it('保留可见文本与颜色序列，仅改写鼠标模式', () => {
    const chunk = '\x1b[?2026h\x1b[38;2;201;209;217m你好\x1b[0m\x1b[?1003h\x1b[?2026l';
    expect(downgradeHoverMouseMode(chunk))
      .toBe('\x1b[?2026h\x1b[38;2;201;209;217m你好\x1b[0m\x1b[?1002h\x1b[?2026l');
  });

  it('一次调用可处理多个序列（跨帧拼接后的整块数据）', () => {
    const input = 'a\x1b[?1003hb\x1b[?1003lc';
    expect(downgradeHoverMouseMode(input)).toBe('a\x1b[?1002hb\x1b[?1002lc');
  });

  it('无 ESC 或非字符串输入直接返回，不做分配', () => {
    expect(downgradeHoverMouseMode('plain text')).toBe('plain text');
    expect(downgradeHoverMouseMode('')).toBe('');
    expect(downgradeHoverMouseMode(null)).toBe(null);
    expect(downgradeHoverMouseMode(undefined)).toBe(undefined);
  });
});
