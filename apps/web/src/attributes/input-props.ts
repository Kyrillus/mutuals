/**
 * The one prop shape every editor in the registry implements.
 *
 * It is a separate module from `inputs.tsx` so a control can import it without importing the
 * registry that imports the control.
 *
 * The split between `onChange` and `onCommit` is what lets one control serve both callers §5.2 and
 * §5.3 name. The inline editor keeps the draft in component state, patches it on every `onChange`
 * and fires its optimistic mutation on `onCommit` — one write per edit, not one per keystroke. The
 * create dialog binds `onChange` into its form and ignores the rest, because a dialog has a submit
 * button and no notion of committing a single field.
 */
import type { AttributeType } from '@mutuals/core'
import type { ReactNode } from 'react'

import type { AttributeDraft, AttributeSpec } from './value.ts'

export interface AttributeInputProps<T extends AttributeType = AttributeType> {
  readonly definition: AttributeSpec
  /** `undefined` is the empty attribute (ADR-017), not a separate "unset" state. */
  readonly value: AttributeDraft<T> | undefined
  /** Every meaningful change. `undefined` clears the attribute. */
  readonly onChange: (next: AttributeDraft<T> | undefined) => void
  /** Persist now: blur, Enter, or a choice made in a popover. */
  readonly onCommit?: () => void
  /** Abandon: Escape, or a popover dismissed without choosing. */
  readonly onCancel?: () => void
  /**
   * The message for this field from the API's per-field `errors` array. Rendering it is the
   * caller's job — the control only wires `aria-invalid` and `aria-describedby`.
   */
  readonly error?: string
  readonly errorId?: string
  readonly autoFocus?: boolean
  readonly disabled?: boolean
  readonly id?: string
  readonly 'aria-label'?: string
  readonly className?: string
}

/** An editor for one attribute type. */
export type AttributeInputControl<T extends AttributeType = AttributeType> = (
  props: AttributeInputProps<T>,
) => ReactNode

/** Shared sizing: 32px, so the same control fits a 40px table row and a dialog without a variant. */
export const CONTROL_HEIGHT = 'h-8'

/** The border, focus ring and invalid state every control shares with `ui/input.tsx`. */
export const CONTROL_SURFACE =
  'w-full min-w-0 rounded-md border border-input bg-transparent text-sm shadow-xs outline-none ' +
  'transition-[color,box-shadow] placeholder:text-muted-foreground dark:bg-input/30 ' +
  'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/80 ' +
  'aria-invalid:border-destructive aria-invalid:ring-destructive/20 ' +
  'dark:aria-invalid:ring-destructive/40 disabled:pointer-events-none disabled:opacity-50'
