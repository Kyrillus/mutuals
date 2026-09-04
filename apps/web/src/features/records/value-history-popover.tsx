/**
 * §4.5, made visible.
 *
 * Everything in this product's data model exists so that this popover can be honest: `fact` is
 * append-only, a new value supersedes rather than overwrites, and removing an element of a
 * multi-valued attribute writes a tombstone. Until Stage 3 none of that had a screen — the log was
 * being written correctly and read by nobody.
 *
 * Each row renders through {@link AttributeCell}, the same component the table and the sidebar use,
 * so a superseded option is the same chip it was when it was current.
 */
import { HistoryIcon } from 'lucide-react'
import { useState } from 'react'
import { AttributeCell } from '@/attributes/attribute-cell.tsx'
import type { AttributeDefinitionDto } from '@mutuals/core'
import { useDisplay } from '@/attributes/display-context.tsx'
import { formatCivilDate, formatDateTime } from '@/attributes/format.ts'
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover.tsx'
import { Skeleton } from '@/ui/skeleton.tsx'

import { useValueHistory } from './use-value-history.ts'

/** §4.4's vocabulary in the product's words rather than the column's. */
const SOURCE_LABEL: Record<string, string> = {
  manual: 'typed by you',
  import: 'from an import',
  quick_capture: 'from quick capture',
  agent: 'proposed by the assistant',
  gmail: 'from Gmail',
  calendar: 'from your calendar',
  crawler: 'found on the web',
}

export function ValueHistoryPopover({
  recordId,
  definition,
  label,
}: {
  recordId: string
  /** The DTO rather than `AttributeSpec`: this needs the attribute's id to fetch its history, and
   *  the rendering spec deliberately does not carry one. */
  definition: AttributeDefinitionDto
  label: string
}) {
  const [open, setOpen] = useState(false)
  const history = useValueHistory(recordId, definition.id, open)
  const { locale, timeZone } = useDisplay()

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`History of ${label}`}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none data-[state=open]:opacity-100"
      >
        <HistoryIcon className="size-3.5" />
      </PopoverTrigger>

      <PopoverContent align="end" className="w-96">
        <p className="mb-2 text-xs font-medium">{label} — history</p>

        {history.isPending && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        )}

        {history.isError && <p className="text-destructive text-xs">{history.error.message}</p>}

        {history.data?.entries.length === 0 && (
          <p className="text-muted-foreground text-xs">
            Nothing has been recorded for this field yet.
          </p>
        )}

        <ol className="flex flex-col gap-3">
          {history.data?.entries.map((entry) => (
            <li key={entry.factId} className="flex flex-col gap-1 text-xs">
              <div className="flex items-start justify-between gap-3">
                <span className={entry.isRemoval ? 'line-through opacity-60' : undefined}>
                  {entry.value === null ? (
                    <span className="text-muted-foreground">removed</span>
                  ) : (
                    <AttributeCell definition={definition} value={entry.value} />
                  )}
                </span>
                {entry.isCurrent && !entry.isRemoval && (
                  <span className="text-muted-foreground shrink-0 text-[10px] tracking-wide uppercase">
                    current
                  </span>
                )}
              </div>

              {/*
                Two dates, deliberately: `validFrom` is when the value became true in the world,
                `observedAt` is when this system was told. They are usually different for anything
                that arrived by import, and conflating them is how "since 2023" becomes "since the
                day we imported the CSV".
              */}
              <p className="text-muted-foreground">
                since {formatCivilDate(entry.validFrom, locale)} ·{' '}
                {SOURCE_LABEL[entry.source] ?? entry.source}
                {Number(entry.confidence) < 1 &&
                  ` · ${String(Math.round(Number(entry.confidence) * 100))}% sure`}
              </p>
              <p className="text-muted-foreground/70">
                recorded {formatDateTime(entry.observedAt, locale, timeZone)}
                {entry.sourceRef !== null && ` · ${entry.sourceRef}`}
              </p>
            </li>
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  )
}
