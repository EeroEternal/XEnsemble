import { describe, it, expect } from 'vitest';
import {
  isFullRepaintDropAgent,
  dropFullRepaintPrefix,
  FULL_REPAINT_DROP_MIN_KEEP_BYTES,
} from '@/lib/terminalFrameDrop';

const OPEN = '\x1b[?2026h';
const CLOSE = '\x1b[?2026l';
const ERASE_LINE = '\x1b[2K';

/** 构造一个满整屏重绘帧（每行绝对定位 + 2K 重画）。 */
function fullFrame(rows, marker, { clear = false } = {}) {
  let s = OPEN + (clear ? '\x1b[2J' : '');
  for (let i = 0; i < rows; i += 1) s += `\x1b[${i + 1};1H${ERASE_LINE}${marker}-row${i}`;
  return s + CLOSE;
}

/** 构造一个增量 diff 帧（重画行数远小于屏高）。 */
function diffFrame(marker) {
  return `${OPEN}\x1b[3;1H${ERASE_LINE}${marker}${CLOSE}`;
}

describe('isFullRepaintDropAgent', () => {
  it('只对 qwen-code 启用（大小写不敏感）', () => {
    expect(isFullRepaintDropAgent('qwen-code')).toBe(true);
    expect(isFullRepaintDropAgent('QWEN-CODE')).toBe(true);
  });

  it('其他 agent 一律不启用（保证字节透明管线不变）', () => {
    for (const id of ['opencode', 'cline', 'codebuddy', 'kimi-code', 'pi', 'glm-agent', undefined, null, '']) {
      expect(isFullRepaintDropAgent(id)).toBe(false);
    }
  });
});

describe('dropFullRepaintPrefix', () => {
  it('积压未超阈值时原样返回', () => {
    const data = diffFrame('a') + diffFrame('b');
    const r = dropFullRepaintPrefix(data, { rows: 40, minKeepBytes: 1024 });
    expect(r.data).toBe(data);
    expect(r.droppedBytes).toBe(0);
  });

  it('无可作锚点的满整屏帧时（opencode/cline 形态：全增量 diff）不丢弃', () => {
    let data = '';
    for (let i = 0; i < 60; i += 1) data += diffFrame(`inc${i}`);
    const r = dropFullRepaintPrefix(data, { rows: 40, minKeepBytes: 128 });
    expect(r.data).toBe(data);
    expect(r.droppedBytes).toBe(0);
  });

  it('屏高大于任何帧的重画行数时不丢弃（锚点判据严格）', () => {
    const data = fullFrame(10, 'small') + diffFrame('tail');
    const r = dropFullRepaintPrefix(data, { rows: 40, minKeepBytes: 64 });
    expect(r.data).toBe(data);
    expect(r.droppedBytes).toBe(0);
  });

  it('丢弃最旧前缀：保留锚点帧及其后数据，被丢帧的内容不再出现', () => {
    const rows = 5;
    const head = fullFrame(rows, 'OLD');            // 可作锚点（但会被丢弃）
    const tail = fullFrame(rows, 'NEW') + diffFrame('after');
    const data = head + diffFrame('mid') + tail;
    // 只保留 tail（≥ 256KB 场景的缩微版）：need = head + mid = NEW 帧的起始偏移
    const minKeepBytes = tail.length;
    const r = dropFullRepaintPrefix(data, { rows, minKeepBytes });
    expect(r.droppedBytes).toBeGreaterThan(0);
    expect(r.data).not.toContain('OLD-row0');
    expect(r.data).toContain('NEW-row0');
    expect(r.data).toContain('after');
    expect(r.droppedBytes).toBe(data.length - r.data.length);
  });

  it('保留被丢前缀中的非 sync 数据（mouse tracking 等模式序列）', () => {
    const rows = 4;
    const mouse = '\x1b[?1002h\x1b[?1006h';   // 块外数据
    const data = mouse + fullFrame(rows, 'OLD') + fullFrame(rows, 'NEW');
    const minKeepBytes = fullFrame(rows, 'NEW').length;
    const r = dropFullRepaintPrefix(data, { rows, minKeepBytes });
    expect(r.droppedBytes).toBeGreaterThan(0);
    expect(r.data.startsWith(mouse)).toBe(true);   // 块外序列前置保留
    expect(r.data).not.toContain('OLD-row0');
    expect(r.data).toContain('NEW-row0');
  });

  it('未闭合的 sync 块（跨消息截断）不参与丢弃', () => {
    const rows = 4;
    const data = fullFrame(rows, 'OLD') + OPEN + '\x1b[1;1H' + ERASE_LINE + 'partial';
    const r = dropFullRepaintPrefix(data, { rows, minKeepBytes: 8 });
    // 尾部未闭合块使扫描在它之前停止：OLD 帧之后无可用锚点 → 不丢弃
    expect(r.droppedBytes).toBe(0);
    expect(r.data).toBe(data);
  });

  it('结果块对齐：保留部分从 \x1b[?2026h 开始（或块外数据后紧跟它）', () => {
    const rows = 4;
    const data = fullFrame(rows, 'A') + fullFrame(rows, 'B') + diffFrame('c');
    const minKeepBytes = fullFrame(rows, 'B').length + diffFrame('c').length;
    const r = dropFullRepaintPrefix(data, { rows, minKeepBytes });
    expect(r.droppedBytes).toBeGreaterThan(0);
    expect(r.data.startsWith(OPEN)).toBe(true);
  });

  it('非字符串输入安全返回', () => {
    expect(dropFullRepaintPrefix(undefined, { rows: 40 })).toEqual({ data: undefined, droppedBytes: 0 });
  });

  it('默认保留阈值远小于 8MB 硬阈值', () => {
    expect(FULL_REPAINT_DROP_MIN_KEEP_BYTES).toBeGreaterThan(0);
    expect(FULL_REPAINT_DROP_MIN_KEEP_BYTES).toBeLessThan(8 * 1024 * 1024);
  });
});