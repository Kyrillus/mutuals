/**
 * One labelled field, in the shape `12-create-attribute.png` uses: label with a red asterisk when
 * required, the control, the grey explanation under it, and the red message where the explanation
 * would be when something is wrong.
 *
 * The message replaces the helper text rather than joining it. Two lines under one input, one grey
 * and one red, is the layout in which people read the wrong one.
 */
import { Lock } from 'lucide-react'
import { useId, type ReactNode } from 'react'

import { cn } from '@/lib/utils.ts'

export interface FieldRowIds {
  /** For the control itself. */
  readonly id: string
  /**
   * For a control that a `<label for>` cannot name.
   *
   * A `<label for>` names form controls; the accessible name of a **button** is computed from
   * `aria-labelledby`, `aria-label` and then its own contents. The Type and Group pickers are
   * Radix popover triggers — buttons — so `<label for>` alone leaves their name at the mercy of
   * whichever browser happens to fall back to the related element. Pointing `aria-labelledby` at
   * this id and at the control's own id names them "Type Short text": the field, then its value,
   * which is what a native `<select>` announces.
   */
  readonly labelId: string
  readonly describedBy: string | undefined
  /** The asterisk is decoration; this is the machine-readable half of it. */
  readonly required: boolean
}

export interface FieldRowProps {
  readonly label: string
  readonly required?: boolean
  readonly help?: ReactNode
  readonly error?: string | undefined
  /** Receives the ids to hang on the control and the id to point `aria-describedby` at. */
  readonly children: (ids: FieldRowIds) => ReactNode
}

export function FieldRow({ label, required, help, error, children }: FieldRowProps) {
  const id = useId()
  const labelId = `${id}-label`
  const messageId = `${id}-message`
  const hasMessage = error !== undefined || help !== undefined

  return (
    <div className="flex flex-col gap-1.5">
      <label id={labelId} htmlFor={id} className="text-sm font-medium">
        {label}
        {/* Hidden from the accessible name: "Title star" is not the name of the field, and
            `aria-required` on the control says the same thing in a way software can act on. */}
        {required === true && (
          <span className="text-destructive" aria-hidden>
            {' '}
            *
          </span>
        )}
      </label>

      {children({
        id,
        labelId,
        describedBy: hasMessage ? messageId : undefined,
        required: required === true,
      })}

      {hasMessage && (
        <p
          id={messageId}
          className={cn(
            'text-xs',
            error === undefined ? 'text-muted-foreground' : 'text-destructive',
          )}
        >
          {error ?? help}
        </p>
      )}
    </div>
  )
}

/**
 * A field the user may look at but not change, with the reason where the helper text goes.
 *
 * §6.7 locks the slug and the type after creation, and "greyed out" on its own is the version of
 * that where a person assumes the app is broken.
 */
export function LockedNote({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-start gap-1">
      <Lock className="mt-px size-3 shrink-0" aria-hidden />
      <span>{children}</span>
    </span>
  )
}
