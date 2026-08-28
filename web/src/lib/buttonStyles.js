import { cn } from './utils';

export const buttonBase =
  'inline-flex items-center justify-center gap-2 font-medium transition-colors focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 disabled:opacity-50 disabled:pointer-events-none';

export const buttonSizes = {
  sm: 'h-9 px-3 text-sm rounded-md',
  md: 'h-9 px-4 text-sm rounded-md',
  lg: 'px-8 py-3 text-base rounded-md',
};

export const buttonVariants = {
  primary: 'bg-zinc-900 text-zinc-50 hover:bg-zinc-800',
  secondary:
    'bg-transparent border border-zinc-300 text-zinc-900 hover:bg-zinc-50',
  ghost: 'p-2 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 rounded-md',
  danger: 'bg-red-600 text-white hover:bg-red-700',
};

export function buttonClass(variant = 'primary', size = 'md', className) {
  if (variant === 'ghost') {
    return cn(buttonBase, buttonVariants.ghost, className);
  }
  return cn(buttonBase, buttonVariants[variant], buttonSizes[size], className);
}
