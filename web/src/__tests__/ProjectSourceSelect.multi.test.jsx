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
      { id: 'r1', full_name: 'org/frontend', private: false },
      { id: 'r2', full_name: 'org/backend', private: false },
      { id: 'r3', full_name: 'other/infra', private: false },
    ],
  }),
  generateWorkBranchName: vi.fn().mockReturnValue('agentharness/ws-ab12'),
}));

import * as gitApi from '../lib/gitApi';
import ProjectSourceSelect from '../components/git/ProjectSourceSelect';

const PROPS = {
  onImported: vi.fn(),
  disabled: false,
};

describe('ProjectSourceSelect 多选勾选（同前缀锁定组）', () => {
  beforeEach(() => {
    gitApi.listRepos.mockImplementation((provider) => {
      const data = {
        github: [
          { id: 'r1', full_name: 'org/frontend', private: false },
          { id: 'r2', full_name: 'org/backend', private: false },
          { id: 'r3', full_name: 'other/infra', private: false },
        ],
        gitlab: [{ id: 'g1', full_name: 'gl/solo', private: false }],
        gitea: [{ id: 't1', full_name: 'gt/solo', private: false }],
      };
      return Promise.resolve({ repos: data[provider] || [] });
    });
    gitApi.listProviders.mockClear();
    gitApi.listProviders.mockResolvedValue({ providers: [] });
  });

  it('点击行即勾选：org/frontend 后锁定 org 组，other/infra 禁用（title 悬停提示，无插入元素）', async () => {
    render(<ProjectSourceSelect {...PROPS} />);
    // 打开下拉（点击 trigger）
    fireEvent.click(screen.getByRole('button', { name: /select repository/i }));
    const row = await screen.findByTestId('pss-repo-row-org/frontend');
    const hintBefore = screen.queryByTestId('pss-multi-select-hint');
    expect(hintBefore).toBeNull(); // 不再有插入式提示条

    fireEvent.click(row);
    expect(screen.getByTestId('pss-repo-row-org/backend')).not.toBeDisabled();
    const locked = screen.getByTestId('pss-repo-row-other/infra');
    expect(locked).toBeDisabled();
    expect(locked.getAttribute('title')).toMatch(/org/i); // 悬停提示
    // 确认按钮常驻，勾选后不新增元素（无高度跳动）
    expect(screen.getByTestId('pss-import-submit')).toBeEnabled();
  });

  it('未勾选时确认按钮 disabled 占位', async () => {
    render(<ProjectSourceSelect {...PROPS} />);
    fireEvent.click(screen.getByRole('button', { name: /select repository/i }));
    await screen.findByTestId('pss-repo-row-org/frontend');
    expect(screen.getByTestId('pss-import-submit')).toBeDisabled();
  });

  it('多选提交：onImported 收到 { name, repos[] }，含 provider 隔离', async () => {
    render(<ProjectSourceSelect {...PROPS} />);
    fireEvent.click(screen.getByRole('button', { name: /select repository/i }));
    fireEvent.click(await screen.findByTestId('pss-repo-row-org/frontend'));
    fireEvent.click(screen.getByTestId('pss-repo-row-org/backend'));

    fireEvent.click(screen.getByTestId('pss-import-submit'));

    expect(PROPS.onImported).toHaveBeenCalledTimes(1);
    const payload = PROPS.onImported.mock.calls[0][0];
    expect(payload.repos).toHaveLength(2);
    expect(payload.repos[0].full_name).toBe('org/frontend');
    expect(payload.repos[1].full_name).toBe('org/backend');
    expect(payload.name).toBe('frontend');
  });

  it('单选提交：保持原 repo 对象形态（向后兼容）', async () => {
    render(<ProjectSourceSelect {...PROPS} />);
    fireEvent.click(screen.getByRole('button', { name: /select repository/i }));
    fireEvent.click(await screen.findByTestId('pss-repo-row-org/frontend'));

    fireEvent.click(screen.getByTestId('pss-import-submit'));

    const payload = PROPS.onImported.mock.calls.at(-1)[0];
    expect(payload.full_name).toBe('org/frontend');
    expect(payload.repos).toBeUndefined();
  });

  it('取消全部勾选后重新开放所有仓库', async () => {
    render(<ProjectSourceSelect {...PROPS} />);
    fireEvent.click(screen.getByRole('button', { name: /select repository/i }));
    fireEvent.click(await screen.findByTestId('pss-repo-row-org/frontend'));
    fireEvent.click(screen.getByTestId('pss-repo-row-org/frontend'));

    expect(screen.getByTestId('pss-repo-row-other/infra')).not.toBeDisabled();
    expect(screen.getByTestId('pss-import-submit')).toBeDisabled();
    expect(gitApi.listRepos).toHaveBeenCalled();
  });
});
