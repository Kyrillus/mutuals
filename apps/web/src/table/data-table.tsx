import type { FieldDescriptor, ListQuery } from '@mutuals/core'
import {
  functionalUpdate,
  useTable,
  type ColumnVisibilityState,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { MoreVerticalIcon, UsersIcon } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils.ts'
import { Button } from '@/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu.tsx'

import { SELECT_COLUMN_ID, columnLayout, layoutToColumns } from './column-layout.ts'
import { ColumnsMenu } from './columns-menu.tsx'
import { SELECT_COLUMN_WIDTH, useRecordColumns, type RecordCellRenderer } from './columns.tsx'
import type { RecordRow } from './record-row.ts'
import { SearchBox } from './search-box.tsx'
import { SelectionBar } from './selection-bar.tsx'
import { ErrorRow, NoMatchesRow, SkeletonRows, TableMessageRow } from './table-states.tsx'
import { recordTableFeatures } from './table-features.ts'

/** ADR-053. Fixed, so `measureElement` and its entire failure mode do not exist. */
export const ROW_HEIGHT = 40

/** How close to the bottom of the loaded rows the viewport gets before the next page is asked for. */
const PREFETCH_ROWS = 8

/**
 * An open editor for one cell. The table knows only that one is open and that `onDone` closes it;
 * what a value is, how it is validated and where it is written all live in the feature that
 * supplies the renderer.
 */
export type RecordEditorRenderer = (props: {
  row: RecordRow
  field: FieldDescriptor
  onDone: () => void
}) => ReactNode

export interface DataTableProps {
  readonly fields: readonly FieldDescriptor[]
  readonly labelSlug: string
  readonly query: ListQuery
  readonly onSortChange: (field: string, desc: boolean) => void
  readonly onColumnsChange: (columns: readonly string[]) => void
  readonly onColumnsReset: () => void
  readonly onSearchChange: (q: string | null) => void
  readonly onClearView: () => void

  readonly rows: RecordRow[]
  readonly total: number | null
  readonly isLoading: boolean
  readonly isFetchingNextPage: boolean
  readonly hasNextPage: boolean
  readonly fetchNextPage: () => void
  readonly error: Error | null
  readonly onRetry: () => void

  readonly renderCell: RecordCellRenderer
  readonly renderEditor: RecordEditorRenderer
  readonly isEditable: (field: FieldDescriptor) => boolean
  /** `${recordId}:${slug}` for every cell with a write in flight (ADR-049's side map). */
  readonly pendingCells: ReadonlySet<string>

  /** Singular and lower case: "contact". */
  readonly noun: string
  readonly onDeleteSelected: (ids: readonly string[]) => void
  readonly isDeleting: boolean
  readonly onExportSelected: (
    rows: readonly RecordRow[],
    fields: readonly FieldDescriptor[],
  ) => void

  readonly filterBar?: ReactNode
  readonly primaryAction?: ReactNode
  readonly emptyAction?: ReactNode
  readonly onTableSettings?: () => void
}

/**
 * The one data table (§5.2, ADR-051, ADR-053).
 *
 * It is driven entirely by `FieldDescriptor[]`, so it does not know that a contact has a name: the
 * same component renders Organizations, Follow-ups, Interactions, the Attributes list and the
 * import preview by being handed a different array.
 *
 * **Server-driven.** No row model is registered. Filtering, sorting, pagination and counting
 * happen in Postgres; `manualSorting` tells the sorting feature that the rows it was handed are
 * already in order.
 *
 * **Virtualisation.** Rows are a fixed 40px and the window is positioned by two spacer rows rather
 * than by `position: absolute` on each `<tr>`. Absolute positioning blockifies a table row, which
 * takes its cells out of the table's formatting context — and `table-fixed` column widths and the
 * sticky first column, the two things ADR-053 set out to keep, are exactly what that destroys.
 * Spacer rows deliver the same result (native roles, no `measureElement`) with none of that.
 */
export function DataTable({
  fields,
  labelSlug,
  query,
  onSortChange,
  onColumnsChange,
  onColumnsReset,
  onSearchChange,
  onClearView,
  rows,
  total,
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  fetchNextPage,
  error,
  onRetry,
  renderCell,
  renderEditor,
  isEditable,
  pendingCells,
  noun,
  onDeleteSelected,
  isDeleting,
  onExportSelected,
  filterBar,
  primaryAction,
  emptyAction,
  onTableSettings,
}: DataTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [editing, setEditing] = useState<{ rowId: string; slug: string } | null>(null)

  const layout = useMemo(
    () => columnLayout(fields, labelSlug, query.columns),
    [fields, labelSlug, query.columns],
  )
  const visible = useMemo(
    () => layoutToColumns(layout.order, layout.visibility),
    [layout.order, layout.visibility],
  )

  const columnOrder = useMemo(() => [...layout.order], [layout.order])
  const columns = useRecordColumns({ fields, labelSlug, renderCell, isEditable })

  const sorting: SortingState = useMemo(
    () =>
      query.sort === null ? [] : [{ id: query.sort.field, desc: query.sort.direction === 'desc' }],
    [query.sort],
  )

  const table = useTable({
    features: recordTableFeatures,
    columns,
    data: rows,
    getRowId: (row) => row.id,
    manualSorting: true,
    enableMultiSort: false,
    // §5.2 asks for two states, not three: the usual third click returns the table to an order
    // nobody chose, on a page where order is the entire question being asked.
    enableSortingRemoval: false,
    sortDescFirst: false,
    initialState: { columnPinning: { start: [SELECT_COLUMN_ID, labelSlug], end: [] } },
    state: {
      sorting,
      rowSelection,
      columnOrder,
      columnVisibility: layout.visibility as ColumnVisibilityState,
    },
    onRowSelectionChange: setRowSelection,
    onSortingChange: (updater) => {
      const next = functionalUpdate(updater, sorting)
      const first = next[0]
      if (first !== undefined) onSortChange(first.id, first.desc)
    },
    onColumnVisibilityChange: (updater) => {
      onColumnsChange(layoutToColumns(layout.order, functionalUpdate(updater, layout.visibility)))
    },
    onColumnOrderChange: (updater) => {
      onColumnsChange(layoutToColumns(functionalUpdate(updater, columnOrder), layout.visibility))
    },
  })

  const leafColumns = table.getVisibleLeafColumns()
  const widths = leafColumns.map((column) => column.columnDef.meta?.width ?? SELECT_COLUMN_WIDTH)
  const totalWidth = widths.reduce((sum, width) => sum + width, 0)
  // The sticky offsets are summed here because `column.getStart()` belongs to
  // `columnSizingFeature`, which is not registered — resizing is out of Phase 1 (ADR-051).
  const offsets = widths.map((_width, index) =>
    widths.slice(0, index).reduce((sum, width) => sum + width, 0),
  )

  const tableRows = table.getRowModel().rows

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => tableRows[index]?.id ?? index,
    // ADR-049: the fetch-more trigger belongs to the virtualizer, not to a `useEffect` whose
    // inline-arrow dependency made it run on every render.
    onChange: (instance) => {
      const last = instance.getVirtualItems().at(-1)
      if (last === undefined) return
      if (hasNextPage && !isFetchingNextPage && last.index >= tableRows.length - PREFETCH_ROWS) {
        fetchNextPage()
      }
    },
  })

  const items = virtualizer.getVirtualItems()
  const first = items[0]
  const last = items.at(-1)
  const padTop = first?.start ?? 0
  const padBottom = last === undefined ? 0 : virtualizer.getTotalSize() - last.end

  const selectedRows = table.getSelectedRowModel().rows.map((row) => row.original)
  const visibleFields = leafColumns.flatMap((column) =>
    column.columnDef.meta?.field === undefined ? [] : [column.columnDef.meta.field],
  )

  const hasView = query.filter.length > 0 || query.q !== null
  const columnCount = leafColumns.length

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">{filterBar}</div>
        <div className="flex shrink-0 items-center gap-2">
          <SearchBox value={query.q} onChange={onSearchChange} placeholder="Search…" />
          <ColumnsMenu
            fields={fields}
            visible={visible}
            labelSlug={labelSlug}
            onChange={onColumnsChange}
            onReset={onColumnsReset}
          />
          <ViewMenu onTableSettings={onTableSettings} />
          {primaryAction}
        </div>
      </div>

      <div className="relative min-h-0">
        <div
          ref={scrollRef}
          className="border-border h-[calc(100dvh-17rem)] min-h-72 overflow-auto rounded-lg border"
        >
          <table
            className="border-separate border-spacing-0 text-left"
            style={{ width: Math.max(totalWidth, 100) }}
          >
            <colgroup>
              {leafColumns.map((column, index) => (
                <col key={column.id} style={{ width: widths[index] }} />
              ))}
            </colgroup>

            <thead>
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id}>
                  {group.headers.map((header, index) => {
                    const pinned = header.column.getIsPinned() === 'start'
                    const sorted = header.column.getIsSorted()
                    const sortable = header.column.getCanSort()
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        aria-sort={
                          sorted === false
                            ? undefined
                            : sorted === 'desc'
                              ? 'descending'
                              : 'ascending'
                        }
                        style={{ left: pinned ? offsets[index] : undefined }}
                        className={cn(
                          'bg-background border-border text-muted-foreground sticky top-0 h-header-row border-b px-3 text-xs font-medium',
                          pinned ? 'z-30' : 'z-20',
                          pinned && index > 0 && 'border-r',
                          header.column.columnDef.meta?.align === 'end' && 'text-right',
                        )}
                      >
                        {header.isPlaceholder ? null : sortable ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className="group hover:text-foreground -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-1 rounded px-1 py-1"
                          >
                            <span className="truncate">
                              <table.FlexRender header={header} />
                            </span>
                            <SortArrow direction={sorted} />
                          </button>
                        ) : (
                          <span className="flex items-center truncate">
                            <table.FlexRender header={header} />
                          </span>
                        )}
                      </th>
                    )
                  })}
                </tr>
              ))}
            </thead>

            <tbody>
              {isLoading && <SkeletonRows columns={columnCount} />}

              {!isLoading && error !== null && (
                <ErrorRow columns={columnCount} message={error.message} onRetry={onRetry} />
              )}

              {!isLoading && error === null && tableRows.length === 0 && hasView && (
                <NoMatchesRow columns={columnCount} onClear={onClearView} />
              )}

              {!isLoading && error === null && tableRows.length === 0 && !hasView && (
                <TableMessageRow
                  columns={columnCount}
                  icon={UsersIcon}
                  title={`No ${noun}s yet`}
                  description={`Nothing has been added to this table. Create the first ${noun} and the columns below will fill in.`}
                >
                  {emptyAction}
                </TableMessageRow>
              )}

              {padTop > 0 && (
                <tr aria-hidden style={{ height: padTop }}>
                  <td colSpan={columnCount} />
                </tr>
              )}

              {items.map((item) => {
                const row = tableRows[item.index]
                if (row === undefined) return null
                const selected = row.getIsSelected()
                return (
                  <tr
                    key={row.id}
                    data-selected={selected}
                    className="h-row bg-background hover:bg-muted data-[selected=true]:bg-accent"
                  >
                    {row.getVisibleCells().map((cell, index) => {
                      const meta = cell.column.columnDef.meta
                      const field = meta?.field
                      const pinned = cell.column.getIsPinned() === 'start'
                      const editable = meta?.editable === true && field !== undefined
                      const isEditing =
                        editing?.rowId === row.id &&
                        field !== undefined &&
                        editing.slug === field.slug
                      const pending =
                        field !== undefined && pendingCells.has(`${row.id}:${field.slug}`)

                      return (
                        <td
                          key={cell.id}
                          style={{ left: pinned ? offsets[index] : undefined }}
                          tabIndex={editable ? 0 : undefined}
                          onDoubleClick={
                            editable
                              ? () => {
                                  setEditing({ rowId: row.id, slug: field.slug })
                                }
                              : undefined
                          }
                          onKeyDown={
                            editable
                              ? (event) => {
                                  if (event.key !== 'Enter' || isEditing) return
                                  event.preventDefault()
                                  setEditing({ rowId: row.id, slug: field.slug })
                                }
                              : undefined
                          }
                          className={cn(
                            'border-border/60 h-row truncate border-b px-3',
                            pinned && 'bg-inherit sticky z-10',
                            pinned && index > 0 && 'border-r',
                            meta?.align === 'end' && 'text-right',
                            editable &&
                              'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
                            pending && 'animate-pulse',
                          )}
                        >
                          {isEditing && field !== undefined ? (
                            renderEditor({
                              row: row.original,
                              field,
                              onDone: () => {
                                setEditing(null)
                              },
                            })
                          ) : (
                            <table.FlexRender cell={cell} />
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}

              {padBottom > 0 && (
                <tr aria-hidden style={{ height: padBottom }}>
                  <td colSpan={columnCount} />
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <SelectionBar
          count={selectedRows.length}
          noun={noun}
          busy={isDeleting}
          onExport={() => {
            onExportSelected(selectedRows, visibleFields)
          }}
          onDelete={() => {
            onDeleteSelected(selectedRows.map((row) => row.id))
            setRowSelection({})
          }}
          onClear={() => {
            setRowSelection({})
          }}
        />
      </div>

      <footer className="text-muted-foreground flex items-center justify-between text-xs">
        <span className="tabular-nums">
          Rows:{' '}
          {total === null
            ? tableRows.length.toLocaleString('en-GB')
            : total.toLocaleString('en-GB')}
        </span>
        {isFetchingNextPage && <span>Loading more…</span>}
      </footer>
    </div>
  )
}

function SortArrow({ direction }: { direction: false | 'asc' | 'desc' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'text-foreground ml-auto shrink-0 text-[10px] leading-none',
        direction === false && 'opacity-0 transition-opacity group-hover:opacity-40',
      )}
    >
      {direction === 'desc' ? '↓' : '↑'}
    </span>
  )
}

/**
 * §5.2's `⋮`. The three saved-view actions are §6.6 and land in Stage 4; they are shown disabled
 * rather than hidden so the menu does not change shape under the user when views arrive.
 */
function ViewMenu({ onTableSettings }: { onTableSettings?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="View options">
          <MoreVerticalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem disabled>Revert changes</DropdownMenuItem>
        <DropdownMenuItem disabled>Save changes to view</DropdownMenuItem>
        <DropdownMenuItem disabled>Save as new view</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onTableSettings}>Table settings</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
