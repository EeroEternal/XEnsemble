import { useCallback, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { FileWarning, Loader2, Copy, Scissors, ClipboardPaste, CheckSquare } from 'lucide-react';
import '@/lib/monacoSetup'; // Configure Monaco to load from local bundle, not CDN
import { useTranslation } from 'react-i18next';
import { useTheme } from '../hooks/useTheme';

const LANG_MAP = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  css: 'css',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  sh: 'shell',
  bash: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'plaintext',
  txt: 'plaintext',
  log: 'plaintext',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  vue: 'html',
  svelte: 'html',
  scss: 'scss',
  less: 'less',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
};

function inferLanguage(path) {
  if (!path) return 'plaintext';
  const ext = path.split('.').pop().toLowerCase();
  return LANG_MAP[ext] || 'plaintext';
}

const MEGABYTE = 1024 * 1024;
const LARGE_FILE_THRESHOLD = MEGABYTE;

export default function CodeEditor({ content, path, readOnly: readOnlyProp, isBinary, onSave, onChange, saving }) {
  const { t } = useTranslation();
  const { isDark } = useTheme();
  const editorRef = useRef(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const [ctxMenu, setCtxMenu] = useState(null);

  const canEdit = !readOnlyProp && !isBinary;
  const isReadOnly = !canEdit;

  const handleMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => onSaveRef.current?.()
    );

    // Monaco suppresses the browser contextmenu on its DOM and fires this
    // event instead. Use it to show our localized menu (Monaco's default
    // menu is disabled via options.contextmenu:false). e.event is an
    // IMouseEvent (posx/posy + browserEvent); read clientX/Y from the
    // underlying browser event — do NOT fall back to a screen-center guess.
    editor.onContextMenu((e) => {
      const browser = e?.event?.browserEvent;
      const x = browser?.clientX ?? e?.event?.posx;
      const y = browser?.clientY ?? e?.event?.posy;
      if (x == null || y == null) return;
      setCtxMenu({ x, y });
    });
  }, []);

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const execEditorCommand = useCallback((command) => {
    const editor = editorRef.current;
    if (!editor) return;
    try {
      if (command === 'cut') {
        editor.trigger('contextmenu', 'editor.action.clipboardCutAction', null);
      } else if (command === 'copy') {
        editor.trigger('contextmenu', 'editor.action.clipboardCopyAction', null);
      } else if (command === 'paste') {
        editor.trigger('contextmenu', 'editor.action.clipboardPasteAction', null);
      } else if (command === 'selectAll') {
        editor.trigger('contextmenu', 'editor.action.selectAll', null);
      }
    } catch { /* ignore */ }
    setCtxMenu(null);
  }, []);

  const handleKeyDown = useCallback((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      onSave?.();
    }
  }, [onSave]);

  const language = inferLanguage(path);

  if (isBinary) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-500">
        <FileWarning className="h-10 w-10" />
        <p className="text-sm font-medium">{t('workspace:label.binary_file', { defaultValue: 'Binary file' })}</p>
        <p className="text-xs">{path || t('workspace:label.cannot_display', { defaultValue: 'This file cannot be displayed in the editor' })}</p>
      </div>
    );
  }

  const isLarge = content && content.length > LARGE_FILE_THRESHOLD;
  const showToolbar = isReadOnly || isLarge || saving;

  const menuItems = [
    { key: 'cut', label: t('common:action.cut', { defaultValue: 'Cut' }), icon: Scissors, disabled: isReadOnly },
    { key: 'copy', label: t('common:action.copy', { defaultValue: 'Copy' }), icon: Copy },
    { key: 'paste', label: t('common:action.paste', { defaultValue: 'Paste' }), icon: ClipboardPaste, disabled: isReadOnly },
    { divider: true },
    { key: 'selectAll', label: t('common:action.select_all', { defaultValue: 'Select All' }), icon: CheckSquare },
  ];

  return (
    <div className="flex flex-col h-full w-full" onKeyDown={handleKeyDown}>
      {showToolbar && (
        <div className="flex items-center justify-between px-4 py-1.5 border-b border-zinc-200 bg-zinc-50">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            {isReadOnly ? <span>{t('workspace:label.read_only', { defaultValue: 'Read-only' })}</span> : null}
            {saving && (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('workspace:label.saving', { defaultValue: 'Saving…' })}
              </span>
            )}
            {isLarge && (
              <span className="inline-flex items-center gap-1 text-amber-700">
                <FileWarning className="h-3 w-3" />
                {t('workspace:label.file_large', { defaultValue: 'File is large ({{size}} MB), editing may be slow', size: Math.round(content.length / MEGABYTE) })}
              </span>
            )}
          </div>
        </div>
      )}
      <div
        className="flex-1 min-h-0 relative"
        onClick={closeCtxMenu}
      >
        <Editor
          height="100%"
          language={language}
          value={content}
          onChange={onChange}
          onMount={handleMount}
          theme={isDark ? 'vs-dark' : 'vs'}
          loading={
            <div className="flex items-center justify-center h-full gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
              <span className="text-sm text-zinc-400">{t('workspace:label.loading_editor', { defaultValue: 'Loading editor…' })}</span>
            </div>
          }
          options={{
            readOnly: isReadOnly,
            minimap: { enabled: false },
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            fontSize: 13,
            fontFamily: "'Noto Sans Mono', 'Fira Code', monospace",
            tabSize: 2,
            automaticLayout: true,
            renderLineHighlight: 'all',
            cursorBlinking: 'smooth',
            smoothScrolling: true,
            padding: { top: 12, bottom: 12 },
            contextmenu: false,
          }}
        />
        {ctxMenu && (
          <div
            className="fixed z-[120] min-w-[160px] bg-surface border border-zinc-200 rounded-md shadow-lg py-1"
            style={{ top: Math.min(ctxMenu.y, window.innerHeight - 180), left: Math.min(ctxMenu.x, window.innerWidth - 180) }}
            role="menu"
            onContextMenu={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
          >
            {menuItems.map((item, i) =>
              item.divider ? (
                <div key={`d${i}`} className="my-1 border-t border-zinc-200" />
              ) : (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => execEditorCommand(item.key)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 disabled:pointer-events-none"
                >
                  <item.icon className="h-3.5 w-3.5 text-zinc-400" />
                  {item.label}
                </button>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
