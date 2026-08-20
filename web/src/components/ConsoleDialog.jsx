import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/utils';
import {
  consoleBackdropClass,
  consoleDialogPanelClass,
  consoleStructuredDialogBodyClass,
  consoleStructuredDialogFooterClass,
  consoleStructuredDialogHeaderClass,
} from '../lib/consoleTokens';

export function useConsoleDialogEscape(onClose, active = true) {
  useEffect(() => {
    if (!active || !onClose) return;
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, active]);
}

export function ConsoleDialogBackdrop({ className, onClick }) {
  return (
    <div
      className={cn(consoleBackdropClass, className)}
      aria-hidden
      onClick={onClick}
    />
  );
}

export function ConsoleDialogPanel({ className, children, ...props }) {
  return (
    <div className={cn(consoleDialogPanelClass, className)} {...props}>
      {children}
    </div>
  );
}

/** ParaRouter structured dialog sections — DESIGN.md § Modals / Dialogs */
export function ConsoleStructuredDialogHeader({ title, subtitle, className, children }) {
  return (
    <div className={cn(consoleStructuredDialogHeaderClass, className)}>
      {children ?? (
        <div>
          <h3 className="font-bold text-lg text-zinc-900">{title}</h3>
          {subtitle ? <p className="text-xs text-zinc-500 mt-0.5">{subtitle}</p> : null}
        </div>
      )}
    </div>
  );
}

export function ConsoleStructuredDialogBody({ className, children }) {
  return (
    <div className={cn(consoleStructuredDialogBodyClass, className)}>
      {children}
    </div>
  );
}

export function ConsoleStructuredDialogFooter({ className, children }) {
  return (
    <div className={cn(consoleStructuredDialogFooterClass, className)}>
      {children}
    </div>
  );
}

/** Standard ConsoleDialog shell: backdrop + centered panel, Escape / backdrop close.
 *  `container`: 传入时把弹窗挂载到该容器内（容器需 relative），面板在容器中间居中；
 *  默认挂载到 document.body（整个页面中间）。 */
export function ConsoleDialogShell({
  onClose,
  container,
  backdropClassName,
  shellClassName,
  panelClassName,
  panelProps,
  children,
  /** Content-sized panel: height follows children, no inner scroll container. */
  fitContent = false,
}) {
  useConsoleDialogEscape(onClose);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const resolvedShellClass = shellClassName
    ?? (container
      ? 'absolute inset-0 z-[101] flex items-center justify-center p-4 pointer-events-none'
      : 'fixed inset-0 z-[101] flex items-center justify-center p-4 pointer-events-none');

  const panel = fitContent ? (
    <div
      className={cn('pointer-events-auto', panelClassName)}
      role="dialog"
      aria-modal="true"
      {...panelProps}
    >
      {children}
    </div>
  ) : (
    <ConsoleDialogPanel
      className={cn('pointer-events-auto', panelClassName)}
      role="dialog"
      aria-modal="true"
      {...panelProps}
    >
      {children}
    </ConsoleDialogPanel>
  );

  const mount = container || document.body;
  const backdrop = container ? (
    <div className="absolute inset-0 bg-black/50" aria-hidden onClick={onClose} />
  ) : (
    <ConsoleDialogBackdrop className={cn('z-[100]', backdropClassName)} onClick={onClose} />
  );

  return createPortal(
    (
      <>
        {backdrop}
        <div className={resolvedShellClass}>
          {panel}
        </div>
      </>
    ),
    mount,
  );
}

/** Inline anchored dialog used for native desktop style confirmations/modals. */
export function ConsoleInlineDialog({ onClose, panelClassName, children }) {
  useConsoleDialogEscape(onClose);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return createPortal(
    <>
      <ConsoleDialogBackdrop className="z-[100]" onClick={onClose} />
      <div className="fixed inset-0 z-[110] flex items-start justify-center p-4 pointer-events-none">
        <div
          role="dialog"
          aria-modal="true"
          className={cn('pointer-events-auto mt-[12vh] min-w-[260px] rounded-lg border shadow-lg', panelClassName)}
        >
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}

