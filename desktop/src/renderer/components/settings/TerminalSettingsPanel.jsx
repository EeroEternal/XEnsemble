import React from 'react';
import { useTerminalTheme } from '../../hooks/useTerminalTheme.jsx';
import { useToast } from '../Toast';
import { consoleFormLabelClass, consoleSectionLabelClass, textSecondary } from '../../lib/consoleTheme';

function ThemePreviewSwatch({ preset }) {
  const { xterm } = preset;
  return (
    <div
      className="flex h-9 min-w-[5.5rem] items-center justify-center gap-2 rounded-md border border-[#E8EAED] px-2 font-mono text-xs"
      style={{ backgroundColor: xterm.background }}
      aria-hidden
    >
      <span style={{ color: xterm.red }}>A</span>
      <span style={{ color: xterm.green }}>A</span>
      <span style={{ color: xterm.blue }}>A</span>
    </div>
  );
}

export default function TerminalSettingsPanel() {
  const { themeId, catalog, setThemeId } = useTerminalTheme();
  const { showToast } = useToast();

  const handleChange = (event) => {
    const nextId = event.target.value;
    setThemeId(nextId, {
      onAppearanceChange: (prevAppearance, nextAppearance) => {
        if (prevAppearance !== nextAppearance) {
          showToast(
            'error',
            'Switching light/dark theme requires a new session for the agent input bar to fully sync.',
          );
        }
      },
    });
  };

  const active = catalog.find((entry) => entry.id === themeId) ?? catalog[0];

  return (
    <div className="space-y-4 max-w-md">
      <div>
        <h3 className="text-base font-semibold text-[#202124]">Terminal</h3>
        <p className={`mt-1 text-sm ${textSecondary}`}>
          The toolbar above the terminal can switch color schemes instantly; this is the same preference. If the agent input bar does not update, switch workspace or start a new session.
        </p>
      </div>

      <div>
        <label htmlFor="terminal-theme-select" className={consoleFormLabelClass}>
          Color scheme
        </label>
        <div className="mt-2 flex items-center gap-3">
          <select
            id="terminal-theme-select"
            value={themeId}
            onChange={handleChange}
            className="h-9 min-w-0 flex-1 rounded-md border border-[#DADCE0] bg-white px-3 text-sm text-[#202124] focus:border-[#5B8DB8] focus:outline-none focus:ring-1 focus:ring-[#5B8DB8]"
          >
            {catalog.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
          {active ? <ThemePreviewSwatch preset={active} /> : null}
        </div>
        <p className={`mt-2 text-xs ${textSecondary}`}>
          Color scheme reference{' '}
          <a
            href="https://terminalcolors.com/"
            className="text-[#5B8DB8] hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            terminalcolors.com
          </a>
        </p>
      </div>

      <div className="rounded-md border border-[#E8EAED] bg-[#FAFBFC] p-3">
        <p className={consoleSectionLabelClass}>Preview</p>
        <div
          className="mt-2 rounded-md p-3 font-mono text-[13px] leading-relaxed"
          style={{
            backgroundColor: active?.xterm.background,
            color: active?.xterm.foreground,
          }}
        >
          <span style={{ color: active?.xterm.green }}>$ </span>
          echo hello
          <br />
          <span style={{ color: active?.xterm.foreground }}>hello</span>
          <br />
          <span style={{ color: active?.xterm.red }}>error</span>
          {' '}
          <span style={{ color: active?.xterm.yellow }}>warn</span>
          {' '}
          <span style={{ color: active?.xterm.blue }}>info</span>
        </div>
      </div>
    </div>
  );
}
