import { useCallback, useEffect, useRef, useState } from 'react';

function readStoredWidth(storageKey, fallback, effectiveMax) {
  try {
    const raw = storageKey ? window.localStorage.getItem(storageKey) : null;
    if (raw === null) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed <= 0) return fallback;
    return Math.min(effectiveMax, Math.max(0, parsed));
  } catch {
    return fallback;
  }
}

function writeStoredWidth(storageKey, width) {
  if (!storageKey) return;
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    /* ignore */
  }
}

function effectiveMaxWidth(max, viewportReserve) {
  if (typeof window === 'undefined' || viewportReserve <= 0) return max;
  return Math.min(max, window.innerWidth - viewportReserve);
}

// 可拖拽分隔条（sash）的共享逻辑，移植自 Sessions.jsx 的 startPanelResize：
// min/max 钳制、RAF 节流、拖拽期禁用过渡、iframe 吞事件兜底、宽度持久化。
export function usePanelResize({
  storageKey = null,
  defaultWidth = 272,
  min = 200,
  max = 420,
  direction = 'left', // 'left' 面板在左、sash 在右缘：右拖加宽；'right' 反向
  viewportReserve = 0,
  guardRef = null,
  onTap = null,
}) {
  const clamp = useCallback(
    (w) => {
      const effMax = effectiveMaxWidth(max, viewportReserve);
      return Math.min(effMax, Math.max(min, w));
    },
    [min, max, viewportReserve],
  );

  const [width, setWidthState] = useState(() =>
    clamp(readStoredWidth(storageKey, defaultWidth, effectiveMaxWidth(max, viewportReserve))),
  );
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const setWidth = useCallback(
    (next, { persist = false } = {}) => {
      setWidthState((prev) => {
        const value = typeof next === 'function' ? next(prev) : next;
        const clamped = clamp(value);
        if (persist) writeStoredWidth(storageKey, clamped);
        return clamped;
      });
    },
    [clamp, storageKey],
  );

  const reset = useCallback(() => {
    setWidth(defaultWidth, { persist: true });
  }, [defaultWidth, setWidth]);

  const nudge = useCallback(
    (delta) => {
      setWidth((prev) => prev + delta, { persist: true });
    },
    [setWidth],
  );

  const tapTimerRef = useRef(null);
  const cancelPendingTap = useCallback(() => {
    if (tapTimerRef.current) {
      clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
    }
  }, []);

  const startResize = useCallback(
    (e) => {
      if (!e || e.button !== 0) return;
      e.preventDefault();
      // 双击的第二下按下会取消待触发的 tap，避免"双击复位"误触发点击隐藏。
      cancelPendingTap();
      const startX = e.clientX;
      const startW = widthRef.current;
      let moved = false;
      let latestNext = startW;
      let rafId = null;

      // 拖拽期间禁用 guardRef 容器指针事件：iframe（部署/浏览器预览）会吞掉
      // pointermove/pointerup，导致拖拽冻结；pointer-events:none 让事件穿透。
      // 注：setPointerCapture 已在现代浏览器层面解决该问题，这里保留双保险。
      const guard = guardRef?.current;
      if (guard) guard.style.pointerEvents = 'none';
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        /* jsdom / 部分环境无活动指针时会抛，忽略 */
      }

      const applyWidth = () => {
        rafId = null;
        setWidth(latestNext);
      };

      const finish = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('keydown', onKeyDown);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (guard) guard.style.pointerEvents = '';
        setDragging(false);
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      };

      const onMove = (ev) => {
        const deltaRaw = startX - ev.clientX;
        if (Math.abs(ev.clientX - startX) > 3) {
          moved = true;
          setDragging(true);
        }
        const delta = direction === 'right' ? deltaRaw : -deltaRaw;
        latestNext = startW + delta;
        if (rafId === null) rafId = requestAnimationFrame(applyWidth);
      };

      // 按下后未拖动就松开 = tap。延迟触发以让位于双击复位：第二次 pointerdown 会取消。
      const onUp = () => {
        finish();
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          applyWidth();
        }
        if (moved) {
          setWidth(latestNext, { persist: true });
        } else if (onTap) {
          cancelPendingTap();
          tapTimerRef.current = setTimeout(() => {
            tapTimerRef.current = null;
            onTap();
          }, 250);
        }
      };

      const onKeyDown = (ev) => {
        if (ev.key !== 'Escape') return;
        latestNext = startW;
        finish();
        setWidth(startW);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('keydown', onKeyDown);
    },
    [direction, guardRef, onTap, setWidth, cancelPendingTap],
  );

  // 窗口尺寸变化时把宽度钳回有效上限（viewportReserve/max 依赖 innerWidth 的场景）。
  useEffect(() => {
    const onResize = () => setWidth((prev) => clamp(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp, setWidth]);

  // sash 可能在拖拽中途卸载（折叠、切 tab）：强制收尾，还原 body 样式与 guard。
  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (guardRef?.current) guardRef.current.style.pointerEvents = '';
    };
  }, [guardRef]);

  useEffect(() => () => cancelPendingTap(), [cancelPendingTap]);

  return { width, startResize, dragging, reset, nudge, setWidth };
}
