/**
 * Read-only label:value row for settings display mode.
 *
 * Renders a horizontal label/value pair. When `value` is empty/null,
 * `emptyText` is shown (defaults to "—").
 */
export default function ReadOnlyField({
  label,
  value,
  mono = false,
  emptyText = '—',
}) {
  const display = value || emptyText;
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-xs text-zinc-500 shrink-0">{label}</span>
      <span
        className={`text-sm text-zinc-900 text-right ${
          mono ? 'font-mono' : ''
        }`}
      >
        {display}
      </span>
    </div>
  );
}
