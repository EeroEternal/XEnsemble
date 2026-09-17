import { describe, it } from 'node:test';
import assert from 'node:assert';
import { stripTerminalQueries } from './terminalQueries.js';

const ST = '\x1b\\';
const BEL = '\x07';

describe('stripTerminalQueries', () => {
  it('removes OSC 10/11/12 color queries terminated by ST or BEL', () => {
    assert.equal(stripTerminalQueries(`\x1b]11;?${ST}`), '');
    assert.equal(stripTerminalQueries(`\x1b]11;?${BEL}`), '');
    assert.equal(stripTerminalQueries(`\x1b]10;?${ST}`), '');
    assert.equal(stripTerminalQueries(`\x1b]12;?${BEL}`), '');
  });

  it('removes repeated queries (the replies seen as auto-typed junk)', () => {
    const replayed = `prompt$ \x1b]11;?${ST}\x1b]11;?${ST}`;
    assert.equal(stripTerminalQueries(replayed), 'prompt$ ');
  });

  it('removes device / cursor / window queries (DA, DSR)', () => {
    assert.equal(stripTerminalQueries(`\x1b[c`), '');
    assert.equal(stripTerminalQueries(`\x1b[>c`), '');
    assert.equal(stripTerminalQueries(`\x1b[5n`), '');
    assert.equal(stripTerminalQueries(`\x1b[6n`), '');
    assert.equal(stripTerminalQueries(`\x1b[?6n`), '');
    assert.equal(stripTerminalQueries(`\x1b[14t`), '');
    assert.equal(stripTerminalQueries(`\x1b[18t`), '');
  });

  it('keeps surrounding agent output byte-identical', () => {
    const chunk = `\x1b[2J\x1b[Hhello\x1b]11;?${ST}mid\x1b[6n` + 'world\n\x1b[?25h';
    assert.equal(stripTerminalQueries(chunk), '\x1b[2J\x1b[Hhellomidworld\n\x1b[?25h');
  });

  it('does not touch set-color commands', () => {
    const setFg = `\x1b]10;rgb:ffff/ffff/ffff${BEL}`;
    const setBg = `\x1b]11;#1e1e1e${ST}`;
    assert.equal(stripTerminalQueries(setFg), setFg);
    assert.equal(stripTerminalQueries(setBg), setBg);
  });

  it('removes OSC 4 palette queries but keeps palette set commands', () => {
    assert.equal(stripTerminalQueries(`\x1b]4;0;?${ST}`), '');
    assert.equal(stripTerminalQueries(`\x1b]4;0;?;1;?;255;?${BEL}`), '');
    const setOnly = `\x1b]4;0;#ff0000${BEL}`;
    assert.equal(stripTerminalQueries(setOnly), setOnly);
    assert.equal(stripTerminalQueries(`\x1b]4;0;?;1;#00ff00${BEL}`), `\x1b]4;1;#00ff00${BEL}`);
    assert.equal(stripTerminalQueries(`\x1b]4;0;?;1;#00ff00${ST}`), `\x1b]4;1;#00ff00${ST}`);
  });

  it('does not touch OSC 52 clipboard writes or title updates', () => {
    const clipboard = `\x1b]52;c;aGVsbG8=${BEL}`;
    const title = `\x1b]0;opencode${BEL}`;
    assert.equal(stripTerminalQueries(clipboard), clipboard);
    assert.equal(stripTerminalQueries(title), title);
  });

  it('does not touch lookalike sequences', () => {
    const cases = ['\x1b[16n', '\x1b[26n', '\x1b[118t', '\x1b[?1049h', '\x1b[2c', '\x1b[>4;2c'];
    for (const seq of cases) {
      assert.equal(stripTerminalQueries(seq), seq);
    }
  });

  it('returns non-strings and plain text unchanged', () => {
    assert.equal(stripTerminalQueries(undefined), undefined);
    assert.equal(stripTerminalQueries('plain text\n'), 'plain text\n');
    assert.equal(stripTerminalQueries(''), '');
  });
});
