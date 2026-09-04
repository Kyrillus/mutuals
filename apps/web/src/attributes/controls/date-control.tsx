/**
 * `date` — a calendar day with no time and no zone.
 *
 * This is the platform's date picker rather than a rendered calendar, for three reasons that all
 * point the same way. Its value is already `YYYY-MM-DD`, which is exactly `CivilDate`, so no
 * instant is ever constructed and the timezone bug the type exists to prevent has nowhere to
 * happen. It needs no popover, which matters inside a virtualised row that unmounts under the
 * user (ADR-053). And it is keyboard- and locale-correct for free, in every language, including
 * the day-first spellings §4.2's importer has to guess at from a CSV.
 *
 * `ui/calendar.tsx` does not exist yet; when it does, it belongs behind this control's props
 * rather than beside them.
 */
import { isCivilDate } from '@mutuals/core'

import { cn } from '@/lib/utils.ts'

import { CONTROL_HEIGHT, CONTROL_SURFACE, type AttributeInputProps } from '../input-props.ts'

export function DateControl({
  definition,
  value,
  onChange,
  onCommit,
  onCancel,
  error,
  errorId,
  autoFocus,
  disabled,
  id,
  className,
  ...rest
}: AttributeInputProps<'date'>) {
  return (
    <input
      type="date"
      id={id}
      aria-label={rest['aria-label'] ?? definition.title}
      aria-invalid={error === undefined ? undefined : true}
      aria-describedby={error === undefined ? undefined : errorId}
      autoFocus={autoFocus}
      disabled={disabled}
      value={value ?? ''}
      onChange={(event) => {
        const next = event.target.value
        // A half-typed date reaches this handler as `''`; only a real day is worth propagating,
        // and `isCivilDate` rejects 30 February rather than rolling it into March.
        if (next === '') {
          onChange(undefined)
          return
        }
        if (isCivilDate(next)) onChange(next)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel?.()
          return
        }
        if (event.key !== 'Enter') return
        event.preventDefault()
        onCommit?.()
      }}
      onBlur={() => {
        onCommit?.()
      }}
      className={cn(CONTROL_SURFACE, CONTROL_HEIGHT, 'px-2 tabular-nums', className)}
    />
  )
}
