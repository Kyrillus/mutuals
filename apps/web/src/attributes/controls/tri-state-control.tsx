/**
 * `yes_no`, which is a **nullable** boolean (§4.2). Three states, not two.
 *
 * A Radix `Switch` cannot express this: a switch has an on position and an off position, and
 * "we have not asked this person yet" is neither. Cycling one with repeated clicks would hide the
 * third state behind a gesture nobody discovers, and the whole point of the nullable type is that
 * "not an angel" and "unknown" are different facts the filter bar can tell apart.
 *
 * So it is a three-stop segmented control with radio semantics: every state is one click away and
 * one arrow key away, and `aria-checked` says which one is true.
 */
import { useRef } from 'react'

import { cn } from '@/lib/utils.ts'

import { CONTROL_HEIGHT, type AttributeInputProps } from '../input-props.ts'
import { cycleTriState, TRI_STATE_ORDER, triStateLabel, type TriState } from './tri-state-model.ts'

export { cycleTriState, TRI_STATE_ORDER, triStateLabel, type TriState }

export function TriStateControl({
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
}: AttributeInputProps<'yes_no'>) {
  const group = useRef<HTMLDivElement>(null)

  function select(next: TriState) {
    onChange(next)
    onCommit?.()
  }

  return (
    <div
      ref={group}
      id={id}
      role="radiogroup"
      aria-label={rest['aria-label'] ?? definition.title}
      aria-invalid={error === undefined ? undefined : true}
      aria-describedby={error === undefined ? undefined : errorId}
      className={cn(
        'border-input inline-flex w-fit items-center rounded-md border p-0.5',
        CONTROL_HEIGHT,
        'aria-invalid:border-destructive',
        disabled === true && 'pointer-events-none opacity-50',
        className,
      )}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel?.()
          return
        }
        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : null
        const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : null
        if (step === null && back === null) return
        event.preventDefault()
        const next = cycleTriState(value, step ?? back ?? 1)
        select(next)
        // Roving focus: the newly checked button is the only tab stop, so focus has to follow it.
        group.current?.querySelector<HTMLButtonElement>(`[data-state="${String(next)}"]`)?.focus()
      }}
    >
      {TRI_STATE_ORDER.map((state, index) => {
        const checked = value === state
        return (
          <button
            key={String(state)}
            type="button"
            role="radio"
            data-state={String(state)}
            aria-checked={checked}
            // One tab stop for the group, as a radiogroup should have.
            tabIndex={checked ? 0 : -1}
            autoFocus={autoFocus === true && index === 0}
            disabled={disabled}
            onClick={() => {
              select(state)
            }}
            className={cn(
              'h-full rounded-sm px-2 text-xs font-medium transition-colors outline-none',
              'focus-visible:ring-ring/80 focus-visible:ring-[3px]',
              checked
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {triStateLabel(state)}
          </button>
        )
      })}
    </div>
  )
}
