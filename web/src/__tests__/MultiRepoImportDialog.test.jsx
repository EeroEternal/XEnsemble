import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MultiRepoImportDialog } from '../components/MultiRepoImportDialog';

describe('MultiRepoImportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('不渲染当 open=false', () => {
    const { container } = render(<MultiRepoImportDialog open={false} onClose={() => {}} onSubmit={() => {}} />);
    expect(container.querySelector('[data-testid="multi-repo-import-dialog"]')).toBeNull();
  });

  it('打开时显示 1 个空行 + 添加按钮 + 取消/导入按钮', () => {
    render(<MultiRepoImportDialog open onClose={() => {}} onSubmit={() => {}} />);
    expect(screen.getAllByTestId(/^repo-row-/)).toHaveLength(1);
    expect(screen.getByTestId('add-row')).toBeInTheDocument();
    expect(screen.getByTestId('submit-button')).toBeInTheDocument();
  });

  it('点击 + Add repo 增加行', () => {
    render(<MultiRepoImportDialog open onClose={() => {}} onSubmit={() => {}} />);
    fireEvent.click(screen.getByTestId('add-row'));
    expect(screen.getAllByTestId(/^repo-row-/)).toHaveLength(2);
  });

  it('点击 × 移除行', () => {
    render(<MultiRepoImportDialog open onClose={() => {}} onSubmit={() => {}} />);
    fireEvent.click(screen.getByTestId('add-row'));
    const rows = screen.getAllByTestId(/^repo-row-/);
    const removeBtn = screen.getAllByTestId(/^remove-/)[1];
    fireEvent.click(removeBtn);
    expect(screen.getAllByTestId(/^repo-row-/)).toHaveLength(1);
  });

  it('单段 sub_path -> 提交按钮禁用', async () => {
    render(<MultiRepoImportDialog open onClose={() => {}} onSubmit={() => {}} />);
    const row = screen.getAllByTestId(/^repo-row-/)[0];
    const subpathInput = row.querySelector('[data-testid^="subpath-input-"]');
    const urlInput = row.querySelector('[data-testid^="url-input-"]');
    fireEvent.change(subpathInput, { target: { value: 'a' } });
    fireEvent.change(urlInput, { target: { value: 'https://x.com/a.git' } });
    await waitFor(() => {
      expect(screen.getByTestId('submit-button')).toBeDisabled();
    });
  });

  it('2 层 + 3 层混合合法 -> 分组预览显示 flat + merged', async () => {
    render(<MultiRepoImportDialog open onClose={() => {}} onSubmit={() => {}} />);
    const row0 = screen.getAllByTestId(/^repo-row-/)[0];
    fireEvent.change(row0.querySelector('[data-testid^="subpath-input-"]'), { target: { value: 'a/b' } });
    fireEvent.change(row0.querySelector('[data-testid^="url-input-"]'), { target: { value: 'https://x.com/a.git' } });
    fireEvent.click(screen.getByTestId('add-row'));
    const row1 = screen.getAllByTestId(/^repo-row-/)[1];
    fireEvent.change(row1.querySelector('[data-testid^="subpath-input-"]'), { target: { value: 'a/b/c' } });
    fireEvent.change(row1.querySelector('[data-testid^="url-input-"]'), { target: { value: 'https://x.com/c.git' } });
    await waitFor(() => {
      expect(screen.getByTestId('group-flat-0')).toBeInTheDocument();
      expect(screen.getByTestId('group-merged-1')).toBeInTheDocument();
    });
  });

  it('冲突前缀 a/b + a/c -> 显示错误且提交禁用', async () => {
    render(<MultiRepoImportDialog open onClose={() => {}} onSubmit={() => {}} />);
    const row0 = screen.getAllByTestId(/^repo-row-/)[0];
    fireEvent.change(row0.querySelector('[data-testid^="subpath-input-"]'), { target: { value: 'a/b' } });
    fireEvent.change(row0.querySelector('[data-testid^="url-input-"]'), { target: { value: 'https://x.com/a.git' } });
    fireEvent.click(screen.getByTestId('add-row'));
    const row1 = screen.getAllByTestId(/^repo-row-/)[1];
    fireEvent.change(row1.querySelector('[data-testid^="subpath-input-"]'), { target: { value: 'a/c' } });
    fireEvent.change(row1.querySelector('[data-testid^="url-input-"]'), { target: { value: 'https://x.com/c.git' } });
    await waitFor(() => {
      expect(screen.getByTestId('grouping-error')).toBeInTheDocument();
      expect(screen.getByTestId('submit-button')).toBeDisabled();
    });
  });

  it('3 个 3 层共享 a/b -> 1 merged group 下拉 3 项', async () => {
    render(<MultiRepoImportDialog open onClose={() => {}} onSubmit={() => {}} />);
    const inputs = ['a/b/c', 'a/b/d', 'a/b/e'];
    const urls = ['https://x.com/c.git', 'https://x.com/d.git', 'https://x.com/e.git'];
    const row0 = screen.getAllByTestId(/^repo-row-/)[0];
    fireEvent.change(row0.querySelector('[data-testid^="subpath-input-"]'), { target: { value: inputs[0] } });
    fireEvent.change(row0.querySelector('[data-testid^="url-input-"]'), { target: { value: urls[0] } });
    fireEvent.click(screen.getByTestId('add-row'));
    fireEvent.click(screen.getByTestId('add-row'));
    const rows = screen.getAllByTestId(/^repo-row-/);
    for (let i = 1; i < 3; i++) {
      fireEvent.change(rows[i].querySelector('[data-testid^="subpath-input-"]'), { target: { value: inputs[i] } });
      fireEvent.change(rows[i].querySelector('[data-testid^="url-input-"]'), { target: { value: urls[i] } });
    }
    await waitFor(() => {
      expect(screen.getByTestId('group-merged-0')).toBeInTheDocument();
      const dropdown = screen.getByTestId('merged-dropdown-0');
      expect(dropdown.querySelectorAll('option')).toHaveLength(3);
    });
  });

  it('合法输入 -> onSubmit 被调用且 payload 正确', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<MultiRepoImportDialog open onClose={() => {}} onSubmit={onSubmit} />);
    const row0 = screen.getAllByTestId(/^repo-row-/)[0];
    fireEvent.change(row0.querySelector('[data-testid^="subpath-input-"]'), { target: { value: 'a/b/c' } });
    fireEvent.change(row0.querySelector('[data-testid^="url-input-"]'), { target: { value: 'https://x.com/c.git' } });
    fireEvent.click(screen.getByTestId('add-row'));
    const row1 = screen.getAllByTestId(/^repo-row-/)[1];
    fireEvent.change(row1.querySelector('[data-testid^="subpath-input-"]'), { target: { value: 'a/b/d' } });
    fireEvent.change(row1.querySelector('[data-testid^="url-input-"]'), { target: { value: 'https://x.com/d.git' } });
    await waitFor(() => {
      expect(screen.getByTestId('submit-button')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('submit-button'));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
      const arg = onSubmit.mock.calls[0][0];
      expect(arg.repos).toHaveLength(2);
      expect(arg.repos[0].sub_path).toBe('a/b/c');
      expect(arg.repos[0].is_primary).toBe(true);
      expect(arg.repos[1].is_primary).toBe(false);
    });
  });

  it('onSubmit 失败显示 submitError', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('network error'));
    render(<MultiRepoImportDialog open onClose={() => {}} onSubmit={onSubmit} />);
    const row0 = screen.getAllByTestId(/^repo-row-/)[0];
    fireEvent.change(row0.querySelector('[data-testid^="subpath-input-"]'), { target: { value: 'a/b/c' } });
    fireEvent.change(row0.querySelector('[data-testid^="url-input-"]'), { target: { value: 'https://x.com/c.git' } });
    await waitFor(() => {
      expect(screen.getByTestId('submit-button')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('submit-button'));
    await waitFor(() => {
      expect(screen.getByTestId('submit-error')).toBeInTheDocument();
      expect(screen.getByTestId('submit-error').textContent).toContain('network error');
    });
  });

  it('点击遮罩关闭弹窗', () => {
    const onClose = vi.fn();
    render(<MultiRepoImportDialog open onClose={onClose} onSubmit={() => {}} />);
    const overlay = screen.getByTestId('multi-repo-import-dialog');
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点击 X 关闭弹窗', () => {
    const onClose = vi.fn();
    render(<MultiRepoImportDialog open onClose={onClose} onSubmit={() => {}} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
