import { useEffect, useState } from 'react';

export function Editor({ value, onChange, language, theme, options, onMount }) {

  const [content, setContent] = useState(value || '');

  useEffect(() => {
    if (onMount) {
      onMount({
        addCommand: () => {},
        getModel: () => ({ getValue: () => content, setValue: (v) => { setContent(v); onChange?.(v); } }),
        getValue: () => content,
        setValue: (v) => { setContent(v); onChange?.(v); },
        onDidChangeModelContent: () => ({ dispose: () => {} }),
        dispose: () => {},
      });
    }
  }, []);

  const handleChange = (newValue) => {
    setContent(newValue);
    onChange?.(newValue);
  };

  return (
    <div data-testid="monaco-editor" data-language={language} data-theme={theme}>
      <textarea
        data-testid="monaco-textarea"
        value={content}
        onChange={(e) => handleChange(e.target.value)}
        readOnly={options?.readOnly}
      />
    </div>
  );
}

export function DiffEditor({ original, modified, language, theme }) {
  return (
    <div data-testid="monaco-diff-editor" data-language={language} data-theme={theme}>
      <div data-testid="diff-original">{original}</div>
      <div data-testid="diff-modified">{modified}</div>
    </div>
  );
}

export const loader = {
  config: () => {},
  init: () => Promise.resolve(),
};

export default Editor;