/**
 * The one column factory (ADR-052).
 *
 * `useRecordColumns` turns `FieldDescriptor[]` — system columns, derived columns and user-defined
 * attributes, already merged into one namespace by `packages/core` — into TanStack column
 * definitions. There is no per-page switch and no hand-written column: Contacts, Organizations,
 * Follow-ups and the import preview all arrive here with a different array and leave with a table.
 *
 * `accessorFn`, never `accessorKey`: a slug may contain characters TanStack reads as a deep path,
 * and the value of a cell is not a property of the row anyway (§4.2 puts it under `attributes`).
 */
import { fieldValueKind, type FieldDescriptor } from '@mutuals/core'
import type { ReactNode } from 'react'
import { useMemo } from 'react'

import { cellValue } from './cell-value.ts'
import { Checkbox } from './checkbox.tsx'
import { SELECT_COLUMN_ID } from './column-layout.ts'
import type { RecordRow } from './record-row.ts'
import type { RecordColumnDef, RecordColumnMeta } from './table-features.ts'

export type RecordCellRenderer = (props: { row: RecordRow; field: FieldDescriptor }) => ReactNode

export const SELECT_COLUMN_WIDTH = 40
const LABEL_WIDTH = 232

/**
 * Column widths as a function of what the column holds, not of what it is called.
 *
 * A date is a date wide everywhere; a tag list needs room for two chips; a markdown note gets the
 * widest column and still truncates. Resizing is out of Phase 1 (ADR-051), so these are the final
 * widths and they are chosen to make the default Contacts view fit without a horizontal scrollbar.
 */
export function widthFor(field: FieldDescriptor, isLabel: boolean): number {
  if (isLabel) return LABEL_WIDTH
  if (field.source.kind === 'attribute') {
    switch (field.source.def.type) {
      case 'long_text':
        return 280
      case 'tags':
      case 'multi_select':
      case 'relation':
        return 200
      case 'date':
        return 132
      case 'yes_no':
        return 96
      case 'number':
        return 116
      default:
        return 176
    }
  }
  switch (fieldValueKind(field)) {
    case 'date':
      return 140
    case 'bool':
      return 96
    case 'number':
      return 116
    default:
      return 176
  }
}

export function recordColumnMeta(
  field: FieldDescriptor,
  isLabel: boolean,
  editable: boolean,
): RecordColumnMeta {
  return {
    field,
    width: widthFor(field, isLabel),
    ...(fieldValueKind(field) === 'number' && !isLabel ? { align: 'end' as const } : {}),
    editable,
  }
}

export interface UseRecordColumnsOptions {
  readonly fields: readonly FieldDescriptor[]
  /** The record's label column: sticky, never hideable, always first. */
  readonly labelSlug: string
  readonly renderCell: RecordCellRenderer
  readonly isEditable: (field: FieldDescriptor) => boolean
}

/**
 * The selection column. It is a `DisplayColumnDef` — no accessor, because selection is state
 * about a row rather than a value in it.
 */
function selectColumn(): RecordColumnDef {
  return {
    id: SELECT_COLUMN_ID,
    enableSorting: false,
    enableHiding: false,
    meta: { width: SELECT_COLUMN_WIDTH },
    header: ({ table }) => (
      <Checkbox
        label="Select all loaded rows"
        checked={table.getIsAllRowsSelected()}
        indeterminate={table.getIsSomeRowsSelected()}
        onCheckedChange={table.getToggleAllRowsSelectedHandler()}
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        label={`Select ${row.original.displayName}`}
        checked={row.getIsSelected()}
        onCheckedChange={row.getToggleSelectedHandler()}
      />
    ),
  }
}

export function useRecordColumns({
  fields,
  labelSlug,
  renderCell,
  isEditable,
}: UseRecordColumnsOptions): RecordColumnDef[] {
  return useMemo(() => {
    const columns: RecordColumnDef[] = [selectColumn()]
    for (const field of fields) {
      const isLabel = field.slug === labelSlug
      columns.push({
        id: field.slug,
        accessorFn: (row: RecordRow) => cellValue(row, field),
        header: field.label,
        // §4.2's "—" column: a type with no sort semantics makes its header unclickable, and the
        // API answers a sort request on it with 400 rather than inventing an order.
        enableSorting: field.sortable,
        enableHiding: !isLabel,
        meta: recordColumnMeta(field, isLabel, isEditable(field)),
        cell: ({ row }) => renderCell({ row: row.original, field }),
      })
    }
    return columns
  }, [fields, labelSlug, renderCell, isEditable])
}
