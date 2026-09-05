/**
 * The value editor, chosen by the operator's **arity**, not by the field's type (§5.2).
 *
 * `is empty` takes nothing, `equals` takes one, `between` takes two, `is one of` takes a set —
 * and that is a property of the operator, which `OPERATOR_SHAPE_BY_ID` already states. The field's
 * value kind decides only what one input looks like: a date gets a date picker, a number gets a
 * number field, an option gets its options.
 *
 * Everything here edits a **draft**. Nothing reaches the URL until {@link isComplete} says the
 * filter is worth sending, because `?filter=` is validated by the same schema the API uses and a
 * half-typed `between` would not survive the next page load.
 */
import {
  MAX_RELATIVE_N,
  RELATIVE_PRESETS,
  RELATIVE_UNITS,
  fieldValueKind,
  operatorShape,
  type FieldDescriptor,
  type Filter,
  type RelativeUnit,
} from '@mutuals/core'
import { Check, Loader2, Plus, X } from 'lucide-react'
import { Command } from 'cmdk'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState, type KeyboardEvent, type ReactNode } from 'react'

import { cn } from '@/lib/utils.ts'
import { Chip } from '@/ui/chip.tsx'

import { RELATIVE_PRESET_LABELS, RELATIVE_UNIT_LABELS } from './operators.ts'
import { RECORD_SEARCH_LIMIT, RECORD_SOURCES, type RecordOption } from './record-source.ts'
import { relationTarget } from './relation.ts'
import { fieldOptions } from './sentence.ts'

/**
 * `commit` separates "the draft changed" from "the user is done with this value". A keystroke is
 * the first; picking an option, leaving the field or pressing Enter is the second. Without the
 * distinction, typing "Munich" would be six navigations and six list requests.
 */
export type FilterChange = (next: Filter, options?: { readonly commit?: boolean }) => void

const CONTROL =
  'h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/80 dark:bg-input/30'

const ITEM =
  'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground'

/** A searchable list only earns its search box once the list is long enough to need one. */
const SEARCHABLE_FROM = 8

function ScalarInput({
  field,
  value,
  label,
  autoFocus,
  onChange,
}: {
  field: FieldDescriptor | undefined
  value: string
  label: string
  autoFocus?: boolean
  onChange: (next: string, commit: boolean) => void
}) {
  const kind = field === undefined ? 'text' : fieldValueKind(field)
  const isDate = kind === 'date'
  const isNumber = kind === 'number'

  return (
    <input
      type={isDate ? 'date' : isNumber ? 'number' : 'text'}
      className={CONTROL}
      aria-label={label}
      placeholder={isDate || isNumber ? undefined : 'Value'}
      value={value}
      autoFocus={autoFocus}
      // A date is chosen, not typed: the browser only emits a complete value, so waiting for a
      // blur would leave the picker showing a date the table is not filtered by.
      onChange={(event) => {
        onChange(event.target.value, isDate)
      }}
      onBlur={(event) => {
        onChange(event.target.value, true)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onChange(event.currentTarget.value, true)
      }}
    />
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </label>
  )
}

function OptionPicker({
  field,
  values,
  onChange,
}: {
  field: FieldDescriptor
  values: readonly string[]
  onChange: (next: readonly string[]) => void
}) {
  const options = fieldOptions(field)
  const chosen = new Set(values)

  return (
    <Command loop className="flex flex-col">
      {options.length >= SEARCHABLE_FROM && (
        <Command.Input
          autoFocus
          placeholder="Find an option…"
          className={cn(CONTROL, 'mb-1')}
          aria-label="Find an option"
        />
      )}
      <Command.List className="-mx-1 max-h-56 overflow-y-auto px-1">
        <Command.Empty className="text-muted-foreground px-2 py-3 text-sm">
          No option matches.
        </Command.Empty>
        {options.map((option) => (
          <Command.Item
            key={option.key}
            value={`${option.label} ${option.key}`}
            className={ITEM}
            onSelect={() => {
              onChange(
                chosen.has(option.key)
                  ? values.filter((value) => value !== option.key)
                  : [...values, option.key],
              )
            }}
          >
            <Check className={cn('size-3.5 shrink-0', chosen.has(option.key) ? '' : 'opacity-0')} />
            <Chip color={option.color}>{option.label}</Chip>
          </Command.Item>
        ))}
      </Command.List>
    </Command>
  )
}

function RecordPicker({
  field,
  values,
  labels,
  onChange,
}: {
  field: FieldDescriptor
  values: readonly string[]
  labels: ReadonlyMap<string, string>
  onChange: (next: readonly string[]) => void
}) {
  const [term, setTerm] = useState('')
  const objectType = relationTarget(field)
  const search = useQuery({
    queryKey: ['record-search', objectType ?? '', term],
    enabled: objectType !== undefined,
    queryFn: ({ signal }): Promise<readonly RecordOption[]> =>
      objectType === undefined
        ? Promise.resolve([])
        : RECORD_SOURCES[objectType].search(term, signal),
    staleTime: 30_000,
    // The list must not blink back to empty on every keystroke; the previous page stays until the
    // next one lands, which is also what makes the "Searching…" state rare enough to be useful.
    placeholderData: keepPreviousData,
  })

  const chosen = new Set(values)
  const results = search.data ?? []
  // A record that is already filtered on has to stay in the list even when the search term no
  // longer matches it, or unticking it means clearing the search box first.
  const pinned = values
    .filter((id) => !results.some((option) => option.id === id))
    .map((id) => ({ id, label: labels.get(id) ?? id }))

  return (
    <Command loop shouldFilter={false} className="flex flex-col">
      <Command.Input
        autoFocus
        value={term}
        onValueChange={setTerm}
        placeholder="Search records…"
        className={cn(CONTROL, 'mb-1')}
        aria-label="Search records"
      />
      <Command.List className="-mx-1 max-h-56 overflow-y-auto px-1">
        {search.isFetching && results.length === 0 ? (
          <div className="text-muted-foreground flex items-center gap-2 px-2 py-3 text-sm">
            <Loader2 className="size-3.5 animate-spin" /> Searching…
          </div>
        ) : (
          <Command.Empty className="text-muted-foreground px-2 py-3 text-sm">
            Nothing matches.
          </Command.Empty>
        )}
        {[...pinned, ...results].map((option) => (
          <Command.Item
            key={option.id}
            value={option.id}
            className={ITEM}
            onSelect={() => {
              onChange(
                chosen.has(option.id)
                  ? values.filter((value) => value !== option.id)
                  : [...values, option.id],
              )
            }}
          >
            <Check className={cn('size-3.5 shrink-0', chosen.has(option.id) ? '' : 'opacity-0')} />
            <span className="truncate">{option.label}</span>
          </Command.Item>
        ))}
        {results.length === RECORD_SEARCH_LIMIT && (
          <p className="text-muted-foreground px-2 py-1.5 text-xs">
            Showing the first {RECORD_SEARCH_LIMIT}. Keep typing to narrow it down.
          </p>
        )}
      </Command.List>
    </Command>
  )
}

/** Free text values — tags, and the system columns whose vocabulary lives in the database. */
function TokenInput({
  values,
  onChange,
}: {
  values: readonly string[]
  onChange: (next: readonly string[]) => void
}) {
  const [draft, setDraft] = useState('')

  function add() {
    const value = draft.trim()
    if (value === '' || values.includes(value)) {
      setDraft('')
      return
    }
    onChange([...values, value])
    setDraft('')
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      add()
    }
    if (event.key === 'Backspace' && draft === '' && values.length > 0) {
      onChange(values.slice(0, -1))
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <input
          className={CONTROL}
          autoFocus
          value={draft}
          placeholder="Type a value, then Enter"
          aria-label="Add a value"
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onKeyDown={onKeyDown}
          onBlur={add}
        />
        <button
          type="button"
          className="text-muted-foreground hover:bg-accent hover:text-accent-foreground grid size-8 shrink-0 place-items-center rounded-md"
          aria-label="Add this value"
          onMouseDown={(event) => {
            // The blur handler adds it; letting the click through would add it twice.
            event.preventDefault()
          }}
          onClick={add}
        >
          <Plus className="size-4" />
        </button>
      </div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {values.map((value) => (
            <Chip key={value} className="h-6 pr-1">
              {value}
              <button
                type="button"
                className="hover:text-foreground -mr-0.5 rounded p-0.5"
                aria-label={`Remove ${value}`}
                onClick={() => {
                  onChange(values.filter((entry) => entry !== value))
                }}
              >
                <X className="size-3" />
              </button>
            </Chip>
          ))}
        </div>
      )}
    </div>
  )
}

function SetControl({
  field,
  values,
  labels,
  onChange,
}: {
  field: FieldDescriptor | undefined
  values: readonly string[]
  labels: ReadonlyMap<string, string>
  onChange: (next: readonly string[]) => void
}) {
  if (field === undefined) return <TokenInput values={values} onChange={onChange} />
  if (relationTarget(field) !== undefined) {
    return <RecordPicker field={field} values={values} labels={labels} onChange={onChange} />
  }
  if (fieldOptions(field).length > 0) {
    return <OptionPicker field={field} values={values} onChange={onChange} />
  }
  return <TokenInput values={values} onChange={onChange} />
}

export function ValueControl({
  field,
  filter,
  labels,
  onChange,
}: {
  field: FieldDescriptor | undefined
  filter: Filter
  labels: ReadonlyMap<string, string>
  onChange: FilterChange
}) {
  if (operatorShape(filter.op) === 'none') return null

  switch (filter.op) {
    case 'contains':
    case 'equals':
    case 'eq':
    case 'neq':
    case 'lt':
    case 'gt':
    case 'before':
    case 'after':
      return (
        <ScalarInput
          field={field}
          value={filter.value}
          label="Value"
          autoFocus
          onChange={(value, commit) => {
            onChange({ ...filter, value }, { commit })
          }}
        />
      )

    case 'between':
      return (
        <div className="grid grid-cols-2 gap-2">
          <Field label="From">
            <ScalarInput
              field={field}
              value={filter.from}
              label="From"
              autoFocus
              onChange={(from, commit) => {
                onChange({ ...filter, from }, { commit })
              }}
            />
          </Field>
          <Field label="To">
            <ScalarInput
              field={field}
              value={filter.to}
              label="To"
              onChange={(to, commit) => {
                onChange({ ...filter, to }, { commit })
              }}
            />
          </Field>
        </div>
      )

    case 'in_relative':
      return (
        <select
          className={CONTROL}
          aria-label="Period"
          value={filter.preset}
          onChange={(event) => {
            const preset = RELATIVE_PRESETS.find((entry) => entry === event.target.value)
            if (preset !== undefined) onChange({ ...filter, preset }, { commit: true })
          }}
        >
          {RELATIVE_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {RELATIVE_PRESET_LABELS[preset]}
            </option>
          ))}
        </select>
      )

    case 'older_than':
    case 'newer_than':
      return (
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={MAX_RELATIVE_N}
            className={cn(CONTROL, 'w-20')}
            aria-label="How many"
            autoFocus
            value={String(filter.n)}
            onChange={(event) => {
              const n = Number(event.target.value)
              if (Number.isFinite(n)) onChange({ ...filter, n }, { commit: false })
            }}
            onBlur={() => {
              onChange(filter, { commit: true })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onChange(filter, { commit: true })
            }}
          />
          <select
            className={cn(CONTROL, 'w-auto flex-1')}
            aria-label="Unit"
            value={filter.unit}
            onChange={(event) => {
              const unit = RELATIVE_UNITS.find(
                (entry): entry is RelativeUnit => entry === event.target.value,
              )
              if (unit !== undefined) onChange({ ...filter, unit }, { commit: true })
            }}
          >
            {RELATIVE_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {RELATIVE_UNIT_LABELS[unit][1]}
              </option>
            ))}
          </select>
          <span className="text-muted-foreground text-sm">ago</span>
        </div>
      )

    case 'is_one_of':
    case 'is_not_one_of':
    case 'contains_any_of':
    case 'contains_all_of':
    case 'has_any_of':
      return (
        <SetControl
          field={field}
          values={filter.values}
          labels={labels}
          onChange={(values) => {
            onChange({ ...filter, values }, { commit: true })
          }}
        />
      )

    default:
      return null
  }
}
