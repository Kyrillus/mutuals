import { civilIn, fieldValueKind, isCivilDate, type FieldDescriptor } from '@mutuals/core'
import { Check, X } from 'lucide-react'

import { useDisplay } from '@/attributes/display-context.tsx'
import { formatCivilDate, formatNumber, formatRelativeDay } from '@/attributes/format.ts'

import { systemValue, type RecordRow } from './record-row.ts'

/**
 * A system or derived column, rendered from its declared `valueKind`.
 *
 * `@/attributes` renders user-defined values, which carry their own type on the wire. These do
 * not: `warmth` is a bare number and `created_at` a bare instant, described only by what
 * `SYSTEM_FIELDS` says about them. So this is the second half of §5.2's "cells render by type",
 * and between the two there is no `if (slug === …)` anywhere.
 *
 * It borrows `@/attributes`'s formatters rather than owning a second set, so a date reads the same
 * on this page as it does in the detail sidebar.
 */
export function SystemCell({ row, field }: { row: RecordRow; field: FieldDescriptor }) {
  const display = useDisplay()
  const value = systemValue(row, field.slug)
  if (value === null || value === undefined || value === '') return <EmptyValue />

  switch (fieldValueKind(field)) {
    case 'bool':
      return value === true ? (
        <Check className="text-muted-foreground size-3.5" aria-label="Yes" />
      ) : (
        <X className="text-muted-foreground/50 size-3.5" aria-label="No" />
      )
    case 'number':
      return (
        <span className="block truncate text-right tabular-nums">
          {formatNumber(String(value), {}, display.locale)}
        </span>
      )
    case 'date': {
      const day = toCivil(String(value), display.timeZone)
      if (day === null) return <span className="block truncate">{String(value)}</span>
      // §6.2 wants "3 weeks ago" for Last interaction and a date for Created. What separates them
      // is that one is computed from the interaction log and the other is a fact about the row —
      // `source.kind === 'metric'` is exactly the derived set `SYSTEM_FIELDS` declares, so no
      // column name appears here.
      const derived = field.source.kind === 'metric'
      return (
        <span className="block truncate" title={formatCivilDate(day, display.locale)}>
          {derived
            ? formatRelativeDay(day, display.today, display.locale)
            : formatCivilDate(day, display.locale)}
        </span>
      )
    }
    default:
      return <span className="block truncate">{String(value)}</span>
  }
}

/** A civil date passes through; an instant becomes the calendar day it fell on where the user is. */
function toCivil(raw: string, timeZone: string) {
  if (isCivilDate(raw)) return raw
  const instant = new Date(raw)
  return Number.isNaN(instant.getTime()) ? null : civilIn(timeZone, instant)
}

/** §5.2: "empty as a subtle placeholder" — the same mark everywhere, so a gap reads as a gap. */
export function EmptyValue() {
  return (
    <span className="text-muted-foreground/60 select-none tabular-nums" aria-label="Empty">
      —
    </span>
  )
}
