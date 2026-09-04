import { cn } from '@/lib/utils.ts'
import { CHIP_COLORS, isChipColor, type ChipColor } from '@/ui/chip-colors.ts'

export { CHIP_COLORS, isChipColor, type ChipColor }

/**
 * A literal lookup, not a template string.
 *
 * `` `bg-chip-${color}-bg` `` would compile, run, and render a colourless chip: Tailwind finds
 * class names by scanning the source text, and a name that only exists once JavaScript has
 * concatenated it is not in the source text. Every class below is written out so the scanner can
 * see it — which is also why this table is spelled out rather than generated from `CHIP_COLORS`.
 */
const CHIP_CLASSES: Record<ChipColor, string> = {
  gray: 'bg-chip-gray-bg text-chip-gray-fg border-chip-gray-fg/15',
  slate: 'bg-chip-slate-bg text-chip-slate-fg border-chip-slate-fg/15',
  red: 'bg-chip-red-bg text-chip-red-fg border-chip-red-fg/15',
  orange: 'bg-chip-orange-bg text-chip-orange-fg border-chip-orange-fg/15',
  amber: 'bg-chip-amber-bg text-chip-amber-fg border-chip-amber-fg/15',
  green: 'bg-chip-green-bg text-chip-green-fg border-chip-green-fg/15',
  teal: 'bg-chip-teal-bg text-chip-teal-fg border-chip-teal-fg/15',
  blue: 'bg-chip-blue-bg text-chip-blue-fg border-chip-blue-fg/15',
  indigo: 'bg-chip-indigo-bg text-chip-indigo-fg border-chip-indigo-fg/15',
  violet: 'bg-chip-violet-bg text-chip-violet-fg border-chip-violet-fg/15',
  pink: 'bg-chip-pink-bg text-chip-pink-fg border-chip-pink-fg/15',
}

/**
 * Options created before the colour picker existed, and rows imported from a CSV, carry no colour
 * at all — and `attribute_option.color` is plain `text`, so a value written by an older build can
 * be any string. Both land on grey rather than on an unstyled chip.
 */
export function chipColorClasses(color: string | null | undefined): string {
  return CHIP_CLASSES[isChipColor(color) ? color : 'gray']
}

/**
 * `color` is omitted from the span's own props first: HTML has a deprecated `color` attribute of
 * its own, and without the omission this narrower meaning would be an illegal override rather
 * than a replacement.
 */
export interface ChipProps extends Omit<React.ComponentProps<'span'>, 'color'> {
  color?: string | null
}

/**
 * One select value, one relation, one tag. Sized to sit inside a 40px table row (ADR-053) without
 * pushing it taller, and `max-w-full` + `truncate` so a long label shortens instead of widening
 * the column.
 */
export function Chip({ color, className, ...props }: ChipProps) {
  return (
    <span
      data-slot="chip"
      className={cn(
        'inline-flex h-5 max-w-full items-center gap-1 truncate rounded border px-1.5 text-xs font-medium',
        chipColorClasses(color),
        className,
      )}
      {...props}
    />
  )
}
