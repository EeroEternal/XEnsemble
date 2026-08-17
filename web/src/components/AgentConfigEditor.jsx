import { useState } from 'react';
import { Loader2, FileText, Plus } from 'lucide-react';
import {
  consoleInputClass,
  textPrimary,
  textPlaceholder,
  transitionBase,
} from '../lib/consoleTokens';
import { isSecretPasswordField } from '../lib/secretLabels';

/**
 * Reusable agent configuration editor.
 * Renders config file textareas (from agent.config_schema) and env var key-value rows.
 *
 * @param {object|null} configSchema - agent's configSchema (configFiles array) or null
 * @param {Array} configFiles - [{ path, content }]
 * @param {Array} envVars - [{ key, value }]
 * @param {(files: Array) => void} onConfigFilesChange
 * @param {(vars: Array) => void} onEnvVarsChange
 * @param {boolean} loading - show loading spinner
 */
export default function AgentConfigEditor({
  configSchema,
  configFiles,
  envVars,
  onConfigFilesChange,
  onEnvVarsChange,
  loading = false,
}) {
  const [showConfigFiles, setShowConfigFiles] = useState(true);

  const handleConfigFileContent = (path, content) => {
    onConfigFilesChange(
      configFiles.some((f) => f.path === path)
        ? configFiles.map((f) => (f.path === path ? { ...f, content } : f))
        : [...configFiles, { path, content }]
    );
  };

  const handleLoadExample = (fileDecl) => {
    handleConfigFileContent(fileDecl.path, fileDecl.example || '');
  };

  const handleEnvKeyChange = (idx, key) => {
    onEnvVarsChange(envVars.map((p, i) => (i === idx ? { ...p, key } : p)));
  };
  const handleEnvValueChange = (idx, value) => {
    onEnvVarsChange(envVars.map((p, i) => (i === idx ? { ...p, value } : p)));
  };
  const handleRemoveEnv = (idx) => {
    onEnvVarsChange(envVars.filter((_, i) => i !== idx));
  };

  if (loading) {
    return (
      <p className={`text-sm ${textPlaceholder} flex items-center gap-2`}>
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </p>
    );
  }

  const hasConfigFiles = configSchema?.configFiles?.length > 0;

  return (
    <div className="space-y-4">
      {hasConfigFiles && (
        <div>
          <button
            type="button"
            onClick={() => setShowConfigFiles((v) => !v)}
            className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider ${textPlaceholder} hover:${textPrimary} ${transitionBase} mb-2`}
          >
            <FileText className="w-3.5 h-3.5" />
            Configuration Files
          </button>
          {showConfigFiles && (
            <div className="space-y-3">
              {configSchema.configFiles.map((fileDecl) => {
                const existing = configFiles.find((f) => f.path === fileDecl.path);
                return (
                  <div key={fileDecl.path} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className={`text-sm font-medium ${textPrimary}`}>{fileDecl.label}</span>
                        {fileDecl.description && (
                          <span className={`text-xs ${textPlaceholder} ml-2`}>{fileDecl.description}</span>
                        )}
                      </div>
                      {fileDecl.example && (
                        <button
                          type="button"
                          onClick={() => handleLoadExample(fileDecl)}
                          className={`text-xs font-medium ${textPlaceholder} hover:${textPrimary} ${transitionBase}`}
                        >
                          Load Example
                        </button>
                      )}
                    </div>
                    <textarea
                      value={existing?.content || ''}
                      onChange={(e) => handleConfigFileContent(fileDecl.path, e.target.value)}
                      className={`${consoleInputClass} font-mono text-xs resize-y`}
                      rows={8}
                      placeholder={fileDecl.example || `Enter ${fileDecl.format || 'text'} content…`}
                      spellCheck={false}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div>
        <label className={`block text-xs font-semibold uppercase tracking-wider ${textPlaceholder} mb-2`}>
          Environment Variables
        </label>
        <div className="space-y-2">
          {envVars.map((pair, idx) => (
            <div key={idx} className="flex gap-2 items-start">
              <input
                value={pair.key}
                onChange={(e) => handleEnvKeyChange(idx, e.target.value)}
                className={consoleInputClass}
                placeholder="ENV_VAR_NAME"
                autoComplete="off"
              />
              <input
                type={isSecretPasswordField(pair.key) ? 'password' : 'text'}
                value={pair.value}
                onChange={(e) => handleEnvValueChange(idx, e.target.value)}
                className={consoleInputClass}
                placeholder="value"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => handleRemoveEnv(idx)}
                className={`flex-shrink-0 mt-1.5 ${textPlaceholder} hover:text-red-600 ${transitionBase}`}
                title="Remove"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => onEnvVarsChange([...envVars, { key: '', value: '' }])}
            className={`flex items-center gap-1 text-sm ${textPlaceholder} hover:${textPrimary} ${transitionBase}`}
          >
            <Plus className="w-3.5 h-3.5" /> Add env var
          </button>
        </div>
      </div>
    </div>
  );
}
