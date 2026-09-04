/**
 * `single_select` and `multi_select`: a curated list, chosen from a searchable popover.
 *
 * Options come from `definition.options` and travel by their stable `key`, never by uuid and never
 * by label (ADR-031) — so an option renamed in Settings while this popover is open still resolves,
 * and a saved filter written last month still means the same thing.
 *
 * An **archived** option is still shown when it is the current value. §6.7 archives rather than
 * deletes precisely so history renders; hiding the value a record actually has would make the cell
 * look empty and the edit look like a clear.
 */
import { activeOptions, findOptionByKey, type AttributeOption } from '@mutuals/core'
import { X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { cn } from '@/lib/utils.ts'
import { Chip } from '@/ui/chip.tsx'

import type { AttributeInputProps } from '../input-props.ts'
import { coreOptions } from '../value.ts'
import {
  Picker,
  PickerContent,
  PickerEmpty,
  PickerGroup,
  PickerItem,
  PickerTrigger,
} from './picker.tsx'

/** Live options, plus whichever archived ones the record is actually holding. */
function optionsFor(
  all: readonly AttributeOption[],
  selected: readonly string[],
): readonly AttributeOption[] {
  const live = activeOptions(all)
  const missing = selected
    .filter((key) => !live.some((option) => option.key === key))
    .flatMap((key) => {
      const archived = findOptionByKey(all, key)
      return archived === undefined ? [] : [archived]
    })
  return [...live, ...missing]
}

function OptionChip({ option }: { option: AttributeOption }) {
  return <Chip color={option.color}>{option.label}</Chip>
}

export function SelectControl({
  definition,
  value,
  onChange,
  onCommit,
  onCancel,
  error,
  errorId,
  disabled,
  id,
  className,
  ...rest
}: AttributeInputProps<'single_select'>) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const chose = useRef(false)

  const all = useMemo(() => coreOptions(definition), [definition])
  const options = optionsFor(all, value === undefined ? [] : [value])
  const current = value === undefined ? undefined : findOptionByKey(all, value)

  function choose(next: string | undefined) {
    chose.current = true
    onChange(next)
    setOpen(false)
    onCommit?.()
  }

  return (
    <Picker
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          chose.current = false
          setSearch('')
        } else if (!chose.current) {
          onCancel?.()
        }
      }}
    >
      <PickerTrigger
        id={id}
        disabled={disabled}
        empty={current === undefined}
        aria-label={rest['aria-label'] ?? definition.title}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
        className={className}
      >
        {current === undefined ? null : <OptionChip option={current} />}
      </PickerTrigger>
      <PickerContent
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder={`Search ${definition.title.toLowerCase()}…`}
      >
        <PickerEmpty>No option matches.</PickerEmpty>
        <PickerGroup>
          {options.map((option) => (
            <PickerItem
              key={option.key}
              value={option.label}
              keywords={[option.key]}
              selected={option.key === value}
              onSelect={() => {
                choose(option.key)
              }}
            >
              <OptionChip option={option} />
            </PickerItem>
          ))}
        </PickerGroup>
        {value === undefined ? null : (
          <PickerGroup>
            <PickerItem
              value="Clear"
              onSelect={() => {
                choose(undefined)
              }}
            >
              <span className="text-muted-foreground">Clear</span>
            </PickerItem>
          </PickerGroup>
        )}
      </PickerContent>
    </Picker>
  )
}

export function MultiSelectControl({
  definition,
  value,
  onChange,
  onCommit,
  error,
  errorId,
  disabled,
  id,
  className,
  ...rest
}: AttributeInputProps<'multi_select'>) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const selected = value ?? []
  const all = useMemo(() => coreOptions(definition), [definition])
  const options = optionsFor(all, selected)

  function toggle(key: string) {
    const next = selected.includes(key)
      ? selected.filter((entry) => entry !== key)
      : [...selected, key]
    onChange(next.length === 0 ? undefined : next)
  }

  return (
    <Picker
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setSearch('')
        // Several toggles are one edit. The write happens when the popover closes, not on each
        // checkmark, so adding three tags is one optimistic mutation rather than three.
        if (!next) onCommit?.()
      }}
    >
      <PickerTrigger
        id={id}
        disabled={disabled}
        empty={selected.length === 0}
        aria-label={rest['aria-label'] ?? definition.title}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
        className={className}
      >
        {options
          .filter((option) => selected.includes(option.key))
          .map((option) => (
            <OptionChip key={option.key} option={option} />
          ))}
      </PickerTrigger>
      <PickerContent
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder={`Search ${definition.title.toLowerCase()}…`}
      >
        <PickerEmpty>No option matches.</PickerEmpty>
        <PickerGroup>
          {options.map((option) => (
            <PickerItem
              key={option.key}
              value={option.label}
              keywords={[option.key]}
              selected={selected.includes(option.key)}
              onSelect={() => {
                toggle(option.key)
              }}
            >
              <OptionChip option={option} />
            </PickerItem>
          ))}
        </PickerGroup>
      </PickerContent>
    </Picker>
  )
}

/** A chip with a remove button, shared by the multi-select trigger's siblings downstream. */
export function RemovableChip({
  label,
  color,
  onRemove,
}: {
  label: string
  color?: string | null
  onRemove: () => void
}) {
  return (
    <Chip color={color} className="pr-0.5">
      <span className="truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}
        className={cn(
          'hover:bg-foreground/10 grid size-3.5 shrink-0 place-items-center rounded-sm',
        )}
      >
        <X className="size-2.5" />
      </button>
    </Chip>
  )
}
