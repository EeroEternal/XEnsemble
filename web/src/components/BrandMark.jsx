import { cn } from '../lib/utils';

/** AgentHarness logo: three linked nodes (ensemble / orchestration). */
export default function BrandMark({ className, iconClassName }) {
  return (
    <div
      className={cn(
        // neutral 未被主题变量化（见 tailwind.config）——保证深浅模式下都是深底白图形，
        // zinc-* 会随 .dark 翻转导致深色模式下 logo 变白块
        'flex shrink-0 items-center justify-center rounded-lg bg-neutral-900',
        className,
      )}
      aria-hidden
    >
      <svg
        viewBox="0 0 24 24"
        className={cn('h-[18px] w-[18px]', iconClassName)}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle cx="6" cy="12" r="2.75" fill="white" />
        <circle cx="18" cy="6" r="2.75" fill="white" fillOpacity="0.88" />
        <circle cx="18" cy="18" r="2.75" fill="white" fillOpacity="0.88" />
        <path
          d="M8.6 11.1L15.4 7.4M8.6 12.9L15.4 16.6"
          stroke="white"
          strokeOpacity="0.55"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
