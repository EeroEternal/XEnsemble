import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/Toast';

vi.mock('@monaco-editor/react', () => ({
  default: function MockEditor({ value, onChange, options }) {
    return (
      <div data-testid="monaco-editor">
        <textarea
          data-testid="monaco-textarea"
          value={value}
          readOnly={options?.readOnly}
          onChange={onChange}
        />
      </div>
    );
  },
  loader: { init: vi.fn() },
}));

vi.mock('@/components/WorkspacePreviewPane', () => ({
  default: function MockPreview({ mode }) {
    return <div data-testid={`workspace-${mode}-pane`}>{mode}</div>;
  },
}));

const WorkspacePanel = (await import('@/components/WorkspacePanel')).default;

function renderPanel(ui) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe('WorkspacePanel', () => {
  const defaultProps = {
    projectId: 'proj1',
    tabs: [],
    activePath: '',
    onSelectTab: vi.fn(),
    onCloseTab: vi.fn(),
    onSaveTab: vi.fn(),
    onOpenFile: vi.fn(),
    onFetchDir: vi.fn().mockResolvedValue([]),
    onCreateFile: vi.fn(),
    onCreateDir: vi.fn(),
    gitChanges: null,
    onGitFileClick: vi.fn(),
    gitDiffView: null,
    onCloseGitDiff: vi.fn(),
  };

  beforeEach(() => {
    sessionStorage.clear();
  });

  it('renders empty state when no file is open', async () => {
    renderPanel(<WorkspacePanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/Select a file from the tree to open/)).toBeInTheDocument();
    });
  });

  it('renders editor content when a file is open, without file tabs', async () => {
    const tabs = [
      { path: 'src/index.js', content: 'hello', originalContent: 'hello', isBinary: false },
    ];
    renderPanel(<WorkspacePanel {...defaultProps} tabs={tabs} activePath="src/index.js" />);
    expect(await screen.findByTestId('monaco-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-list')).not.toBeInTheDocument();
    expect(screen.queryByText('index.js')).not.toBeInTheDocument();
  });

  it('opens new file dialog with autoFocus', () => {
    renderPanel(<WorkspacePanel {...defaultProps} />);
    fireEvent.click(screen.getByTitle('New file'));
    const input = screen.getByPlaceholderText(/filename/);
    expect(input).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it('creates new file on confirm', async () => {
    const onCreateFile = vi.fn().mockResolvedValue({ ok: true });
    const onFetchDir = vi.fn().mockResolvedValue([]);
    renderPanel(<WorkspacePanel {...defaultProps} onCreateFile={onCreateFile} onFetchDir={onFetchDir} />);

    fireEvent.click(screen.getByTitle('New file'));
    const input = screen.getByPlaceholderText(/filename/);
    fireEvent.change(input, { target: { value: 'newfile.js' } });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(onCreateFile).toHaveBeenCalledWith('proj1', 'newfile.js');
    });
  });

  it('opens new folder dialog with autoFocus', () => {
    renderPanel(<WorkspacePanel {...defaultProps} />);
    fireEvent.click(screen.getByTitle('New folder'));
    const input = screen.getByPlaceholderText(/folder name/);
    expect(input).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it('creates new folder on confirm', async () => {
    const onCreateDir = vi.fn().mockResolvedValue({ ok: true });
    const onFetchDir = vi.fn().mockResolvedValue([]);
    renderPanel(<WorkspacePanel {...defaultProps} onCreateDir={onCreateDir} onFetchDir={onFetchDir} />);

    fireEvent.click(screen.getByTitle('New folder'));
    const input = screen.getByPlaceholderText(/folder name/);
    fireEvent.change(input, { target: { value: 'newdir' } });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(onCreateDir).toHaveBeenCalledWith('proj1', 'newdir');
    });
  });

  it('shows file tree on the left side', async () => {
    renderPanel(<WorkspacePanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
    });
  });

  it('toggles file tree with a single header button', async () => {
    renderPanel(<WorkspacePanel {...defaultProps} />);
    const collapseBtn = screen.getByTitle('Collapse file tree');
    expect(collapseBtn).toBeInTheDocument();

    fireEvent.click(collapseBtn);
    const expandBtn = await screen.findByTitle('Expand file tree');
    expect(expandBtn).toBeInTheDocument();
    expect(screen.queryByTitle('Collapse file tree')).not.toBeInTheDocument();

    fireEvent.click(expandBtn);
    expect(await screen.findByTitle('Collapse file tree')).toBeInTheDocument();
    expect(screen.queryByTitle('Expand file tree')).not.toBeInTheDocument();
  });

  it('shows changes badge and opens Changes tab', async () => {
    const gitChanges = {
      stagedFiles: [{ path: 'src/a.js', status: 'M ' }],
      unstagedFiles: [{ path: 'src/b.js', status: ' M' }],
      dirty: true,
      branch: 'main',
      ahead: 0,
      behind: 0,
    };
    renderPanel(<WorkspacePanel {...defaultProps} gitChanges={gitChanges} />);
    expect(screen.getByText('2')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Changes'));
    await waitFor(() => {
      expect(screen.getByText('a.js')).toBeInTheDocument();
      expect(screen.getByText('b.js')).toBeInTheDocument();
    });
  });

  it('shows empty state in changes when no git files', async () => {
    const gitChanges = { stagedFiles: [], unstagedFiles: [], dirty: false, branch: 'main', ahead: 0, behind: 0 };
    renderPanel(<WorkspacePanel {...defaultProps} gitChanges={gitChanges} />);
    fireEvent.click(screen.getByText('Changes'));
    await waitFor(() => {
      expect(screen.getByText(/No saved changes/)).toBeInTheDocument();
    });
  });

  it('adds Workspace shell from plus menu', async () => {
    renderPanel(<WorkspacePanel {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Add panel'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Workspace shell' }));
    await waitFor(() => {
      expect(screen.getAllByText('Workspace shell').length).toBeGreaterThan(0);
    });
  });
});
