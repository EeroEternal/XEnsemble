import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EditorTabs from '@/components/EditorTabs';

const makeTab = (path, content, originalContent, overrides = {}) => ({
  path,
  content,
  originalContent: originalContent ?? content,
  isBinary: false,
  ...overrides,
});

describe('EditorTabs', () => {
  it('renders tab list with file names', () => {
    const tabs = [
      makeTab('src/index.js', 'console.log(1)'),
      makeTab('src/app.js', 'const x = 1;'),
    ];
    render(<EditorTabs tabs={tabs} activePath="src/index.js" />);
    expect(screen.getByText('index.js')).toBeInTheDocument();
    expect(screen.getByText('app.js')).toBeInTheDocument();
  });

  it('calls onSelectTab when clicking a tab', () => {
    const onSelectTab = vi.fn();
    const tabs = [
      makeTab('src/a.js', 'a'),
      makeTab('src/b.js', 'b'),
    ];
    render(<EditorTabs tabs={tabs} activePath="src/a.js" onSelectTab={onSelectTab} />);
    fireEvent.click(screen.getByText('b.js'));
    expect(onSelectTab).toHaveBeenCalledWith('src/b.js');
  });

  it('shows dirty indicator when content !== originalContent', () => {
    const tabs = [
      makeTab('src/a.js', 'modified', 'original'),
    ];
    render(<EditorTabs tabs={tabs} activePath="src/a.js" />);
    const tab = screen.getByText('a.js').closest('[data-testid="tab"]');
    expect(tab).toHaveAttribute('data-dirty', 'true');
  });

  it('does not show dirty indicator when content equals originalContent', () => {
    const tabs = [
      makeTab('src/a.js', 'same', 'same'),
    ];
    render(<EditorTabs tabs={tabs} activePath="src/a.js" />);
    const tab = screen.getByText('a.js').closest('[data-testid="tab"]');
    expect(tab).toHaveAttribute('data-dirty', 'false');
  });

  it('calls onCloseTab directly for clean tab', () => {
    const onCloseTab = vi.fn();
    const tabs = [makeTab('src/a.js', 'same', 'same')];
    render(<EditorTabs tabs={tabs} activePath="src/a.js" onCloseTab={onCloseTab} />);
    fireEvent.click(screen.getByLabelText('Close src/a.js'));
    expect(onCloseTab).toHaveBeenCalledWith('src/a.js');
  });

  it('shows confirmation dialog when closing dirty tab', () => {
    const onCloseTab = vi.fn();
    const tabs = [
      makeTab('src/a.js', 'modified', 'original'),
      makeTab('src/b.js', 'b'),
    ];
    render(<EditorTabs tabs={tabs} activePath="src/a.js" onCloseTab={onCloseTab} />);
    fireEvent.click(screen.getByLabelText('Close src/a.js'));
    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.getByText("Don't Save")).toBeInTheDocument();
    expect(onCloseTab).not.toHaveBeenCalled();
  });

  it('closes tab after discarding changes', () => {
    const onCloseTab = vi.fn();
    const onSaveTab = vi.fn();
    const tabs = [
      makeTab('src/a.js', 'modified', 'original'),
      makeTab('src/b.js', 'b'),
    ];
    render(
      <EditorTabs
        tabs={tabs}
        activePath="src/a.js"
        onCloseTab={onCloseTab}
        onSaveTab={onSaveTab}
      />
    );
    fireEvent.click(screen.getByLabelText('Close src/a.js'));
    fireEvent.click(screen.getByText("Don't Save"));
    expect(onCloseTab).toHaveBeenCalledWith('src/a.js');
    expect(onSaveTab).not.toHaveBeenCalled();
  });

  it('saves and closes tab after saving changes', async () => {
    const onCloseTab = vi.fn();
    const onSaveTab = vi.fn(() => Promise.resolve());
    const tabs = [
      makeTab('src/a.js', 'modified', 'original'),
    ];
    render(
      <EditorTabs
        tabs={tabs}
        activePath="src/a.js"
        onCloseTab={onCloseTab}
        onSaveTab={onSaveTab}
      />
    );
    fireEvent.click(screen.getByLabelText('Close src/a.js'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(onSaveTab).toHaveBeenCalledWith('src/a.js');
      expect(onCloseTab).toHaveBeenCalledWith('src/a.js');
    });
  });

  it('cancels close when clicking Cancel', () => {
    const onCloseTab = vi.fn();
    const tabs = [
      makeTab('src/a.js', 'modified', 'original'),
      makeTab('src/b.js', 'b'),
    ];
    render(<EditorTabs tabs={tabs} activePath="src/a.js" onCloseTab={onCloseTab} />);
    fireEvent.click(screen.getByLabelText('Close src/a.js'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCloseTab).not.toHaveBeenCalled();
    expect(screen.getByText('a.js')).toBeInTheDocument();
  });

  it('renders empty state when no tabs', () => {
    const { container } = render(<EditorTabs tabs={[]} activePath="" />);
    expect(container.querySelector('[data-testid="tab-list"]')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});
