/**
 * The editor registry (ADR-052), and the two components that dispatch through it.
 *
 * `CONTROL_BY_UI` is keyed by `AttributeUi` — the control **`packages/core` declares** for a type,
 * not one this file picks. `ATTRIBUTE_INPUTS` is then keyed by attribute type, and its value type
 * is looked up through `TypeDefinitionFor<T>['ui']`, so the entry for `tags` is required to be
 * whatever `CONTROL_BY_UI` holds under the `ui` the registry names. Change `tags.ui` in core and
 * this file stops compiling; add a thirteenth type and both maps report a missing key. There is no
 * third place where a type is mapped to a component, and no `switch` on a slug anywhere.
 */
import {
  typeDef,
  type AttributeType,
  type AttributeUi,
  type TypeDefinitionFor,
} from '@mutuals/core'
import { useId, useState } from 'react'

import { cn } from '@/lib/utils.ts'

import { DateControl } from './controls/date-control.tsx'
import { RecordPickerControl } from './controls/record-picker.tsx'
import { MultiSelectControl, SelectControl } from './controls/select-controls.tsx'
import { TagInputControl } from './controls/tag-input.tsx'
import {
  EmailControl,
  NumberControl,
  PhoneControl,
  TextControl,
  TextareaControl,
  UrlControl,
} from './controls/text-controls.tsx'
import { TriStateControl } from './controls/tri-state-control.tsx'
import type { AttributeInputControl, AttributeInputProps } from './input-props.ts'
import { attributeTypeOf, validateDraft, type AttributeSpec } from './value.ts'

/**
 * One component per `AttributeUi`. `satisfies Record<AttributeUi, unknown>` is what makes it
 * exhaustive: the keys are checked, the values keep their precise per-type props.
 */
const CONTROL_BY_UI = {
  text_input: TextControl,
  textarea: TextareaControl,
  number_input: NumberControl,
  date_picker: DateControl,
  switch: TriStateControl,
  select: SelectControl,
  multi_select: MultiSelectControl,
  tag_input: TagInputControl,
  url_input: UrlControl,
  email_input: EmailControl,
  phone_input: PhoneControl,
  record_picker: RecordPickerControl,
} satisfies Record<AttributeUi, unknown>

export type AttributeInputRegistry = {
  readonly [T in AttributeType]: (typeof CONTROL_BY_UI)[TypeDefinitionFor<T>['ui']]
}

/** ADR-052's editor registry, keyed by attribute type and derived from core's `ui` column. */
export const ATTRIBUTE_INPUTS: AttributeInputRegistry = {
  short_text: CONTROL_BY_UI.text_input,
  long_text: CONTROL_BY_UI.textarea,
  number: CONTROL_BY_UI.number_input,
  date: CONTROL_BY_UI.date_picker,
  yes_no: CONTROL_BY_UI.switch,
  single_select: CONTROL_BY_UI.select,
  multi_select: CONTROL_BY_UI.multi_select,
  tags: CONTROL_BY_UI.tag_input,
  url: CONTROL_BY_UI.url_input,
  email: CONTROL_BY_UI.email_input,
  phone: CONTROL_BY_UI.phone_input,
  relation: CONTROL_BY_UI.record_picker,
}

/** The control the registry names for one type, without going through a component. */
export function controlFor(type: AttributeType): AttributeInputControl {
  return ATTRIBUTE_INPUTS[type] as AttributeInputControl
}

/**
 * Edits one value of one attribute, whatever its type.
 *
 * A derived attribute has no editor: §4.7's computed columns are read-only everywhere, and the
 * honest answer is the value rendered as text rather than an input that cannot save.
 */
export function AttributeInput(props: AttributeInputProps) {
  // The same cast the cell registry makes, for the same reason: indexed by a non-literal, the
  // registry widens to a union of twelve controls whose props intersect to `never`. The registry's
  // definition above is fully checked; this only asserts that a draft for type `t` is a draft for
  // type `t`, which the definition's own discriminant has already said.
  const Control = ATTRIBUTE_INPUTS[
    attributeTypeOf(props.definition)
  ] as AttributeInputControl<AttributeType>
  return <Control {...props} />
}

/**
 * A labelled control with its message underneath — §5.3's create dialog and §6.5's sidebar.
 *
 * Two sources of truth about what is wrong, in the right order. `error` comes from the API's
 * per-field `errors` array and always wins, because the server saw the whole request. Underneath
 * it, the attribute's own schema from `packages/core` runs on the draft once the field has been
 * touched, so "Enter an email address" appears while typing rather than after a round trip — and
 * it is the *same sentence*, because it comes from the same schema object.
 */
export function AttributeField({
  definition,
  value,
  onChange,
  error,
  className,
  hideLabel,
  ...rest
}: AttributeInputProps & { readonly hideLabel?: boolean }) {
  const id = useId()
  const [touched, setTouched] = useState(false)

  const local = touched ? validateDraft(definition, value) : undefined
  const message = error ?? local

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {hideLabel === true ? null : (
        <label htmlFor={id} className="text-foreground text-sm font-medium">
          {definition.title}
        </label>
      )}
      <AttributeInput
        {...rest}
        id={id}
        definition={definition}
        value={value}
        error={message}
        errorId={`${id}-error`}
        onChange={onChange}
        onCommit={() => {
          setTouched(true)
          rest.onCommit?.()
        }}
      />
      {definition.description === undefined || message !== undefined ? null : (
        <p className="text-muted-foreground text-xs">{definition.description}</p>
      )}
      {message === undefined ? null : (
        <p id={`${id}-error`} className="text-destructive text-xs">
          {message}
        </p>
      )}
    </div>
  )
}

/** True when the attribute can be edited at all — §4.7's derived columns never can. */
export function isEditable(definition: AttributeSpec): boolean {
  return !definition.isDerived
}

/** The `AttributeUi` core declares for a type, for a caller that needs the name rather than the
 *  component — the Columns picker's icons, and §6.7's type dropdown. */
export function uiFor(type: AttributeType): AttributeUi {
  return typeDef(type).ui
}
