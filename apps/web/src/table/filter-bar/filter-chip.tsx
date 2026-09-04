/**
 * One active filter, reading like a sentence: `Job role is one of Investor, Angel` (§5.2).
 *
 * The whole chip is a button that opens its editor, and the `×` removes it. The tooltip carries
 * two things a truncated chip cannot: the sentence in full, and — for the three operators ADR-017
 * settled against the two conventions that disagree — what the operator actually matches, so that
 * "is not one of" and "is not" being different about missing values is stated rather than guessed.
 */
import { X } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'

import { cn } from '@/lib/utils.ts'
import { Chip } from '@/ui/chip.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip.tsx'

import { Popover, PopoverContent, PopoverTrigger } from './popover.tsx'
import type { FilterSentence } from './sentence.ts'

/** Past this the chip stops being readable at a glance and the tooltip does the work. */
const MAX_VALUE_CHIPS = 2

function Values({ sentence }: { sentence: FilterSentence }) {
  if (sentence.values.length === 0) return null

  if (sentence.values.every((value) => !value.asChip)) {
    return (
      <span className="text-foreground truncate font-medium">
        {sentence.values.map((value) => value.text).join(sentence.separator)}
      </span>
    )
  }

  const shown = sentence.values.slice(0, MAX_VALUE_CHIPS)
  const hidden = sentence.values.length - shown.length

  return (
    <>
      {shown.map((value, index) => (
        <Fragment key={`${value.text}-${String(index)}`}>
          <Chip color={value.color}>{value.text}</Chip>
        </Fragment>
      ))}
      {hidden > 0 && <span className="text-muted-foreground">+{hidden}</span>}
    </>
  )
}

export function FilterChip({
  sentence,
  open,
  onOpenChange,
  onRemove,
  children,
}: {
  sentence: FilterSentence
  open: boolean
  onOpenChange: (open: boolean) => void
  onRemove: () => void
  /** The editor, rendered into the popover when it is open. */
  children: ReactNode
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <div
        className={cn(
          'bg-background flex h-7 items-center rounded-md border text-xs',
          open && 'border-ring ring-ring/50 ring-[3px]',
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="hover:bg-accent flex h-full max-w-80 items-center gap-1 truncate rounded-l-md pr-1.5 pl-2"
              >
                <span
                  className={cn(
                    'shrink-0 font-medium',
                    sentence.unknownField && 'text-destructive',
                  )}
                >
                  {sentence.fieldLabel}
                </span>
                <span className="text-muted-foreground shrink-0">{sentence.operator}</span>
                <Values sentence={sentence} />
                {sentence.suffix !== null && (
                  <span className="text-muted-foreground shrink-0">{sentence.suffix}</span>
                )}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-72">
            <p className="font-medium">{sentence.text}</p>
            {sentence.unknownField && (
              <p className="mt-1 opacity-80">
                This field no longer exists. Remove the filter to see the full list again.
              </p>
            )}
            {sentence.note !== null && <p className="mt-1 opacity-80">{sentence.note}</p>}
          </TooltipContent>
        </Tooltip>

        <button
          type="button"
          aria-label={`Remove filter: ${sentence.text}`}
          className="text-muted-foreground hover:text-foreground hover:bg-accent grid h-full w-6 place-items-center rounded-r-md border-l"
          onClick={onRemove}
        >
          <X className="size-3" />
        </button>
      </div>
      <PopoverContent className="w-80">{children}</PopoverContent>
    </Popover>
  )
}
