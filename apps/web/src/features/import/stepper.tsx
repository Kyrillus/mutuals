/**
 * §6.8's stepper: Upload → Sheet → Map columns → Review → Done.
 *
 * The Sheet step is skipped for anything that is not a multi-sheet workbook, and it is *hidden*
 * rather than shown disabled — a step you can never reach is not a step, and leaving it in the rail
 * would make a plain CSV import look like it went wrong somewhere.
 */
import { Check } from 'lucide-react'

import { cn } from '@/lib/utils.ts'

export const IMPORT_STEPS = ['upload', 'sheet', 'map', 'review', 'done'] as const
export type ImportStep = (typeof IMPORT_STEPS)[number]

const LABELS: Readonly<Record<ImportStep, string>> = {
  upload: 'Upload',
  sheet: 'Sheet',
  map: 'Map columns',
  review: 'Review',
  done: 'Done',
}

export function Stepper({ current, showSheet }: { current: ImportStep; showSheet: boolean }) {
  const steps = IMPORT_STEPS.filter((step) => step !== 'sheet' || showSheet)
  const currentIndex = steps.indexOf(current)

  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" aria-label="Import steps">
      {steps.map((step, index) => {
        const done = index < currentIndex
        const active = index === currentIndex
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full border text-xs',
                done && 'border-primary bg-primary text-primary-foreground',
                active && 'border-primary text-primary font-medium',
                !done && !active && 'border-border text-muted-foreground',
              )}
              aria-hidden
            >
              {done ? <Check className="size-3" /> : index + 1}
            </span>
            <span
              className={cn(
                active ? 'text-foreground font-medium' : 'text-muted-foreground',
                'whitespace-nowrap',
              )}
              // The current step is announced, so a screen reader is told where it is rather than
              // having to infer it from a colour.
              aria-current={active ? 'step' : undefined}
            >
              {LABELS[step]}
            </span>
            {index < steps.length - 1 ? (
              <span className="bg-border mx-1 h-px w-6 shrink-0" aria-hidden />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
