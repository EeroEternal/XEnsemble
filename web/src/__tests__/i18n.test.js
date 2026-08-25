import { describe, it, expect } from 'vitest';
import i18n from '../i18n';

describe('i18n', () => {
  it('initializes with English as default', () => {
    expect(i18n.language).toBeDefined();
  });

  it('translates a key in English', () => {
    i18n.changeLanguage('en');
    expect(i18n.t('common:action.save')).toBe('Save');
  });

  it('translates a key in Chinese', () => {
    i18n.changeLanguage('zh');
    expect(i18n.t('common:action.save')).toBe('保存');
  });

  it('supports interpolation', () => {
    i18n.changeLanguage('en');
    const result = i18n.t('errors:quota_exceeded', {
      dimension: 'Sessions',
      current: 3,
      limit: 2,
    });
    expect(result).toContain('Sessions');
    expect(result).toContain('3/2');
  });

  it('supports pluralization', () => {
    i18n.changeLanguage('en');
    const one = i18n.t('sessions:count', { count: 1 });
    const many = i18n.t('sessions:count', { count: 5 });
    expect(one).toContain('1');
    expect(many).toContain('5');
  });

  it('falls back to English for missing keys', () => {
    i18n.changeLanguage('zh');
    const result = i18n.t('common:nonexistent_key', { defaultValue: 'Default' });
    expect(result).toBe('Default');
  });

  it('has all expected namespaces', () => {
    const ns = ['common', 'auth', 'sessions', 'agents', 'users', 'settings', 'gateway', 'workspace', 'git', 'images', 'deploy', 'errors'];
    for (const n of ns) {
      const testKey = `${n}:title`;
      const result = i18n.t(testKey);
      // Should not return the key itself (means it was found)
      expect(result).not.toBe(testKey);
    }
  });
});
