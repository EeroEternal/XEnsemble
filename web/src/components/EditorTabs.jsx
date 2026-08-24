import { useState, memo } from 'react';
import { X } from 'lucide-react';
import { ConsoleDialogShell } from './ConsoleDialog';
import { consoleButtonFocusClass } from '@/lib/consoleTokens';
import { buttonClass } from '@/lib/buttonStyles';
import { useTranslation } from 'react-i18next';

const EditorTabs = memo(function EditorTabs({ tabs, activePath, onSelectTab, onCloseTab, onSaveTab }) {
  const { t } = useTranslation();
  const [closingTab, setClosingTab] = useState(null);

  const handleClose = (path) => {
    const tab = tabs.find((t) => t.path === path);
    if (!tab) return;
    const dirty = tab.content !== tab.originalContent;
    if (dirty) {
      setClosingTab(path);
      return;
    }
    onCloseTab?.(path);
  };

  const handleSaveAndClose = async () => {
    if (!closingTab) return;
    try {
      await onSaveTab?.(closingTab);
      onCloseTab?.(closingTab);
    } catch (_) {
      // Keep tab on save failure
    }
    setClosingTab(null);
  };

  const handleDiscardAndClose = () => {
    if (closingTab) {
      onCloseTab?.(closingTab);
    }
    setClosingTab(null);
  };

  const handleCancelClose = () => {
    setClosingTab(null);
  };

  return (
    <>
      <div className="flex items-center border-b border-zinc-200 bg-zinc-50 overflow-x-auto" data-testid="tab-list">
        {tabs.map((tab) => {
          const dirty = tab.content !== tab.originalContent;
          const isActive = tab.path === activePath;
          const displayName = tab.path.split('/').pop();
          return (
            <div
              key={tab.path}
              data-testid="tab"
              data-dirty={dirty ? 'true' : 'false'}
              data-active={isActive ? 'true' : 'false'}
              className={`group flex items-center gap-1.5 shrink-0 px-3 py-2 text-sm cursor-pointer border-r border-zinc-200 transition-colors duration-150 ${
                isActive
                  ? 'bg-white text-zinc-900 border-b-2 border-b-black -mb-px'
                  : 'text-zinc-500 hover:bg-zinc-100'
              }`}
              onClick={() => onSelectTab?.(tab.path)}
            >
              <span className="truncate max-w-[160px]">{displayName}</span>
              {dirty && <span className="text-red-600 text-xs leading-none">&#x2022;</span>}
              <button
                aria-label={t('workspace:action.close_tab', { name: tab.path })}
                className={`ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-zinc-200 transition-opacity ${consoleButtonFocusClass}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleClose(tab.path);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      {closingTab && (
        <ConsoleDialogShell
          onClose={handleCancelClose}
          panelClassName="max-w-sm"
        >
          <div className="p-4">
            <h3 className="font-bold text-lg text-zinc-900 mb-2">{t('workspace:label.unsaved_changes')}</h3>
            <p className="text-sm text-zinc-500 mb-4">
              {t('workspace:dialog.close_without_saving', { defaultValue: 'This file has unsaved changes. Close without saving?' })}
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={handleCancelClose} className={buttonClass('secondary', 'sm')}>
                {t('common:action.cancel')}
              </button>
              <button onClick={handleDiscardAndClose} className={buttonClass('secondary', 'sm')}>
                {t('workspace:action.dont_save', { defaultValue: "Don't Save" })}
              </button>
              <button onClick={handleSaveAndClose} className={buttonClass('primary', 'sm')}>
                {t('workspace:action.save')}
              </button>
            </div>
          </div>
        </ConsoleDialogShell>
      )}
    </>
  );
});

export default EditorTabs;
