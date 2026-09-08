import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// connection 必须是稳定引用（vi.hoisted），否则 useEffect 无限循环
const stable = vi.hoisted(() => ({
  connection: { remote_username: 'tester', connection_type: 'oauth' },
}));

vi.mock('../hooks/useGitProvider', () => ({
  useGitProvider: () => ({
    connection: stable.connection,
    loading: false,
    error: null,
    connect: vi.fn(),
    connectWithPat: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

vi.mock('../components/Toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../lib/gitApi', () => ({
  listProviders: vi.fn().mockResolvedValue({ providers: [] }),
  listRepos: vi.fn().mockResolvedValue({
    repos: [
      { id: 'r1', full_name: 'a/b/c', private: false },
      { id: 'r2', full_name: 'a/b/d', private: false },
      { id: 'r3', full_name: 'a/e', private: false },
      { id: 'r4', full_name: 'g/h', private: false },
    ],
  }),
  importRepo: vi.fn().mockResolvedValue({ id: 'proj_1', status: 'cloning' }),
  generateWorkBranchName: vi.fn().mockReturnValue('agentharness/ws-ab12'),
}));

vi.mock('../lib/githubApi', () => ({
  getCloneStatus: vi.fn(),
}));

import * as gitApi from '../lib/gitApi';
import RepoImportDialog from '../components/git/RepoImportDialog';

describe('RepoImportDialog 多选勾选（同前缀锁定组）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染仓库行 checkbox', async () => {
    render(<RepoImportDialog open onClose={() => {}} fetchWorkspaces={() => {}} />);
    expect(await screen.findByTestId('repo-row-a/b/c')).toBeInTheDocument();
    expect(screen.getByTestId('repo-row-a/b/d')).toBeInTheDocument();
    expect(screen.getByTestId('repo-row-a/e')).toBeInTheDocument();
    expect(screen.getByTestId('repo-row-g/h')).toBeInTheDocument();
  });

  it('勾选 a/b/c 后锁定前缀组 a/b：a/b/d 可勾，a/e 与 g/h 禁用', async () => {
    render(<RepoImportDialog open onClose={() => {}} fetchWorkspaces={() => {}} />);
    await screen.findByTestId('repo-row-a/b/c');

    fireEvent.click(screen.getByTestId('repo-row-a/b/c'));
    expect(screen.getByTestId('repo-row-a/b/d')).not.toBeDisabled();
    expect(screen.getByTestId('repo-row-a/e')).toBeDisabled();
    expect(screen.getByTestId('repo-row-g/h')).toBeDisabled();
    expect(screen.getByTestId('multi-select-hint')).toBeInTheDocument();
  });

  it('取消全部勾选后重新开放所有仓库', async () => {
    render(<RepoImportDialog open onClose={() => {}} fetchWorkspaces={() => {}} />);
    await screen.findByTestId('repo-row-a/b/c');

    fireEvent.click(screen.getByTestId('repo-row-a/b/c'));
    fireEvent.click(screen.getByTestId('repo-row-a/b/c'));
    expect(screen.getByTestId('repo-row-a/e')).not.toBeDisabled();
    expect(screen.queryByTestId('multi-select-hint')).not.toBeInTheDocument();
  });

  it('多选提交：按钮显示数量，importRepo 收到 repos 数组', async () => {
    render(<RepoImportDialog open onClose={() => {}} fetchWorkspaces={() => {}} />);
    await screen.findByTestId('repo-row-a/b/c');

    fireEvent.click(screen.getByTestId('repo-row-a/b/c'));
    fireEvent.click(screen.getByTestId('repo-row-a/b/d'));

    expect(screen.getByTestId('import-submit')).toHaveTextContent(/2/);

    // name/branch 由第一个勾选仓库自动填充（selectedRepo effect），canImport 满足
    fireEvent.click(screen.getByTestId('import-submit'));

    expect(gitApi.importRepo).toHaveBeenCalled();
    const payload = gitApi.importRepo.mock.calls[0][0];
    expect(payload.repos).toHaveLength(2);
    expect(payload.repos[0].repo_full_name).toBe('a/b/c');
    expect(payload.repos[0].sub_path).toBe('c');
    expect(payload.repos[1].repo_full_name).toBe('a/b/d');
  });
});
