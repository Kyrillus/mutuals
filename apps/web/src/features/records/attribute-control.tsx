/**
 * The one place `@/attributes`' editors are called from this feature.
 *
 * Two boundaries meet here and they speak different currencies. The registry edits a **draft** —
 * an option key, a string, an array of `RelationValue` — because that is what a control can hold.
 * Everything on this side of the line moves **write values**: `PATCH /contacts/:id` takes them,
 * the optimistic patch is computed from them, and the create dialog posts them. `@/attributes`
 * publishes both conversions (`draftFromWriteValue`, `toWriteValue`), so this file is an adapter
 * and not a second opinion.
 *
 * Keeping it to one file also means the whole feature is insulated from which of the two shapes
 * the registry's dispatcher happens to expose.
 */
import type { AttributeDefinitionDto } from '@mutuals/core'

import { AttributeField, AttributeInput } from '@/attributes/attribute-input.tsx'
import {
  attributeTypeOf,
  draftFromWriteValue,
  toWriteValue,
  type AttributeDraft,
} from '@/attributes/value.ts'

export interface AttributeControlProps {
  readonly definition: AttributeDefinitionDto
  /** The write value: `null` is empty (ADR-031). */
  readonly value: unknown
  readonly onChange: (write: unknown) => void
  readonly onCommit?: () => void
  readonly onCancel?: () => void
  readonly error?: string
  readonly autoFocus?: boolean
  readonly 'aria-label'?: string
}

function bridge({ definition, value, onChange }: AttributeControlProps) {
  const type = attributeTypeOf(definition)
  return {
    value: draftFromWriteValue(definition, value),
    // Typed `unknown` rather than `AttributeDraft` so the handler is accepted whichever of the two
    // the registry's props declare — a wider parameter is always assignable to a narrower one.
    onChange: (next: unknown) => {
      onChange(toWriteValue(type, next as AttributeDraft | undefined))
    },
  }
}

/** The bare control, for a 40px table cell. */
export function AttributeControl(props: AttributeControlProps) {
  const { definition, onCommit, onCancel, error, autoFocus } = props
  return (
    <AttributeInput
      definition={definition}
      {...bridge(props)}
      onCommit={onCommit}
      onCancel={onCancel}
      error={error}
      autoFocus={autoFocus}
      aria-label={props['aria-label']}
    />
  )
}

/** The labelled control with its message underneath, for §5.3's dialog and §6.5's sidebar. */
export function AttributeFormControl(props: AttributeControlProps) {
  const { definition, error } = props
  return <AttributeField definition={definition} {...bridge(props)} error={error} />
}
