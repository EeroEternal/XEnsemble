import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../hooks/useProjectRepos', () => ({
  useProjectRepos: vi.fn(),
}));

vi.mock('../components/WorkspaceFileTree', () => ({
  default: vi.fn((props) => (
    <div data-testid="workspace-file-tree" data-root-path={props.rootPath ?? ''} />
  )),
}));

import { useProjectRepos } from '../hooks/useProjectRepos';
import MultiRootFileTree from '../components/MultiRootFileTree';

const COMMON = {
  projectId: 'p1',
  onFetchDir: vi.fn(),
  onOpenFile: vi.fn(),
};

describe('MultiRootFileTree', () => {
  it('无 project_repos 记录：回退原 WorkspaceFileTree（无 tabs）', () => {
    useProjectRepos.mockReturnValue({ repos: [], loading: false, error: null });
    render(<MultiRootFileTree {...COMMON} />);
    expect(screen.getByTestId('workspace-file-tree')).toBeInTheDocument();
    expect(screen.queryByTestId(/repo-tab-/)).not.toBeInTheDocument();
  });

  it('单 repo：回退原 WorkspaceFileTree，不传 rootPath', () => {
    useProjectRepos.mockReturnValue({
      repos: [{ id: 'pr_1', subPath: 'web', isPrimary: true }],
      loading: false,
      error: null,
    });
    render(<MultiRootFileTree {...COMMON} />);
    expect(screen.getByTestId('workspace-file-tree')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-file-tree').dataset.rootPath).toBe('');
  });

  it('多 repo：渲染 tabs，primary 默认选中，rootPath=<subPath>', () => {
    useProjectRepos.mockReturnValue({
      repos: [
        { id: 'pr_1', subPath: 'web', isPrimary: true },
        { id: 'pr_2', subPath: 'api', isPrimary: false },
      ],
      loading: false,
      error: null,
    });
    render(<MultiRootFileTree {...COMMON} />);
    expect(screen.getByTestId('repo-tab-web')).toBeInTheDocument();
    expect(screen.getByTestId('repo-tab-api')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-file-tree').dataset.rootPath).toBe('web');
  });

  it('切换 tab：rootPath 跟随所选 repo', () => {
    useProjectRepos.mockReturnValue({
      repos: [
        { id: 'pr_1', subPath: 'web', isPrimary: true },
        { id: 'pr_2', subPath: 'api', isPrimary: false },
      ],
      loading: false,
      error: null,
    });
    render(<MultiRootFileTree {...COMMON} />);
    fireEvent.click(screen.getByTestId('repo-tab-api'));
    expect(screen.getByTestId('workspace-file-tree').dataset.rootPath).toBe('api');
  });
});
