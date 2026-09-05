/**
 * The Type picker.
 *
 * The list is `ATTRIBUTE_TYPE_CHOICES`, which is `ATTRIBUTE_TYPES` from the registry with a label
 * and a sentence attached — so a thirteenth attribute type appears here by existing, and there is
 * no array of twelve names in this file to forget to update.
 *
 * Every row carries its description because the alternative is a person choosing between "Short
 * text" and "Long text" by guessing, and the choice is permanent (§4.2).
 */
import { Check } from 'lucide-react'
import { useState } from 'react'

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxTrigger,
} from './combobox.tsx'
import { ATTRIBUTE_TYPE_CHOICES, typeMeta } from './type-meta.ts'
import type { AttributeType } from '@mutuals/core'

export function TypeSelect({
  value,
  onChange,
  id,
  describedBy,
  labelledBy,
  required,
  disabled,
}: {
  value: AttributeType
  onChange: (next: AttributeType) => void
  id?: string
  describedBy?: string | undefined
  labelledBy?: string | undefined
  required?: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const current = typeMeta(value)
  const CurrentIcon = current.icon

  return (
    <Combobox
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <ComboboxTrigger
        id={id}
        disabled={disabled}
        describedBy={describedBy}
        labelledBy={labelledBy}
        required={required}
      >
        <CurrentIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="truncate">{current.label}</span>
      </ComboboxTrigger>

      <ComboboxContent search={search} onSearchChange={setSearch} searchPlaceholder="Search types…">
        <ComboboxEmpty>No type matches.</ComboboxEmpty>
        {ATTRIBUTE_TYPE_CHOICES.map(({ type, meta }) => {
          const Icon = meta.icon
          return (
            <ComboboxItem
              key={type}
              value={meta.label}
              keywords={[type, meta.description]}
              onSelect={() => {
                onChange(type)
                setOpen(false)
                setSearch('')
              }}
            >
              <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{meta.label}</span>
                <span className="text-muted-foreground text-xs">{meta.description}</span>
              </span>
              {type === value && <Check className="mt-0.5 size-3.5 shrink-0 opacity-70" />}
            </ComboboxItem>
          )
        })}
      </ComboboxContent>
    </Combobox>
  )
}

/** The locked version shown when editing: the same row, without the popover. */
export function TypeDisplay({
  value,
  id,
  labelledBy,
}: {
  value: AttributeType
  id?: string
  labelledBy?: string | undefined
}) {
  const meta = typeMeta(value)
  const Icon = meta.icon
  return (
    // A `<div>` is not a form control, so nothing associates it with the label either. `group`
    // plus `aria-labelledby` makes it one readable unit rather than a stray "Short text".
    <div
      id={id}
      role="group"
      aria-labelledby={
        labelledBy === undefined || id === undefined ? undefined : `${labelledBy} ${id}`
      }
      className="border-input bg-muted/40 text-muted-foreground flex h-9 w-full items-center gap-2 rounded-md border px-3 text-sm"
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{meta.label}</span>
    </div>
  )
}
