import { useCallback, useState } from 'react';

const KEYBOARD_STEP = 16;
const KEYBOARD_LARGE_STEP = 64;

// 可拖拽分隔条（业界 sash 模式）：热区 6px 透明，可见线仅 1px（hover/拖拽高亮）——
// 可见宽条会有双线割裂感。键盘可达（VS Code 对齐），双击复位，无 focus ring（DESIGN 规范）。
export default function Sash({
  onStartResize,
  onReset,
  onNudge,
  dragging = false,
  width,
  min,
  max,
  alwaysVisible = false,
  title,
}) {
  const [focused, setFocused] = useState(false);

  const handleKeyDown = useCallback(
    (e) => {
      const large = e.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          onNudge?.(-large);
          break;
        case 'ArrowRight':
          e.preventDefault();
          onNudge?.(large);
          break;
        case 'Home':
          e.preventDefault();
          onNudge?.(min - width);
          break;
        case 'End':
          e.preventDefault();
          onNudge?.(max - width);
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          onReset?.();
          break;
        default:
          break;
      }
    },
    [onNudge, onReset, min, max, width],
  );

  const highlight = dragging || focused;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={title}
      tabIndex={0}
      title={title}
      onPointerDown={onStartResize}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className="relative w-1.5 shrink-0 cursor-col-resize select-none touch-none outline-none z-10"
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-150 ${
          highlight
            ? 'bg-zinc-900'
            : alwaysVisible
              ? 'bg-zinc-200 hover:bg-zinc-900'
              : 'bg-transparent hover:bg-zinc-900'
        }`}
      />
    </div>
  );
}
