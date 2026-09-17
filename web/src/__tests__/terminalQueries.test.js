import { describe, it, expect } from 'vitest';
import { stripTerminalQueries } from '@/lib/terminalQueries';

const ST = '\x1b\\';
const BEL = '\x07';

describe('stripTerminalQueries', () => {
  it('removes OSC 10/11/12 color queries terminated by ST or BEL', () => {
    expect(stripTerminalQueries(`\x1b]11;?${ST}`)).toBe('');
    expect(stripTerminalQueries(`\x1b]11;?${BEL}`)).toBe('');
    expect(stripTerminalQueries(`\x1b]10;?${ST}`)).toBe('');
    expect(stripTerminalQueries(`\x1b]12;?${BEL}`)).toBe('');
  });

  it('removes repeated queries (the replies seen as auto-typed junk)', () => {
    const replayed = `prompt$ \x1b]11;?${ST}\x1b]11;?${ST}`;
    expect(stripTerminalQueries(replayed)).toBe('prompt$ ');
  });

  it('removes device / cursor / window queries (DA, DSR)', () => {
    expect(stripTerminalQueries(`\x1b[c`)).toBe('');
    expect(stripTerminalQueries(`\x1b[>c`)).toBe('');
    expect(stripTerminalQueries(`\x1b[5n`)).toBe('');
    expect(stripTerminalQueries(`\x1b[6n`)).toBe('');
    expect(stripTerminalQueries(`\x1b[?6n`)).toBe('');
    expect(stripTerminalQueries(`\x1b[14t`)).toBe('');
    expect(stripTerminalQueries(`\x1b[18t`)).toBe('');
  });

  it('keeps surrounding agent output byte-identical', () => {
    const chunk = `\x1b[2J\x1b[Hhello\x1b]11;?${ST}mid\x1b[6n` + `world\n\x1b[?25h`;
    expect(stripTerminalQueries(chunk)).toBe('\x1b[2J\x1b[Hhellomidworld\n\x1b[?25h');
  });

  it('does not touch set-color commands', () => {
    const setFg = `\x1b]10;rgb:ffff/ffff/ffff${BEL}`;
    const setBg = `\x1b]11;#1e1e1e${ST}`;
    expect(stripTerminalQueries(setFg)).toBe(setFg);
    expect(stripTerminalQueries(setBg)).toBe(setBg);
  });

  it('removes OSC 4 palette queries but keeps palette set commands', () => {
    expect(stripTerminalQueries(`\x1b]4;0;?${ST}`)).toBe('');
    expect(stripTerminalQueries(`\x1b]4;0;?;1;?;255;?${BEL}`)).toBe('');
    const setOnly = `\x1b]4;0;#ff0000${BEL}`;
    expect(stripTerminalQueries(setOnly)).toBe(setOnly);
    expect(stripTerminalQueries(`\x1b]4;0;?;1;#00ff00${BEL}`)).toBe(`\x1b]4;1;#00ff00${BEL}`);
    expect(stripTerminalQueries(`\x1b]4;0;?;1;#00ff00${ST}`)).toBe(`\x1b]4;1;#00ff00${ST}`);
  });

  it('does not touch OSC 52 clipboard writes or title updates', () => {
    const clipboard = `\x1b]52;c;aGVsbG8=${BEL}`;
    const title = `\x1b]0;opencode${BEL}`;
    expect(stripTerminalQueries(clipboard)).toBe(clipboard);
    expect(stripTerminalQueries(title)).toBe(title);
  });

  it('does not touch lookalike sequences', () => {
    const cases = ['\x1b[16n', '\x1b[26n', '\x1b[118t', '\x1b[?1049h', '\x1b[2c', '\x1b[>4;2c'];
    for (const seq of cases) {
      expect(stripTerminalQueries(seq)).toBe(seq);
    }
  });

  it('returns non-strings and plain text unchanged', () => {
    expect(stripTerminalQueries(undefined)).toBe(undefined);
    expect(stripTerminalQueries('plain text\n')).toBe('plain text\n');
    expect(stripTerminalQueries('')).toBe('');
  });
});
