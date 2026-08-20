let _sessionId = null;

export function setSessionContext(sessionId) {
  _sessionId = sessionId || null;
}

export function getSessionId() {
  return _sessionId;
}

export function withSessionId(url) {
  if (!_sessionId) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}session_id=${encodeURIComponent(_sessionId)}`;
}
