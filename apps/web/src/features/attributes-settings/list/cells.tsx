/**
 * What each column of the attributes list looks like.
 *
 * Two of the seven need something the cell registry cannot give them, and both are in §6.7 by
 * name: the Title carries the lock and the row's actions, and the Type is "icon + label" rather
 * than the coloured chip a `single_select` renders everywhere else. The rest go straight through
 * `AttributeCell`, which is why Used in is right-aligned and tabular and the two dates read in the
 * profile's locale without a line of code here saying so.
 *
 * The renderers are a `Record` keyed by the column slugs `schema.ts` declares, so adding a column
 * there without deciding what it looks like is a compile error rather than a blank cell.
 */
import type { AttributeDefinition } from '@mutuals/core'
import { LockIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon } from 'lucide-react'
import type { ReactNode } from 'react'

import { AttributeCell } from '@/attributes/attribute-cell.tsx'
import type { RecordRow } from '@/table/record-row.ts'
import { Button } from '@/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu.tsx'

import { typeIcon } from '../editor/type-meta.ts'
import { ATTRIBUTE_LIST_COLUMNS, type AttributeListSlug } from './schema.ts'

export interface AttributeCellContext {
  readonly row: RecordRow
  readonly definition: AttributeDefinition
  /** True for a definition the API refuses to delete, and the reason for the lock (§6.7). */
  readonly isSystem: boolean
  readonly onEdit: (id: string) => void
  readonly onDelete: (id: string) => void
}

type CellRenderer = (context: AttributeCellContext) => ReactNode

function ValueCell({ row, definition }: AttributeCellContext) {
  return <AttributeCell definition={definition} value={row.attributes[definition.slug]} />
}

/**
 * The row's identity and its actions in one cell.
 *
 * §6.7 says clicking a row opens the edit dialog. The DataTable owns the `<tr>` and offers no row
 * click, so the title itself is the control — which also keeps the row keyboard-reachable, and
 * leaves the checkbox beside it doing only what a checkbox does.
 */
function TitleCell({ row, isSystem, onEdit, onDelete }: AttributeCellContext) {
  const title = row.displayName

  return (
    <span className="group/title flex min-w-0 items-center gap-1.5">
      {isSystem && (
        <span title="Built in — it cannot be deleted" className="flex shrink-0 items-center">
          <LockIcon role="img" aria-label="Built in" className="text-muted-foreground size-3.5" />
        </span>
      )}

      <button
        type="button"
        title={title}
        onClick={() => {
          onEdit(row.id)
        }}
        className="min-w-0 flex-1 truncate text-left font-medium underline-offset-2 outline-none hover:underline focus-visible:underline"
      >
        {title}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${title}`}
            // Hidden until the row is hovered or the button is focused: a column of identical
            // dots would compete with the values for attention on every one of thirty rows.
            className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover/title:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuItem
            onSelect={() => {
              onEdit(row.id)
            }}
          >
            <PencilIcon />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={isSystem}
            onSelect={() => {
              onDelete(row.id)
            }}
          >
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}

/** §6.7: "Type (icon + label)". The icon comes from the type registry's presentation table. */
function TypeCell({ row, definition }: AttributeCellContext) {
  const value = row.attributes[definition.slug]
  if (value?.type !== 'single_select') return null
  const Icon = typeIcon(value.value.key)

  return (
    <span className="flex min-w-0 items-center gap-2" title={value.value.label}>
      {Icon !== undefined && <Icon className="text-muted-foreground size-3.5 shrink-0" />}
      <span className="truncate">{value.value.label}</span>
    </span>
  )
}

/** A slug is an identifier: it reads as one, and it is what an import maps a column onto. */
function SlugCell({ row, definition }: AttributeCellContext) {
  const value = row.attributes[definition.slug]
  if (value?.type !== 'short_text') return null
  return (
    <code title={value.value} className="text-muted-foreground block truncate font-mono text-xs">
      {value.value}
    </code>
  )
}

const CELLS: Record<AttributeListSlug, CellRenderer> = {
  title: TitleCell,
  slug: SlugCell,
  type: TypeCell,
  group: ValueCell,
  used_in: ValueCell,
  created_at: ValueCell,
  updated_at: ValueCell,
}

const SLUGS: ReadonlySet<string> = new Set(ATTRIBUTE_LIST_COLUMNS.map((column) => column.slug))

function isListSlug(slug: string): slug is AttributeListSlug {
  return SLUGS.has(slug)
}

export function renderAttributeListCell(slug: string, context: AttributeCellContext): ReactNode {
  const Renderer = isListSlug(slug) ? CELLS[slug] : ValueCell
  return <Renderer {...context} />
}
