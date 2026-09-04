/**
 * The five features this table registers, and nothing else (ADR-051).
 *
 * Filtering, sorting, pagination and counting all happen in Postgres, so no row model is
 * registered: `getRowModel()` returns the core model — the rows the server sent, in the order the
 * server sent them. Registering `rowSortingFeature` buys the header's sort *state* and its
 * handlers, not a client-side sort, which is why `manualSorting` is set on the options.
 *
 * `columnMeta` is declared through v9's type-only slot rather than by augmenting
 * `@tanstack/react-table` globally: the Attributes list and the import Review grid are different
 * tables with different meta, and a global augmentation would force one shape on all three.
 */
import type { FieldDescriptor } from '@mutuals/core'
import {
  columnOrderingFeature,
  columnPinningFeature,
  columnVisibilityFeature,
  metaHelper,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  type ColumnDef,
} from '@tanstack/react-table'

import type { RecordRow } from './record-row.ts'

export interface RecordColumnMeta {
  /** Absent on the selection column, which is furniture rather than a field. */
  readonly field?: FieldDescriptor
  /**
   * Pixels. Not `columnDef.size`: that option belongs to `columnSizingFeature`, which is not
   * registered (resizing is out of Phase 1), so it would be an excess property and would not
   * compile. The width is applied by `<col>` and `table-fixed`.
   */
  readonly width: number
  readonly align?: 'start' | 'end'
  readonly editable?: boolean
}

export const recordTableFeatures = tableFeatures({
  columnVisibilityFeature,
  columnOrderingFeature,
  columnPinningFeature,
  rowSelectionFeature,
  rowSortingFeature,
  columnMeta: metaHelper<RecordColumnMeta>(),
})

export type RecordTableFeatures = typeof recordTableFeatures

export type RecordColumnDef = ColumnDef<RecordTableFeatures, RecordRow>
