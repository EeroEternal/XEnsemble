import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import Sash from '@/components/Sash';
import { usePanelResize } from '@/hooks/usePanelResize';

// 挂载 hook + Sash 的小测试壳：宽度渲染到 div 便于断言 inline style（jsdom 无布局）。
function Harness({ hookProps, sashProps = {} }) {
  const r = usePanelResize(hookProps);
  return (
    <div>
      <div data-testid="panel" style={{ width: r.width }} />
      <Sash
        onStartResize={r.startResize}
        onReset={r.reset}
        onNudge={r.nudge}
        dragging={r.dragging}
        width={r.width}
        min={hookProps.min}
        max={hookProps.max}
        title="resize"
        {...sashProps}
      />
    </div>
  );
}

const BASE = {
  storageKey: 'test.sash.width',
  defaultWidth: 272,
  min: 200,
  max: 420,
};

function pointerDown(el) {
  fireEvent.pointerDown(el, { button: 0, clientX: 100, pointerId: 1 });
}
function pointerMove(clientX) {
  fireEvent.pointerMove(window, { clientX, pointerId: 1 });
}
function pointerUp(clientX) {
  fireEvent.pointerUp(window, { clientX, pointerId: 1 });
}
function drag(el, fromX, toX) {
  act(() => {
    pointerDown(el);
    pointerMove(toX);
    pointerUp(toX);
  });
}

describe('usePanelResize + Sash', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders default width and separator a11y attributes', () => {
    render(<Harness hookProps={BASE} />);
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '272px' });
    const sash = screen.getByRole('separator');
    expect(sash).toHaveAttribute('aria-valuenow', '272');
    expect(sash).toHaveAttribute('aria-valuemin', '200');
    expect(sash).toHaveAttribute('aria-valuemax', '420');
  });

  it('restores persisted width and falls back to default on garbage', () => {
    localStorage.setItem('test.sash.width', '300');
    const { unmount } = render(<Harness hookProps={BASE} />);
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '300px' });
    unmount();

    localStorage.setItem('test.sash.width', 'not-a-number');
    render(<Harness hookProps={BASE} />);
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '272px' });
  });

  it('clamps persisted width to max', () => {
    localStorage.setItem('test.sash.width', '9999');
    render(<Harness hookProps={BASE} />);
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '420px' });
  });

  it('drags right to widen for direction left (panel on left, sash at right edge)', () => {
    render(<Harness hookProps={BASE} />);
    drag(screen.getByRole('separator'), 100, 160);
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '332px' });
  });

  it('drags left to widen for direction right (panel on right, sash at left edge)', () => {
    render(<Harness hookProps={{ ...BASE, direction: 'right' }} />);
    drag(screen.getByRole('separator'), 100, 60);
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '312px' });
  });

  it('clamps drag to min and max', () => {
    render(<Harness hookProps={BASE} />);
    drag(screen.getByRole('separator'), 100, 0);
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '200px' });

    drag(screen.getByRole('separator'), 100, 500);
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '420px' });
  });

  it('persists width after drag', () => {
    render(<Harness hookProps={BASE} />);
    drag(screen.getByRole('separator'), 100, 150);
    expect(localStorage.getItem('test.sash.width')).toBe('322');
  });

  it('double-click resets to default', () => {
    localStorage.setItem('test.sash.width', '400');
    render(<Harness hookProps={BASE} />);
    fireEvent.doubleClick(screen.getByRole('separator'));
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '272px' });
    expect(localStorage.getItem('test.sash.width')).toBe('272');
  });

  it('keyboard arrows nudge, Shift steps larger, Home/End jump to bounds, Enter resets', () => {
    render(<Harness hookProps={BASE} />);
    const sash = screen.getByRole('separator');
    fireEvent.keyDown(sash, { key: 'ArrowRight' });
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '288px' });
    fireEvent.keyDown(sash, { key: 'ArrowLeft', shiftKey: true });
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '224px' });
    fireEvent.keyDown(sash, { key: 'End' });
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '420px' });
    fireEvent.keyDown(sash, { key: 'Home' });
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '200px' });
    fireEvent.keyDown(sash, { key: 'Enter' });
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '272px' });
  });

  it('fires tap once on release without movement, and a following pointerdown cancels it', () => {
    vi.useFakeTimers();
    try {
      const onTap = vi.fn();
      render(<Harness hookProps={{ ...BASE, onTap }} />);
      const sash = screen.getByRole('separator');
      act(() => {
        pointerDown(sash);
        pointerUp(100);
      });
      expect(onTap).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(onTap).toHaveBeenCalledTimes(1);

      // 第二次按下（双击的第二下）在延迟期内取消 tap
      act(() => {
        pointerDown(sash);
        pointerUp(100);
      });
      act(() => {
        pointerDown(sash); // 取消
        vi.advanceTimersByTime(300);
      });
      expect(onTap).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dragging state toggles the visible-line highlight class', () => {
    render(<Harness hookProps={BASE} />);
    const sash = screen.getByRole('separator');
    const line = sash.querySelector('span');
    expect(line.className).not.toContain('bg-zinc-900');
    act(() => {
      pointerDown(sash);
      pointerMove(200);
    });
    expect(line.className).toContain('bg-zinc-900');
    act(() => {
      pointerUp(200);
    });
    expect(line.className).not.toContain('bg-zinc-900');
  });

  it('alwaysVisible renders a base zinc-200 line', () => {
    render(<Harness hookProps={BASE} sashProps={{ alwaysVisible: true }} />);
    const line = screen.getByRole('separator').querySelector('span');
    expect(line.className).toContain('bg-zinc-200');
  });

  it('escape cancels an in-flight drag', () => {
    render(<Harness hookProps={BASE} />);
    const sash = screen.getByRole('separator');
    act(() => {
      pointerDown(sash);
      pointerMove(160);
    });
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '272px' });
    // Esc 后拖拽已结束：继续 move 不再改宽度
    act(() => {
      pointerMove(300);
      pointerUp(300);
    });
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '272px' });
  });

  it('ignores non-primary button', () => {
    render(<Harness hookProps={BASE} />);
    const sash = screen.getByRole('separator');
    fireEvent.pointerDown(sash, { button: 2, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 200, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 200, pointerId: 1 });
    expect(screen.getByTestId('panel')).toHaveStyle({ width: '272px' });
  });

  it('viewportReserve clamps effective max against window width', () => {
    const original = window.innerWidth;
    try {
      window.innerWidth = 500;
      render(<Harness hookProps={{ ...BASE, viewportReserve: 200 }} />);
      // 有效 max = min(420, 500-200) = 300
      drag(screen.getByRole('separator'), 100, 500);
      expect(screen.getByTestId('panel')).toHaveStyle({ width: '300px' });
    } finally {
      window.innerWidth = original;
    }
  });
});
