import { Eye, EyeOff } from 'lucide-react';
import { cn } from '../lib/utils';
import { consoleInputClass, consoleIconButtonClass } from '../lib/consoleTokens';
import { maskApiKey } from '../lib/maskApiKey';

export default function MaskedApiKeyInput({
  value,
  maskedPreview,
  revealed,
  canToggle,
  onToggleReveal,
  onChange,
  placeholder = 'API Key',
  'aria-label': ariaLabel = 'API Key',
  className,
}) {
  const displayValue = revealed ? value : (maskedPreview || (value ? maskApiKey(value) : ''));

  return (
    <div className={cn('relative', className)}>
      <input
        type="text"
        value={displayValue}
        onChange={(e) => onChange(e.target.value)}
        readOnly={!revealed && Boolean(displayValue)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onFocus={(e) => {
          if (!revealed && displayValue) {
            e.target.select();
          }
        }}
        autoComplete="off"
        spellCheck={false}
        className={cn(consoleInputClass, 'pr-10 font-mono')}
      />
      {canToggle && (
        <button
          type="button"
          onClick={onToggleReveal}
          className={cn(consoleIconButtonClass, 'absolute right-1 top-1/2 -translate-y-1/2')}
          title={revealed ? 'Hide API Key' : 'Show API Key'}
          aria-label={revealed ? 'Hide API Key' : 'Show API Key'}
        >
          {revealed ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      )}
    </div>
  );
}
