import i18n from '../i18n';

/**
 * 相对时间（locale 感知），基于 Intl.RelativeTimeFormat。
 * locale 缺省取当前 i18n 语言（zh → "10 分钟前"/"昨天"，en → "10 minutes ago"/"yesterday"）。
 * 超过 30 天回退本地化日期。显式传 locale 可覆盖。
 */
export function formatRelativeTime(timestamp, locale = i18n.language) {
  if (!timestamp) return '';
  const diffSeconds = Math.floor((Date.now() - timestamp) / 1000);
  const tag = locale || undefined;
  const rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
  if (diffSeconds < 60) return rtf.format(-diffSeconds, 'second');
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 30) return rtf.format(-days, 'day');
  return new Date(timestamp).toLocaleDateString(tag, { month: 'short', day: 'numeric' });
}
