import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@monaco-editor/react', () => ({
  default: function MockEditor({ value, language, options }) {
    return (
      <div data-testid="monaco-editor" data-language={language}>
        <textarea
          data-testid="monaco-textarea"
          value={value}
          readOnly={options?.readOnly}
          onChange={() => {}}
        />
      </div>
    );
  },
  loader: { init: vi.fn() },
}));

const CodeEditor = (await import('@/components/CodeEditor')).default;

describe('CodeEditor', () => {
  it('renders Monaco editor with content', () => {
    render(<CodeEditor content="hello world" path="app.js" />);
    const editor = screen.getByTestId('monaco-editor');
    expect(editor).toBeInTheDocument();
    const textarea = screen.getByTestId('monaco-textarea');
    expect(textarea.value).toBe('hello world');
  });

  it('renders in readOnly mode when readOnly=true', () => {
    render(<CodeEditor content="readonly" readOnly path="app.js" />);
    const textarea = screen.getByTestId('monaco-textarea');
    expect(textarea).toHaveAttribute('readonly');
  });

  it('shows binary placeholder when isBinary=true', () => {
    render(<CodeEditor content="" isBinary path="image.png" />);
    expect(screen.getByText(/Binary file/)).toBeInTheDocument();
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument();
  });

  it('infers language from file extension', () => {
    render(<CodeEditor content="const x = 1;" path="app.js" />);
    const editor = screen.getByTestId('monaco-editor');
    expect(editor).toHaveAttribute('data-language', 'javascript');
  });

  it('infers typescript from .ts extension', () => {
    render(<CodeEditor content="const x: number = 1;" path="app.ts" />);
    const editor = screen.getByTestId('monaco-editor');
    expect(editor).toHaveAttribute('data-language', 'typescript');
  });

  it('infers markdown from .md extension', () => {
    render(<CodeEditor content="# Hello" path="readme.md" />);
    const editor = screen.getByTestId('monaco-editor');
    expect(editor).toHaveAttribute('data-language', 'markdown');
  });

  it('infers python from .py extension', () => {
    render(<CodeEditor content="print('hi')" path="script.py" />);
    const editor = screen.getByTestId('monaco-editor');
    expect(editor).toHaveAttribute('data-language', 'python');
  });

  it('triggers onSave on Ctrl+S', () => {
    const onSave = vi.fn();
    const { container } = render(<CodeEditor content="test" onSave={onSave} path="app.js" />);
    fireEvent.keyDown(container.firstChild || container, { key: 's', ctrlKey: true });
    expect(onSave).toHaveBeenCalled();
  });

  it('triggers onSave on Cmd+S (Mac)', () => {
    const onSave = vi.fn();
    const { container } = render(<CodeEditor content="test" onSave={onSave} path="app.js" />);
    fireEvent.keyDown(container.firstChild || container, { key: 's', metaKey: true });
    expect(onSave).toHaveBeenCalled();
  });

  it('shows large file warning when content exceeds 1MB', () => {
    const largeContent = 'x'.repeat(1024 * 1024 + 1);
    render(<CodeEditor content={largeContent} path="app.js" />);
    expect(screen.getByText(/File is large/)).toBeInTheDocument();
  });

  it('hides status toolbar when file is clean', () => {
    render(<CodeEditor content="hello" originalContent="hello" path="app.js" />);
    expect(screen.queryByText('已保存')).not.toBeInTheDocument();
    expect(screen.queryByText('保存')).not.toBeInTheDocument();
    expect(screen.queryByText('未保存')).not.toBeInTheDocument();
  });

  it('does not show unsaved status for dirty content (autosave)', () => {
    render(<CodeEditor content="hello" originalContent="world" path="app.js" />);
    expect(screen.queryByText('未保存')).not.toBeInTheDocument();
    expect(screen.queryByText('保存')).not.toBeInTheDocument();
  });

  it('shows saving status when saving=true', () => {
    render(<CodeEditor content="hello" originalContent="world" path="app.js" saving />);
    expect(screen.getByText('Saving…')).toBeInTheDocument();
  });
});
