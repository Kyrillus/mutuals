/**
 * §6.5's right-hand column: every field a record can hold, grouped, inline-editable, each with its
 * own history.
 *
 * Nothing here names a field. The list is `resolver.list()` — system columns, derived columns and
 * whatever the user invented this morning, in one namespace — grouped by the `group` the attribute
 * carries. A thirteenth group appears because somebody typed it in Settings, not because this file
 * learned about it.
 *
 * Writes go through the same {@link useRecordEdit} the table's inline editing uses, so the
 * optimistic patch, the rollback and the retry toast are one implementation rather than two.
 */
import type { AttributeDefinitionDto, FieldDescriptor } from '@mutuals/core'
import { useRef, useState } from 'react'

import { AttributeCell } from '@/attributes/attribute-cell.tsx'
import { attributeTypeOf, toDraft, toWriteValue } from '@/attributes/value.ts'
import { AttributeControl } from '@/features/records/attribute-control.tsx'
import { ValueHistoryPopover } from '@/features/records/value-history-popover.tsx'
import { SystemCell } from '@/table/system-cell.tsx'
import type { RecordRow } from '@/table/record-row.ts'
import { cn } from '@/lib/utils.ts'

import type { RecordObjectType } from '../record-api.ts'
import type { RecordEditor } from '../use-record-edit.ts'

/** Attributes with no `group` of their own land here, per §6.5. */
const UNGROUPED = 'Details'

export function AttributeSidebar({
  row,
  objectType,
  fields,
  definitions,
  editor,
}: {
  row: RecordRow
  objectType: RecordObjectType
  fields: readonly FieldDescriptor[]
  definitions: ReadonlyMap<string, AttributeDefinitionDto>
  editor: RecordEditor
}) {
  const groups = new Map<string, FieldDescriptor[]>()
  for (const field of fields) {
    // The label is the page's heading; repeating it as the first row of the sidebar is noise.
    if (field.slug === 'display_name' || field.slug === 'name') continue
    const group = definitions.get(field.slug)?.group ?? field.group ?? UNGROUPED
    const list = groups.get(group) ?? []
    list.push(field)
    groups.set(group, list)
  }

  return (
    <aside className="w-80 shrink-0" aria-label="All information">
      <h2 className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
        All information
      </h2>
      <div className="flex flex-col gap-5">
        {[...groups].map(([group, groupFields]) => (
          <section key={group}>
            <h3 className="text-muted-foreground mb-1.5 text-xs font-medium">{group}</h3>
            <dl className="flex flex-col">
              {groupFields.map((field) => (
                <SidebarRow
                  key={field.slug}
                  row={row}
                  objectType={objectType}
                  field={field}
                  definition={definitions.get(field.slug)}
                  editor={editor}
                />
              ))}
            </dl>
          </section>
        ))}
      </div>
    </aside>
  )
}

function SidebarRow({
  row,
  objectType,
  field,
  definition,
  editor,
}: {
  row: RecordRow
  objectType: RecordObjectType
  field: FieldDescriptor
  definition: AttributeDefinitionDto | undefined
  editor: RecordEditor
}) {
  const [editing, setEditing] = useState(false)
  const value = row.attributes[field.slug]

  // Derived columns are computed, not stored (§5.2): warmth and the interaction counts render, and
  // refuse to be typed into, without this file knowing which ones they are.
  const editable =
    definition !== undefined && !definition.isDerived && field.slug !== 'display_name'

  return (
    <div className="group flex min-h-8 items-start gap-2 py-1">
      <dt
        className="text-muted-foreground w-32 shrink-0 truncate pt-0.5 text-xs"
        title={field.label}
      >
        {field.label}
      </dt>

      <dd className="flex min-w-0 flex-1 items-start gap-1">
        <div className="min-w-0 flex-1 text-sm">
          {editing && definition !== undefined ? (
            <SidebarEditor
              row={row}
              field={field}
              definition={definition}
              editor={editor}
              onDone={() => {
                setEditing(false)
              }}
            />
          ) : (
            <button
              type="button"
              disabled={!editable}
              onClick={() => {
                setEditing(true)
              }}
              className={cn(
                'w-full rounded px-1 py-0.5 text-left',
                editable && 'hover:bg-accent focus-visible:ring-ring focus-visible:ring-2',
                !editable && 'cursor-default',
              )}
              aria-label={editable ? `Edit ${field.label}` : undefined}
            >
              {definition === undefined ? (
                <SystemCell row={row} field={field} />
              ) : (
                <AttributeCell definition={definition} value={value} />
              )}
            </button>
          )}
        </div>

        {definition !== undefined && (
          <ValueHistoryPopover recordId={row.id} definition={definition} label={field.label} />
        )}
      </dd>
    </div>
  )
}

function SidebarEditor({
  row,
  field,
  definition,
  editor,
  onDone,
}: {
  row: RecordRow
  field: FieldDescriptor
  definition: AttributeDefinitionDto
  editor: RecordEditor
  onDone: () => void
}) {
  const [draft, setDraft] = useState<unknown>(() =>
    toWriteValue(attributeTypeOf(definition), toDraft(row.attributes[field.slug])),
  )

  /**
   * One edit, one write.
   *
   * Enter commits and then the control loses focus, so `onKeyDown`, the control's own `onCommit`
   * and this wrapper's `onBlur` all fire for a single keystroke. Without the latch that is **two
   * PATCHes per edit** — invisible while they succeed, because the second writes the same value
   * and the optimistic patch hides it, and very visible when they fail, as two identical error
   * toasts. `record-cell.tsx` has had this latch since Stage 3; this editor never got it.
   */
  const done = useRef(false)

  function commit() {
    if (done.current) return
    done.current = true
    editor.commit(row, field, definition, draft)
    onDone()
  }

  function cancel() {
    done.current = true
    onDone()
  }

  return (
    <span
      className="flex items-center"
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        commit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          cancel()
          return
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          commit()
        }
      }}
    >
      <AttributeControl
        definition={definition}
        value={draft}
        autoFocus
        aria-label={field.label}
        onChange={setDraft}
        onCommit={commit}
        onCancel={cancel}
      />
    </span>
  )
}
