import type { AttributeDefinitionDto, FieldDescriptor } from '@mutuals/core'
import { useRef, useState, type ReactNode } from 'react'

import { Link } from '@tanstack/react-router'

import { AttributeCell } from '@/attributes/attribute-cell.tsx'
import { useDisplay } from '@/attributes/display-context.tsx'
import { attributeTypeOf, toDraft, toWriteValue } from '@/attributes/value.ts'

import { AttributeControl } from './attribute-control.tsx'
import { initialsOf, type RecordRow } from '@/table/record-row.ts'
import { SystemCell } from '@/table/system-cell.tsx'
import { Avatar, AvatarFallback } from '@/ui/avatar.tsx'

/** The definitions the row's attributes are described by, by slug. */
export type DefinitionIndex = ReadonlyMap<string, AttributeDefinitionDto>

/**
 * The three ways a cell can be rendered, chosen by what the field *is* rather than by what it is
 * called: the record's label, a user-defined attribute, or a system/derived column.
 */
export function RecordCell({
  row,
  field,
  labelSlug,
  definitions,
}: {
  row: RecordRow
  field: FieldDescriptor
  labelSlug: string
  definitions: DefinitionIndex
}): ReactNode {
  if (field.slug === labelSlug) return <LabelCell row={row} />

  const definition = definitions.get(field.slug)
  if (definition === undefined) return <SystemCell row={row} field={field} />
  return <AttributeCell definition={definition} value={row.attributes[field.slug]} />
}

/**
 * §6.2's sticky first column: avatar plus display name, linking to the detail page.
 *
 * Stage 2 left this as text and said so: "a link into a route that does not exist is worse than
 * none. This span is the only thing that changes when it lands." It has landed, and this is that
 * change. `recordHref` comes from the display context rather than being spelled out here, so the
 * cell does not learn the URL grammar of every object type.
 */
function LabelCell({ row }: { row: RecordRow }) {
  const { recordHref } = useDisplay()
  return (
    <Link
      to={recordHref(row.objectType, row.id)}
      className="flex items-center gap-2 overflow-hidden hover:underline"
    >
      <Avatar size="sm" className="shrink-0">
        <AvatarFallback className="text-[10px]">{initialsOf(row.displayName)}</AvatarFallback>
      </Avatar>
      <span className="truncate font-medium">{row.displayName}</span>
    </Link>
  )
}

/**
 * The inline editor for one cell (§5.2).
 *
 * It commits on blur, on Enter, or when the control says so — a select is finished the moment an
 * option is chosen and waiting for a blur there feels broken. Escape cancels, and the cell falls
 * back to whatever the cache holds, which after a rollback is the value that was there before.
 *
 * The draft lives in state rather than in a ref because the control is controlled: `@/attributes`
 * splits `onChange` (every keystroke) from `onCommit` (persist now) precisely so that one write
 * leaves per edit instead of one per character.
 */
export function RecordEditorCell({
  row,
  field,
  definition,
  onCommit,
  onCancel,
}: {
  row: RecordRow
  field: FieldDescriptor
  definition: AttributeDefinitionDto
  /** The write value, as `PATCH /contacts/:id` takes it; `null` clears (ADR-031). */
  onCommit: (write: unknown) => void
  onCancel: () => void
}): ReactNode {
  const [draft, setDraft] = useState<unknown>(() =>
    toWriteValue(attributeTypeOf(definition), toDraft(row.attributes[field.slug])),
  )
  const latest = useRef(draft)
  const done = useRef(false)
  latest.current = draft

  function finish() {
    if (done.current) return
    done.current = true
    onCommit(latest.current)
  }

  return (
    <span
      className="flex items-center"
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        finish()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          done.current = true
          onCancel()
          return
        }
        // Shift+Enter is a newline in the one control that has newlines; everywhere else it is
        // indistinguishable from Enter and committing on it would be surprising.
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          finish()
        }
      }}
    >
      <AttributeControl
        definition={definition}
        value={draft}
        autoFocus
        aria-label={field.label}
        onChange={(next) => {
          setDraft(next)
          latest.current = next
        }}
        onCommit={finish}
        onCancel={() => {
          done.current = true
          onCancel()
        }}
      />
    </span>
  )
}
