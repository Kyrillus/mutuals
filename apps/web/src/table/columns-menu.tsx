import type { FieldDescriptor } from '@mutuals/core'
import { ArrowDownIcon, ArrowUpIcon, Columns3Icon, GripVerticalIcon, PinIcon } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils.ts'
import { Button } from '@/ui/button.tsx'
import { Input } from '@/ui/input.tsx'

import { Checkbox } from './checkbox.tsx'
import { moveColumn } from './column-layout.ts'

/**
 * §5.2's `Columns 10/14`: toggle visibility, reorder by drag.
 *
 * A Popover rather than a DropdownMenu, because a menu owns pointer events for roving focus and
 * typeahead and a drag inside one fights it the whole way down. Reordering is native HTML5 drag —
 * no library — and the arrow buttons beside each row are the same operation from the keyboard.
 *
 * The order is held locally while a drag is in flight and written to the URL on drop: rewriting
 * `?columns=` on every `dragover` would put forty entries in the browser's history for one
 * gesture. Reordering is suppressed while the find box is filtering, because "move this up" has
 * no honest meaning when the row above it is hidden.
 */
export function ColumnsMenu({
  fields,
  visible,
  labelSlug,
  onChange,
  onReset,
}: {
  fields: readonly FieldDescriptor[]
  visible: readonly string[]
  labelSlug: string
  onChange: (columns: readonly string[]) => void
  onReset: () => void
}) {
  const [draft, setDraft] = useState<readonly string[]>(visible)
  const [dragging, setDragging] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  // The URL is the truth; the draft exists only for the duration of a drag.
  useEffect(() => {
    if (dragging === null) setDraft(visible)
  }, [visible, dragging])

  const query = filter.trim().toLowerCase()
  const byslug = new Map(fields.map((field) => [field.slug, field]))
  const chosen = draft.filter((slug) => slug !== labelSlug)
  const shown = new Set(draft)

  const hidden = fields.filter(
    (field) => field.slug !== labelSlug && !shown.has(field.slug) && matches(field, query),
  )
  const label = byslug.get(labelSlug)

  function commit(next: readonly string[]) {
    const withLabel = [labelSlug, ...next.filter((slug) => slug !== labelSlug)]
    setDraft(withLabel)
    onChange(withLabel)
  }

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Columns3Icon />
          Columns
          <span className="text-muted-foreground tabular-nums">
            {draft.length}/{fields.length}
          </span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="bg-popover text-popover-foreground z-50 w-80 rounded-md border p-2 shadow-md"
        >
          <Input
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value)
            }}
            placeholder="Find a column…"
            className="mb-2 h-8"
            aria-label="Find a column"
          />
          <div className="max-h-80 overflow-y-auto">
            {label !== undefined && matches(label, query) && (
              <div className="text-muted-foreground flex h-8 items-center gap-2 rounded px-2 text-sm">
                <PinIcon className="size-3.5 shrink-0" />
                <span className="text-foreground flex-1 truncate">{label.label}</span>
                <span className="text-xs">always first</span>
              </div>
            )}

            {chosen.map((slug, index) => {
              const field = byslug.get(slug)
              if (field === undefined || !matches(field, query)) return null
              const reorderable = query === ''
              return (
                <div
                  key={slug}
                  draggable={reorderable}
                  onDragStart={() => {
                    setDragging(slug)
                  }}
                  onDragOver={(event) => {
                    event.preventDefault()
                  }}
                  onDrop={() => {
                    if (dragging !== null) commit(moveColumn(chosen, dragging, index))
                    setDragging(null)
                  }}
                  onDragEnd={() => {
                    setDragging(null)
                  }}
                  className={cn(
                    'group hover:bg-accent flex h-8 items-center gap-2 rounded px-2 text-sm',
                    reorderable && 'cursor-grab',
                    dragging === slug && 'opacity-40',
                  )}
                >
                  <GripVerticalIcon
                    className={cn(
                      'size-3.5 shrink-0',
                      reorderable ? 'text-muted-foreground' : 'opacity-0',
                    )}
                  />
                  <Checkbox
                    label={`Hide ${field.label}`}
                    checked
                    onCheckedChange={() => {
                      commit(chosen.filter((entry) => entry !== slug))
                    }}
                  />
                  <span className="flex-1 truncate">{field.label}</span>
                  {reorderable && (
                    <span className="flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Move ${field.label} up`}
                        disabled={index === 0}
                        onClick={() => {
                          commit(moveColumn(chosen, slug, index - 1))
                        }}
                      >
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Move ${field.label} down`}
                        disabled={index === chosen.length - 1}
                        onClick={() => {
                          commit(moveColumn(chosen, slug, index + 1))
                        }}
                      >
                        <ArrowDownIcon />
                      </Button>
                    </span>
                  )}
                </div>
              )
            })}

            {hidden.length > 0 && (
              <p className="text-muted-foreground mt-3 mb-1 px-2 text-xs font-medium">Hidden</p>
            )}
            {hidden.map((field) => (
              <label
                key={field.slug}
                className="hover:bg-accent flex h-8 cursor-pointer items-center gap-2 rounded px-2 text-sm"
              >
                <span className="size-3.5 shrink-0" />
                <Checkbox
                  label={`Show ${field.label}`}
                  checked={false}
                  onCheckedChange={() => {
                    commit([...chosen, field.slug])
                  }}
                />
                <span className="text-muted-foreground flex-1 truncate">{field.label}</span>
              </label>
            ))}
          </div>

          <div className="mt-2 flex justify-end border-t pt-2">
            <Button variant="ghost" size="xs" onClick={onReset}>
              Reset to default
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function matches(field: FieldDescriptor, query: string): boolean {
  return query === '' || field.label.toLowerCase().includes(query)
}
