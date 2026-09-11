/**
 * Token 数量紧凑格式化：999 → "999"，12400 → "12.4K"，3140000 → "3.1M"，2.4e9 → "2.4B"。
 * 千位以下原样返回。
 */
export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1e6) return `${(v / 1e3).toFixed(v < 1e4 ? 1 : 0)}K`;
  if (v < 1e9) return `${(v / 1e6).toFixed(v < 1e7 ? 1 : 0)}M`;
  return `${(v / 1e9).toFixed(1)}B`;
}

/** 千分位完整格式：1234567 → "1,234,567" */
export function formatTokensFull(n) {
  return (Number(n) || 0).toLocaleString();
}
