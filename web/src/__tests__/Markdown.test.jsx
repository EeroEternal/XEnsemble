import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MarkdownView from '@/components/Markdown';

const FENCED_JS = '```js\nconst x = 1;\n```';
const FENCED_PLAIN = '```\nplain output\n```';
const INLINE_MD = 'Here is `inline code`.';

describe('MarkdownView', () => {
  it('renders fenced code blocks with block styling (not the inline chip)', () => {
    render(<MarkdownView>{FENCED_JS}</MarkdownView>);
    const code = document.querySelector('pre > code');
    expect(code).not.toBeNull();
    // Block code must use the clean block classes, NOT the inline chip.
    expect(code.className).toContain('block');
    expect(code.className).toContain('bg-transparent');
    expect(code.className).not.toContain('bg-zinc-100');
  });

  it('renders plain (language-less) fenced blocks as blocks too', () => {
    render(<MarkdownView>{FENCED_PLAIN}</MarkdownView>);
    const code = document.querySelector('pre > code');
    expect(code).not.toBeNull();
    expect(code.className).toContain('block');
    expect(code.className).not.toContain('bg-zinc-100');
  });

  it('renders inline code as a chip', () => {
    render(<MarkdownView>{INLINE_MD}</MarkdownView>);
    const code = document.querySelector('p > code');
    expect(code).not.toBeNull();
    expect(code.className).toContain('bg-zinc-100');
  });

  it('does not leak react-markdown `node` prop onto DOM elements', () => {
    const { container } = render(
      <MarkdownView>{`text\n\n${FENCED_JS}`}</MarkdownView>
    );
    expect(container.innerHTML).not.toContain('node="[object Object]"');
    expect(container.querySelector('[node]')).toBeNull();
  });

  it('renders a header with a distinct surface and language badge', () => {
    render(<MarkdownView>{'```python\nprint(1)\n```'}</MarkdownView>);
    const header = document.querySelector('.markdown-body > div > div');
    expect(header.className).toContain('bg-zinc-100');
    expect(header.className).toContain('dark:bg-zinc-200');
    expect(screen.getByText('python')).toBeInTheDocument();
  });

  it('renders inline math via KaTeX', () => {
    render(<MarkdownView>{'E = mc^2: $E=mc^2$'}</MarkdownView>);
    expect(document.querySelector('.katex')).not.toBeNull();
  });
});
