import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * The class-name helper every shadcn component calls.
 *
 * `clsx` flattens conditionals; `twMerge` resolves the conflicts that flattening leaves behind, so
 * a caller's `px-2` beats a variant's `px-4` instead of losing to whichever Tailwind happened to
 * emit last. Without the merge, overriding a component's padding would depend on stylesheet order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
