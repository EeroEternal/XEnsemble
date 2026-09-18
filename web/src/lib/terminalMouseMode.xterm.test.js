import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { downgradeHoverMouseMode } from './terminalMouseMode';

// xterm 内部协议事件位（见 @xterm/xterm lib/xterm.js 的 CoreMouseService）：
//   NONE={events:0} X10={1} VT200={19} DRAG={23} ANY={31}
// 位含义（bindMouse）：2=mouseup 4=mousedrag 8=mousemove(hover) 16=wheel
const PROTOCOL_EVENTS = { NONE: 0, X10: 1, VT200: 19, DRAG: 23, ANY: 31 };

const OPENCODE_SEQ = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';
const OPENCODE_RESET = '\x1b[?1003l\x1b[?1002l\x1b[?1000l';

/** 用真实 xterm 实例跑序列，读取其内部鼠标协议状态。 */
function protocolState(data) {
  // jsdom 未实现 matchMedia，xterm 的 CoreBrowserService 会读取它以计算 DPR。
  if (!window.matchMedia) {
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const term = new Terminal({ cols: 80, rows: 24 });
  term.open(host);
  const svc = term._core.coreMouseService;
  // xterm 的 write 是异步的（解析器排队处理），必须等回调后再读协议状态。
  return new Promise((resolve) => {
    term.write(data, () => {
      const active = svc.areMouseEventsActive;
      resolve({ protocol: svc.activeProtocol, events: active ? PROTOCOL_EVENTS[svc.activeProtocol] : 0 });
    });
  });
}

describe('xterm 真实协议状态验证（回归防护）', () => {
  it('opencode 原始序列让 xterm 进入 ANY —— hover 会被上报', async () => {
    const s = await protocolState(OPENCODE_SEQ);
    expect(s.protocol).toBe('ANY');
    expect(s.events & 8).toBe(8); // mousemove/hover 位
  });

  it('降级后 xterm 进入 DRAG —— hover 位被清除，滚轮/点击/拖动保留', async () => {
    const s = await protocolState(downgradeHoverMouseMode(OPENCODE_SEQ));
    expect(s.protocol).toBe('DRAG');
    expect(s.events & 8).toBe(0);   // 无按键的纯移动不再上报
    expect(s.events & 16).toBe(16); // 滚轮保留
    expect(s.events & 2).toBe(2);   // mouseup 保留
    expect(s.events & 4).toBe(4);   // mousedrag 保留
  });

  it('DECRST 改写与原始语义等价（都是关掉鼠标，不产生额外副作用）', async () => {
    // xterm 里 1000l / 1002l / 1003l 都置 activeProtocol="NONE"，故 1003l→1002l
    // 是行为等价的空操作。这里锁定该等价性，防止未来误以为改动能"保留"鼠标。
    const rewritten = await protocolState(downgradeHoverMouseMode(OPENCODE_RESET));
    const original = await protocolState(OPENCODE_RESET);
    expect(rewritten.protocol).toBe(original.protocol);
    expect(rewritten.events).toBe(original.events);
  });

  it('对照：原始 DECRST 序列确实会关闭鼠标（协议 NONE）', async () => {
    const s = await protocolState(OPENCODE_RESET);
    expect(s.protocol).toBe('NONE');
    expect(s.events).toBe(0);
  });

  it('开启-关闭完整周期后回到 NONE，且降级不影响 1000h/1002h/1006h', async () => {
    // opencode 典型生命周期：四连开启 → 退出时四连关闭。
    const full = await protocolState(
      downgradeHoverMouseMode(`${OPENCODE_SEQ}${OPENCODE_RESET}\x1b[?1006l`),
    );
    expect(full.protocol).toBe('NONE');
    // 关键回归防护：1002h 必须原样保留，否则 xterm 进不了 DRAG（98964d5 的坑）。
    const dragOnly = await protocolState(
      downgradeHoverMouseMode('\x1b[?1002h\x1b[?1006h'),
    );
    expect(dragOnly.protocol).toBe('DRAG');
  });

  it('非 opencode 的字节流不进入降级（DRAG 序列保持不变）', async () => {
    const clineSeq = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
    expect(downgradeHoverMouseMode(clineSeq)).toBe(clineSeq);
    expect((await protocolState(clineSeq)).protocol).toBe('DRAG');
  });
});
