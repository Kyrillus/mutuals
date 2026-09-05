import type { FieldDescriptor } from '@mutuals/core'
import { AlertTriangle, type LucideIcon } from 'lucide-react'
import { useCallback, useMemo, useState, type ReactNode } from 'react'

import { isEditable } from '@/attributes/attribute-input.tsx'
import { DisplayProvider } from '@/attributes/display-context.tsx'
import { EmptyState } from '@/components/app-shell/page.tsx'
import { useListQuery } from '@/hooks/use-list-query.ts'
import { csvFileName, downloadCsv, recordsToCsv } from '@/table/csv.ts'
import { DataTable } from '@/table/data-table.tsx'
import { labelSlug, recordFieldResolver } from '@/table/fields.ts'
import { FilterBar } from '@/table/filter-bar/filter-bar.tsx'
import type { RecordRow } from '@/table/record-row.ts'
import { Button } from '@/ui/button.tsx'
import { Skeleton } from '@/ui/skeleton.tsx'

import { RecordCell, RecordEditorCell, type DefinitionIndex } from './record-cell.tsx'
import type { RecordObjectType } from './record-api.ts'
import { useAttributeDefinitions } from './use-attribute-definitions.ts'
import { SaveViewDialog, ViewMenuItems, ViewPicker } from '@/features/views/view-menu.tsx'
import { useViewState } from '@/features/views/use-view-state.ts'
import { useRecordEdit } from './use-record-edit.ts'
import { useRecordList } from './use-record-list.ts'
import { useDeleteRecords } from './use-record-mutations.ts'

export interface RecordTableProps {
  readonly objectType: RecordObjectType
  /**
   * The columns a bare `/contacts` opens with (§6.2). A page-level default, not a column
   * definition: the table reads `FieldDescriptor[]` and would render this page with none of these
   * slugs present. In Stage 4 it becomes the seeded `All contacts` saved view (§6.6).
   */
  readonly defaultColumns?: readonly string[]
  readonly primaryAction?: ReactNode
  readonly emptyAction?: ReactNode
  readonly emptyIcon?: LucideIcon
  readonly onTableSettings?: () => void
}

/**
 * One object type's list page: schema, rows, filters, edits and deletes wired to the DataTable.
 *
 * Everything that knows the object type is in this file. Below it — the table, the column factory,
 * the cells — takes a `FieldDescriptor[]` and a `RecordRow[]` and would render an object type that
 * does not exist yet.
 */
export function RecordTable({
  objectType,
  defaultColumns,
  primaryAction,
  emptyAction,
  emptyIcon,
  onTableSettings,
}: RecordTableProps) {
  const definitions = useAttributeDefinitions(objectType)
  const list = useListQuery()
  const [savingView, setSavingView] = useState(false)
  const editor = useRecordEdit(objectType)
  const deletion = useDeleteRecords(objectType)

  const resolver = useMemo(
    () => recordFieldResolver(objectType, definitions.data ?? []),
    [objectType, definitions.data],
  )
  const fields = resolver.list()
  const label = labelSlug(resolver)

  const bySlug: DefinitionIndex = useMemo(
    () => new Map((definitions.data ?? []).map((definition) => [definition.slug, definition])),
    [definitions.data],
  )

  const query = useMemo(
    () => ({ ...list.query, columns: list.query.columns ?? defaultColumns ?? null }),
    [list.query, defaultColumns],
  )
  const viewState = useViewState(objectType, query.columns)

  const records = useRecordList(objectType, query)

  const renderCell = useCallback(
    ({ row, field }: { row: RecordRow; field: FieldDescriptor }) => (
      <RecordCell row={row} field={field} labelSlug={label} definitions={bySlug} />
    ),
    [label, bySlug],
  )

  const renderEditor = useCallback(
    ({ row, field, onDone }: { row: RecordRow; field: FieldDescriptor; onDone: () => void }) => {
      const definition = bySlug.get(field.slug)
      if (definition === undefined) return null
      return (
        <RecordEditorCell
          row={row}
          field={field}
          definition={definition}
          onCommit={(write) => {
            editor.commit(row, field, definition, write)
            onDone()
          }}
          onCancel={onDone}
        />
      )
    },
    [bySlug, editor],
  )

  /**
   * §5.2 gives an inline editor to every attribute type; a system column has none, because every
   * control in `@/attributes` is written against a definition and a writable system column has no
   * definition to write against. Those are edited in the dialog and, from Stage 3, on the detail
   * page.
   */
  const isFieldEditable = useCallback(
    (field: FieldDescriptor) => {
      const definition = bySlug.get(field.slug)
      return definition !== undefined && isEditable(definition)
    },
    [bySlug],
  )

  const onExportSelected = useCallback(
    (rows: readonly RecordRow[], exported: readonly FieldDescriptor[]) => {
      downloadCsv(csvFileName(objectType, new Date()), recordsToCsv(rows, exported))
    },
    [objectType],
  )

  if (definitions.isPending) return <TableSkeleton />
  if (definitions.error !== null) {
    // Without the schema there is no table at all — not even a header — so this is the whole page
    // and it needs the shape of a page: what failed, why, and the way out. A grey sentence where a
    // table should be reads as an app that has quietly given up.
    return (
      <EmptyState
        icon={AlertTriangle}
        title="This table could not be loaded"
        description={`${definitions.error.message} The columns come from the field definitions, so nothing can be shown until they arrive.`}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void definitions.refetch()
          }}
        >
          Try again
        </Button>
      </EmptyState>
    )
  }

  // Every cell reads its locale, timezone and today from here. Without it the fallback is the
  // browser's own locale, and an English-only product (CLAUDE.md) renders "vor 2 Monaten" on a
  // German machine. It belongs at the app root once something there owns it; until then the
  // feature that renders attribute cells provides it.
  return (
    <DisplayProvider>
      <DataTable
        fields={fields}
        labelSlug={label}
        query={query}
        onSortChange={(field, desc) => {
          list.setSort({ field, direction: desc ? 'desc' : 'asc' })
        }}
        onColumnsChange={list.setColumns}
        onColumnsReset={() => {
          list.setColumns(null)
        }}
        onSearchChange={list.setSearchText}
        onClearView={() => {
          list.update({ filter: [], q: null })
        }}
        rows={records.rows}
        total={records.total}
        isLoading={records.query.isPending}
        isFetchingNextPage={records.query.isFetchingNextPage}
        hasNextPage={records.query.hasNextPage}
        fetchNextPage={() => {
          void records.query.fetchNextPage()
        }}
        error={records.query.error}
        onRetry={() => {
          void records.query.refetch()
        }}
        renderCell={renderCell}
        renderEditor={renderEditor}
        isEditable={isFieldEditable}
        pendingCells={editor.pendingCells}
        noun={objectType}
        onDeleteSelected={(ids) => {
          deletion.mutate(ids)
        }}
        isDeleting={deletion.isPending}
        onExportSelected={onExportSelected}
        filterBar={<FilterBar fields={fields} filter={query.filter} onChange={list.setFilters} />}
        primaryAction={primaryAction}
        emptyAction={emptyAction}
        emptyIcon={emptyIcon}
        onTableSettings={onTableSettings}
        viewPicker={<ViewPicker state={viewState} />}
        viewActions={
          <ViewMenuItems
            objectType={objectType}
            state={viewState}
            onSaveAsNew={() => {
              setSavingView(true)
            }}
          />
        }
      />

      <SaveViewDialog
        open={savingView}
        onOpenChange={setSavingView}
        objectType={objectType}
        state={viewState}
      />
    </DisplayProvider>
  )
}

function TableSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex justify-between">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-72" />
      </div>
      <Skeleton className="h-[calc(100dvh-17rem)] min-h-72 w-full" />
    </div>
  )
}
