import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ images: [] }) }),
}));

const AppSidebar = (await import('@/components/AppSidebar')).default;

function renderSidebar(props = {}) {
  return render(
    <AppSidebar
      agents={[]}
      sessions={[]}
      activeSession={null}
      activeWorkspaceId={null}
      activeWorkspaceName={null}
      onSelectSession={vi.fn()}
      onNewSession={vi.fn()}
      onRequestDeleteSession={vi.fn()}
      user={{ role: 'user' }}
      onOpenSettings={vi.fn()}
      onOpenObservability={vi.fn()}
      onLogout={vi.fn()}
      onOpenLoopTasks={vi.fn()}
      {...props}
    />,
  );
}

describe('AppSidebar resizable width', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders at default width with a visible sash separator', () => {
    const { container } = renderSidebar();
    const aside = container.querySelector('aside');
    expect(aside).toBeInTheDocument();
    expect(aside.style.width).toBe('272px');

    const sash = screen.getByRole('separator');
    expect(sash).toBeInTheDocument();
    expect(sash).toHaveAttribute('aria-valuemin', '200');
    expect(sash).toHaveAttribute('aria-valuemax', '420');
  });

  it('restores persisted width and hides sash when collapsed', async () => {
    localStorage.setItem('xensemble.sidebar.width', '360');
    const { container } = renderSidebar();
    const aside = container.querySelector('aside');
    expect(aside.style.width).toBe('360px');

    fireEvent.click(screen.getByTitle('Collapse sidebar'));
    const collapsed = await screen.findByTestId('app-sidebar-collapsed');
    expect(collapsed).toBeInTheDocument();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });
});
