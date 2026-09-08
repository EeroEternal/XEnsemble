import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MultiRepoImportDialog } from '../components/MultiRepoImportDialog';

describe('smoke', () => {
  it('renders', () => {
    render(<MultiRepoImportDialog open onClose={() => {}} onSubmit={() => {}} />);
    expect(screen.getByTestId('multi-repo-import-dialog')).toBeInTheDocument();
  });
});
