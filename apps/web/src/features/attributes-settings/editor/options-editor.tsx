/**
 * The options editor for `single_select` and `multi_select`.
 *
 * Order matters and the UI has to say so: §4.2 makes the option order *the* sort order for a
 * single select, so dragging a row is a real edit to how the table sorts, not decoration. Each row
 * is therefore draggable and also movable from the keyboard — a drag handle that only answers a
 * mouse would make column sorting unreachable for anyone who does not use one.
 *
 * ADR-038 is enforced above the list rather than inside it: a select with no options is refused,
 * because `z.enum([])` builds happily and then rejects every value with a message that names
 * nothing.
 */
import { GripVertical, Plus, X } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/utils.ts'
import { Button } from '@/ui/button.tsx'
import { Input } from '@/ui/input.tsx'
import type { ChipColor } from '@/ui/chip-colors.ts'

import type { OptionRow } from './draft.ts'
import { OptionColorPicker } from './option-color-picker.tsx'

export interface OptionsEditorProps {
  readonly options: readonly OptionRow[]
  readonly archivedCount: number
  /** `single_select` sorts by this order; `multi_select` only displays in it. */
  readonly orderIsSortOrder: boolean
  readonly issues: ReadonlyMap<string, string>
  readonly onLabelChange: (rowId: string, label: string) => void
  readonly onColorChange: (rowId: string, color: ChipColor) => void
  readonly onMove: (from: number, to: number) => void
  readonly onAdd: () => void
  /** Absent for a saved option: retiring one is a decision, and it goes through its own dialog. */
  readonly onRemove: (rowId: string) => void
  readonly onRetire: (rowId: string) => void
}

export function OptionsEditor({
  options,
  archivedCount,
  orderIsSortOrder,
  issues,
  onLabelChange,
  onColorChange,
  onMove,
  onAdd,
  onRemove,
  onRetire,
}: OptionsEditorProps) {
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const listError = issues.get('options')

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">
          Options
          <span className="text-destructive"> *</span>
        </span>
        <span className="text-muted-foreground text-xs">
          {orderIsSortOrder ? 'This order is the sort order' : 'Drag to reorder'}
        </span>
      </div>

      <ul className="flex flex-col gap-1.5">
        {options.map((option, index) => {
          const error = issues.get(`options.${String(index)}.label`)
          return (
            <li
              key={option.rowId}
              draggable={dragging === index}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                setDragging(index)
              }}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setOver(index)
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragging !== null) onMove(dragging, index)
                setDragging(null)
                setOver(null)
              }}
              onDragEnd={() => {
                setDragging(null)
                setOver(null)
              }}
              className={cn(
                'flex items-center gap-2 rounded-md',
                over === index && dragging !== null && dragging !== index && 'ring-ring/50 ring-2',
                dragging === index && 'opacity-50',
              )}
            >
              <button
                type="button"
                aria-label={`Move ${option.label === '' ? 'option' : option.label}`}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 h-8 shrink-0 cursor-grab rounded px-0.5 focus-visible:ring-[3px] focus-visible:outline-none"
                onPointerDown={() => {
                  setDragging(index)
                }}
                onPointerUp={() => {
                  setDragging(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    onMove(index, index - 1)
                  }
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    onMove(index, index + 1)
                  }
                }}
              >
                <GripVertical className="size-4" aria-hidden />
              </button>

              <OptionColorPicker
                color={option.color}
                label={option.label}
                onChange={(next) => {
                  onColorChange(option.rowId, next)
                }}
              />

              <div className="min-w-0 flex-1">
                <Input
                  value={option.label}
                  aria-label={`Option ${String(index + 1)} label`}
                  aria-invalid={error !== undefined}
                  placeholder="Label"
                  className="h-8"
                  onChange={(event) => {
                    onLabelChange(option.rowId, event.target.value)
                  }}
                />
                {error !== undefined && <p className="text-destructive mt-1 text-xs">{error}</p>}
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={
                  option.id === undefined
                    ? `Remove option ${String(index + 1)}`
                    : `Retire option ${String(index + 1)}`
                }
                onClick={() => {
                  if (option.id === undefined) onRemove(option.rowId)
                  else onRetire(option.rowId)
                }}
              >
                <X />
              </Button>
            </li>
          )
        })}
      </ul>

      {listError !== undefined && <p className="text-destructive text-xs">{listError}</p>}

      <div>
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus />
          Add option
        </Button>
      </div>

      {archivedCount > 0 && (
        <p className="text-muted-foreground text-xs">
          {archivedCount === 1
            ? '1 retired option is kept so old values still read correctly.'
            : `${String(archivedCount)} retired options are kept so old values still read correctly.`}
        </p>
      )}
    </section>
  )
}
