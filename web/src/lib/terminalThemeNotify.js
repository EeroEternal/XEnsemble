/**
 * 「主题变更通知 PTY 内 TUI」的去重与时机判定（Web 客户端）。
 *
 * 背景：e7596e2 起 AgentConsole 会在主题变化时把
 *   `ESC ]10;rgb:<fg> ST` + `ESC ]11;rgb:<bg> ST` + `ESC [?997;<mode>n`
 * 作为 **PTY 输入** 发给前台 TUI（触发它重新探测/换色）。但那段 effect 的依赖项
 * `xtermTheme` 是组件里每次 render 新建的对象，于是每次挂载/重渲染都会重发；
 * `Sessions.jsx` 又是 `<AgentConsole key={activeSession.sessionId}>`，切会话即重新
 * 挂载 —— 结果每次切换会话都往前台 TUI 的 stdin 灌一次 payload。TUI 若不在探测
 * 窗口内、又不认识这些通知，解析器会吃掉 `ESC ]` / `ESC [?`，剩下的可打印部分
 * （`10;rgb:…11;rgb:…997;2n`）就以「被自动输入」的形式出现在它的输入框里。
 *
 * 因此通知必须满足「同一会话 + payload 真的变了」：
 *   - 首次看到某会话（本浏览器无记录）→ 只登记基线、**不发送**：新会话的配色由
 *     服务端注入的 `COLORFGBG` 与 TUI 自己的启动探测（实时应答）负责；
 *   - 与基线相同 → 不发送（切回会话、重连、无关重渲染都属于这类）；
 *   - 与基线不同（用户真的换了主题）→ 更新基线并发送。
 *
 * 记录存 sessionStorage（同 AgentConsole 里 `xe_term_seq_<id>` 游标缓存的写法），
 * 组件重新挂载也不会丢失「已通知过」。
 *
 * 已知取舍：若判定要发送时 WebSocket 恰好不在 OPEN，基线仍会前移，该会话会漏掉
 * 这一次通知（表现为 TUI 沿用旧配色，直到下次换主题）。相对于「往 TUI 灌字节」，
 * 这个方向的降级是安全的。
 */

const STORAGE_PREFIX = 'xe_term_theme_notified_';

function sessionStore() {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * 是否应把该 payload 发给该会话的 PTY（同时维护基线）。
 * @param {string} sessionId
 * @param {string} payload
 * @returns {boolean}
 */
export function shouldNotifyTuiTheme(sessionId, payload) {
  if (!sessionId || !payload) return false;
  const store = sessionStore();
  if (!store) return false;
  const key = `${STORAGE_PREFIX}${sessionId}`;
  let previous;
  try {
    previous = store.getItem(key);
  } catch {
    return false;
  }
  try {
    store.setItem(key, payload);
  } catch {
    /* 写不进去就当作「无基线」，不发送，避免重复灌字节 */
  }
  return previous != null && previous !== payload;
}

/** 清掉某会话的基线（测试/排障用）。 */
export function resetTuiThemeNotification(sessionId) {
  const store = sessionStore();
  if (!store || !sessionId) return;
  try {
    store.removeItem(`${STORAGE_PREFIX}${sessionId}`);
  } catch {
    /* ignore */
  }
}
