/**
 * One filter, being edited: field, then operator, then a value control chosen by the operator's
 * arity. The same component builds a new chip and edits an existing one, because they are the
 * same three questions in the same order.
 *
 * The draft lives here (ADR-049's third state home) and only complete filters are handed up.
 * A filter that has been committed once stays in the URL while the draft is incomplete — clearing
 * the text box to type something else should not empty the table under the popover.
 */
import { operatorShape, type FieldDescriptor, type Filter } from '@mutuals/core'
import { ChevronDown, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/ui/button.tsx'

import { FieldList } from './field-list.tsx'
import {
  emptyFilter,
  filterKey,
  isComplete,
  operatorLabel,
  operatorNote,
  withField,
  withOperator,
} from './operators.ts'
import { ValueControl, type FilterChange } from './value-control.tsx'

export interface FilterEditorProps {
  readonly fields: readonly FieldDescriptor[]
  /** The filter being edited, or undefined to start from the field picker. */
  readonly filter?: Filter
  readonly labels: ReadonlyMap<string, string>
  /** Called with every complete draft; `previousKey` is null the first time a new chip lands. */
  readonly onCommit: (next: Filter, previousKey: string | null) => void
  readonly onRemove: (key: string) => void
  readonly onClose: () => void
}

export function FilterEditor({
  fields,
  filter,
  labels,
  onCommit,
  onRemove,
  onClose,
}: FilterEditorProps) {
  const [draft, setDraft] = useState<Filter | undefined>(filter)
  const [committedKey, setCommittedKey] = useState<string | null>(
    filter === undefined ? null : filterKey(filter),
  )
  const [picking, setPicking] = useState(filter === undefined)

  const field = draft === undefined ? undefined : fields.find((entry) => entry.slug === draft.field)

  function commit(next: Filter, shouldCommit: boolean) {
    setDraft(next)
    if (!shouldCommit || !isComplete(next)) return
    onCommit(next, committedKey)
    setCommittedKey(filterKey(next))
  }

  const change: FilterChange = (next, options) => {
    commit(next, options?.commit ?? true)
  }

  function chooseField(next: FieldDescriptor) {
    setPicking(false)
    const [firstOperator] = next.operators
    if (firstOperator === undefined) return
    const rebuilt =
      draft === undefined ? emptyFilter(next.slug, firstOperator) : withField(draft, next, field)
    commit(rebuilt, true)
  }

  if (picking || draft === undefined) {
    return <FieldList fields={fields} onSelect={chooseField} />
  }

  const note = operatorNote(draft.op)

  return (
    <div className="flex flex-col gap-2 p-2">
      <button
        type="button"
        className="hover:bg-accent flex h-8 items-center gap-2 rounded-md px-2 text-sm font-medium"
        onClick={() => {
          setPicking(true)
        }}
      >
        <span className="truncate">{field?.label ?? draft.field}</span>
        <ChevronDown className="text-muted-foreground ml-auto size-3.5 shrink-0" />
      </button>

      <select
        className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
        aria-label="Operator"
        value={draft.op}
        onChange={(event) => {
          const next = (field?.operators ?? []).find((entry) => entry === event.target.value)
          if (next !== undefined) commit(withOperator(draft, next), true)
        }}
      >
        {(field?.operators ?? [draft.op]).map((op) => (
          <option key={op} value={op}>
            {operatorLabel(op)}
          </option>
        ))}
      </select>

      {operatorShape(draft.op) !== 'none' && (
        <ValueControl field={field} filter={draft} labels={labels} onChange={change} />
      )}

      {note !== undefined && <p className="text-muted-foreground text-xs">{note}</p>}

      <div className="flex items-center justify-between gap-2 border-t pt-2">
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground hover:text-destructive"
          onClick={() => {
            if (committedKey !== null) onRemove(committedKey)
            onClose()
          }}
        >
          <Trash2 />
          Remove
        </Button>
        <Button size="xs" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  )
}
