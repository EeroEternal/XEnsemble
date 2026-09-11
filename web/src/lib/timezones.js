/**
 * IANA 时区列表（LoopTask 调度与偏好面板共用）。
 * 与后端 routes/loopTasks.js 的 TIMEZONES 保持一致。
 */
export const TIMEZONES = [
  'UTC', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul',
  'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles',
];

export const DEFAULT_TIMEZONE = 'Asia/Shanghai';
