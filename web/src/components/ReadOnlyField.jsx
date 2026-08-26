/**
 * Read-only label:value row for settings display mode.
 *
 * Height matches the edit-mode Input row (h-8 = 32px) so toggling
 * between view/edit does not cause layout shift (DESIGN.md §页面稳定性).
 */
export default function ReadOnlyField({
  label,
  value,
  mono = false,
  emptyText = '—',
}) {
  const display = value || emptyText;
  const isEmpty = !value;
  return (
    <div className="flex items-center justify-between gap-4 min-h-[38px] py-1">
      <span className="text-xs text-zinc-500 shrink-0">{label}</span>
      <span
        className={`text-sm text-right ${mono ? 'font-mono' : ''} ${
          isEmpty ? 'text-zinc-400' : 'text-zinc-900'
        }`}
      >
        {display}
      </span>
    </div>
  );
}
