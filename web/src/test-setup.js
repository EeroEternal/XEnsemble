import '@testing-library/jest-dom';
import { vi } from 'vitest';
import './i18n';

// Mock monacoSetup so tests don't load the full monaco-editor package
// (which requires browser APIs not available in jsdom).
vi.mock('@/lib/monacoSetup', () => ({}));
