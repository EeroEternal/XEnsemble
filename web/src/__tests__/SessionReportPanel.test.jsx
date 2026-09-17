import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SessionReportPanel from '@/components/trajectory/SessionReportPanel';

const FULL_REPORT = {
  session_id: 's1',
  status: 'ready',
  engine: 'rules+llm',
  exited: true,
  metrics: {
    turnCount: 12, userTurnCount: 5, toolCallCount: 20,
    errorCallCount: 1, snapshotCount: 1, corrections: 2,
  },
  issues: [
    { code: 'loop_detected', severity: 'critical', count: 3, evidence: [{ seq: 7, excerpt: '工具 Bash 以相同参数连续调用 3 次' }] },
    { code: 'file_rework', severity: 'warn', count: 3, evidence: [{ seq: 4, excerpt: 'a.js 被修改 3 次' }] },
  ],
  advice: {
    overall: '整体顺利',
    promptSuggestions: [
      { title: '先给验收标准', problem: '首次指令缺少期望结果', before: '改一下登录', after: '修复登录 bug：错误分支应显示 401 提示' },
    ],
    agentNotes: ['429 限流 2 次，建议错峰重试'],
  },
  llm_error: null,
};

function renderPanel(props = {}) {
  const onJumpToSeq = vi.fn();
  const onClose = vi.fn();
  const onCopyAfter = vi.fn();
  const utils = render(
    <SessionReportPanel
      report={FULL_REPORT}
      onClose={onClose}
      onJumpToSeq={onJumpToSeq}
      onCopyAfter={onCopyAfter}
      {...props}
    />,
  );
  return { ...utils, onJumpToSeq, onClose, onCopyAfter };
}

describe('SessionReportPanel', () => {
  beforeEach(() => {
    // jsdom 没有实现 clipboard
    if (!navigator.clipboard) {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue() }, configurable: true });
    } else {
      vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    }
  });

  it('renders advice, metrics and issues from a full report', () => {
    renderPanel();
    expect(screen.getByText('整体顺利')).toBeInTheDocument();
    expect(screen.getByText('先给验收标准')).toBeInTheDocument();
    expect(screen.getByText('改一下登录')).toBeInTheDocument();
    expect(screen.getByText('修复登录 bug：错误分支应显示 401 提示')).toBeInTheDocument();
    expect(screen.getByText('loop_detected')).toBeInTheDocument();
    expect(screen.getByText('429 限流 2 次，建议错峰重试')).toBeInTheDocument();
    // 指标值渲染
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('clicking evidence seq jumps to the trajectory entry', () => {
    const { onJumpToSeq } = renderPanel();
    fireEvent.click(screen.getByText(/工具 Bash 以相同参数连续调用/));
    expect(onJumpToSeq).toHaveBeenCalledWith(7);
  });

  it('copy button delegates the suggestion to onCopyAfter', () => {
    const { onCopyAfter } = renderPanel();
    // 测试环境 locale 为 en → title 是 'Copy'（点击前不可能出现 'Copied'）
    fireEvent.click(screen.getByTitle('Copy'));
    expect(onCopyAfter).toHaveBeenCalledWith(FULL_REPORT.advice.promptSuggestions[0]);
  });

  it('close button triggers onClose', () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByTitle('Close report'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('rules-only report shows LLM hint and no suggestion cards', () => {
    renderPanel({ report: { ...FULL_REPORT, advice: null, engine: 'rules' } });
    expect(screen.getByText(/LLM_ANALYZE_API_KEY/)).toBeInTheDocument();
    expect(screen.queryByText('先给验收标准')).not.toBeInTheDocument();
    // 规则层问题仍然展示
    expect(screen.getByText('loop_detected')).toBeInTheDocument();
  });

  it('clean session shows empty-state advice text', () => {
    renderPanel({
      report: {
        ...FULL_REPORT,
        issues: [],
        advice: { overall: '顺利', promptSuggestions: [], agentNotes: [] },
      },
    });
    expect(screen.getByText(/went smoothly|进展顺利/)).toBeInTheDocument();
    expect(screen.getByText(/process issues|未检测到/)).toBeInTheDocument();
  });

  it('null report (still loading) shows LLM hint fallback without crashing', () => {
    renderPanel({ report: null });
    expect(screen.getByText(/LLM_ANALYZE_API_KEY/)).toBeInTheDocument();
  });

  it('await waitFor resolves fetch-less render', async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(container.firstChild).toBeInTheDocument());
  });
});
