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

export interface FieldRowProps {
  readonly label: string
  readonly required?: boolean
  readonly help?: ReactNode
  readonly error?: string | undefined
  /** Receives the id to hang on the control and the id to point `aria-describedby` at. */
  readonly children: (ids: { id: string; describedBy: string | undefined }) => ReactNode
}

export function FieldRow({ label, required, help, error, children }: FieldRowProps) {
  const id = useId()
  const messageId = `${id}-message`
  const hasMessage = error !== undefined || help !== undefined

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required === true && <span className="text-destructive"> *</span>}
      </label>

      {children({ id, describedBy: hasMessage ? messageId : undefined })}

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
