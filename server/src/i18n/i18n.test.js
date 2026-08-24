const { describe, it } = require('node:test');
const assert = require('node:assert');
const { detectLocale } = require('./localeDetector');

describe('localeDetector', () => {
  it('returns "en" when no Accept-Language header', () => {
    assert.strictEqual(detectLocale({ headers: {} }), 'en');
  });

  it('returns "en" when Accept-Language is English', () => {
    assert.strictEqual(detectLocale({ headers: { 'accept-language': 'en-US,en;q=0.9' } }), 'en');
  });

  it('returns "zh" when Accept-Language is Chinese', () => {
    assert.strictEqual(detectLocale({ headers: { 'accept-language': 'zh-CN,zh;q=0.9' } }), 'zh');
  });

  it('returns "zh" for zh-TW', () => {
    assert.strictEqual(detectLocale({ headers: { 'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8' } }), 'zh');
  });

  it('returns "en" for non-Chinese languages', () => {
    assert.strictEqual(detectLocale({ headers: { 'accept-language': 'ja,en;q=0.8' } }), 'en');
  });

  it('handles null request gracefully', () => {
    assert.strictEqual(detectLocale(null), 'en');
  });

  it('handles undefined headers', () => {
    assert.strictEqual(detectLocale({}), 'en');
  });
});
