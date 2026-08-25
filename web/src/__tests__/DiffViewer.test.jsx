import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: function MockDiffEditor({ original, modified, language }) {
    return (
      <div data-testid="monaco-diff-editor" data-language={language}>
        <span data-testid="diff-original">{original}</span>
        <span data-testid="diff-modified">{modified}</span>
      </div>
    );
  },
}));

const DiffViewer = (await import('@/components/DiffViewer')).default;

describe('DiffViewer', () => {
  it('renders diff editor with original and modified content', () => {
    render(<DiffViewer original="foo" modified="bar" path="src/index.js" />);
    expect(screen.getByTestId('monaco-diff-editor')).toBeInTheDocument();
    expect(screen.getByTestId('diff-original')).toHaveTextContent('foo');
    expect(screen.getByTestId('diff-modified')).toHaveTextContent('bar');
  });

  it('shows "No differences" when original equals modified', () => {
    render(<DiffViewer original="same" modified="same" path="src/index.js" />);
    expect(screen.getByText(/No differences/)).toBeInTheDocument();
    expect(screen.queryByTestId('monaco-diff-editor')).not.toBeInTheDocument();
  });

  it('shows loading state', () => {
    render(<DiffViewer loading path="src/index.js" />);
    expect(screen.getByTestId('diff-loading')).toBeInTheDocument();
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(<DiffViewer original="a" modified="b" path="src/index.js" onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close compare'));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows path in header', () => {
    render(<DiffViewer original="a" modified="b" path="src/index.js" />);
    expect(screen.getByText(/index\.js/)).toBeInTheDocument();
  });

  it('infers language from file extension', () => {
    render(<DiffViewer original="a" modified="b" path="src/app.ts" />);
    expect(screen.getByTestId('monaco-diff-editor')).toHaveAttribute('data-language', 'typescript');
  });

  it('shows binary placeholder', () => {
    render(<DiffViewer original="" modified="" path="img.png" binary />);
    expect(screen.getByTestId('diff-binary')).toBeInTheDocument();
    expect(screen.queryByTestId('monaco-diff-editor')).not.toBeInTheDocument();
  });

  it('shows truncated notice', () => {
    render(<DiffViewer original="a" modified="b" path="big.js" truncated />);
    expect(screen.getByTestId('diff-truncated')).toBeInTheDocument();
  });
});
