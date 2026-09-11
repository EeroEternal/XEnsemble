const AT_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

/**
 * 'YYYY-MM-DD HH:mm'（本地时区）→ epoch ms；格式错误或日期不存在（如 2 月 31 日）→ NaN。
 * LoopTask 单次执行（kind=at）的输入解析，DateTimeField 与页面共用。
 */
export function parseAtLocal(text) {
  const m = AT_RE.exec(String(text || '').trim());
  if (!m) return NaN;
  const dt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return (dt.getFullYear() === +m[1] && dt.getMonth() === +m[2] - 1 && dt.getDate() === +m[3])
    ? dt.getTime() : NaN;
}

/** epoch ms → 'YYYY-MM-DD HH:mm'（本地时区），编辑回填用 */
export function formatAtLocal(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
