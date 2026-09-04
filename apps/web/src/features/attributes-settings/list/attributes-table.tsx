/**
 * §6.7's attributes list — the one DataTable, pointed at the definitions instead of the records.
 *
 * §5.2 says the table is reused for this page, and this file is the whole of that reuse: it hands
 * `DataTable` a `FieldDescriptor[]` (from `schema.ts`) and a `RecordRow[]` (from `rows.ts`) and
 * gets sorting, the Columns picker, the filter bar, search, selection, CSV export, the sticky
 * first column and the empty state without any of them learning that this page exists.
 *
 * The one thing it does differently is where the work happens: `listAttributeDefinitions` answers
 * with the whole set in one page, so filtering, searching and ordering are done here, in
 * `filtering.ts`, against `packages/core`'s own filter model.
 */
import type { FieldDescriptor, ObjectType } from '@mutuals/core'
import { PlusIcon } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import { DisplayProvider, useDisplay } from '@/attributes/display-context.tsx'
import { useListQuery } from '@/hooks/use-list-query.ts'
import { csvFileName, downloadCsv, recordsToCsv } from '@/table/csv.ts'
import { DataTable } from '@/table/data-table.tsx'
import { FilterBar } from '@/table/filter-bar/filter-bar.tsx'
import type { RecordRow } from '@/table/record-row.ts'
import { Button } from '@/ui/button.tsx'
import { Skeleton } from '@/ui/skeleton.tsx'

import { AttributeDialog } from '../editor/attribute-dialog.tsx'
import { useAttributeDefinitions, useDeleteAttributes } from './attribute-api.ts'
import { renderAttributeListCell } from './cells.tsx'
import { DeleteAttributeDialog } from './delete-dialog.tsx'
import { applyListQuery } from './filtering.ts'
import { attributeRows } from './rows.ts'
import { LABEL_SLUG, attributeListSchema } from './schema.ts'

/** Nothing on this page is edited in place, and one frozen set is cheaper than a new one a frame. */
const NO_PENDING_CELLS: ReadonlySet<string> = new Set()

export function AttributesTable({ objectType }: { objectType: ObjectType }) {
  // Every cell reads its locale, its timezone and today from here — including the two date columns,
  // whose values are the calendar days the timestamps fell on where the user is (ADR-045).
  return (
    <DisplayProvider>
      <AttributesTableBody objectType={objectType} />
    </DisplayProvider>
  )
}

function AttributesTableBody({ objectType }: { objectType: ObjectType }) {
  const definitions = useAttributeDefinitions(objectType)
  const deletion = useDeleteAttributes(objectType)
  const list = useListQuery()
  const { timeZone, today } = useDisplay()

  // Both dialogs keep their subject after `open` goes false. A dialog animates out for a moment
  // longer than it is open, and clearing the id — or the selection — in the same tick repaints the
  // sentence the user is still reading as it fades: "Delete 0 attributes?".
  const [editor, setEditor] = useState<{ attributeId?: string; open: boolean }>({ open: false })
  const [deleteRequest, setDeleteRequest] = useState<{
    ids: readonly string[]
    open: boolean
  }>({ ids: [], open: false })

  const schema = useMemo(() => attributeListSchema(objectType), [objectType])

  const rows = useMemo(
    () => attributeRows(definitions.data ?? [], timeZone),
    [definitions.data, timeZone],
  )

  const visible = useMemo(
    () => applyListQuery(rows, schema.fields, list.query, today),
    [rows, schema.fields, list.query, today],
  )

  const systemIds = useMemo(
    () =>
      new Set((definitions.data ?? []).filter((entry) => entry.isSystem).map((entry) => entry.id)),
    [definitions.data],
  )

  const openEditor = useCallback((id: string) => {
    setEditor({ attributeId: id, open: true })
  }, [])

  const askToDelete = useCallback((id: string) => {
    setDeleteRequest({ ids: [id], open: true })
  }, [])

  const renderCell = useCallback(
    ({ row, field }: { row: RecordRow; field: FieldDescriptor }) => {
      const definition = schema.definitions.get(field.slug)
      if (definition === undefined) return null
      return renderAttributeListCell(field.slug, {
        row,
        definition,
        isSystem: systemIds.has(row.id),
        onEdit: openEditor,
        onDelete: askToDelete,
      })
    },
    [schema.definitions, systemIds, openEditor, askToDelete],
  )

  const addButton = (
    <Button
      size="sm"
      className="gap-1.5"
      onClick={() => {
        setEditor({ open: true })
      }}
    >
      <PlusIcon />
      Add new
    </Button>
  )

  if (definitions.isPending) return <TableSkeleton />

  return (
    <>
      <DataTable
        fields={schema.fields}
        labelSlug={LABEL_SLUG}
        query={list.query}
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
        rows={visible}
        total={visible.length}
        isLoading={false}
        isFetchingNextPage={false}
        hasNextPage={false}
        fetchNextPage={() => {
          // One page, always: `listAttributeDefinitions` answers with the whole set.
        }}
        error={definitions.error}
        onRetry={() => {
          void definitions.refetch()
        }}
        renderCell={renderCell}
        // Values are edited in the dialog, where a select's options and a number's unit are
        // editable too; a 40px cell can hold a title and nothing else that matters here.
        renderEditor={() => null}
        isEditable={() => false}
        pendingCells={NO_PENDING_CELLS}
        noun="attribute"
        onDeleteSelected={(ids) => {
          setDeleteRequest({ ids, open: true })
        }}
        isDeleting={deletion.isPending}
        onExportSelected={(selected, fields) => {
          downloadCsv(
            csvFileName(`${objectType}-attribute`, new Date()),
            recordsToCsv(selected, fields),
          )
        }}
        filterBar={
          <FilterBar fields={schema.fields} filter={list.query.filter} onChange={list.setFilters} />
        }
        primaryAction={addButton}
        emptyAction={addButton}
      />

      <AttributeDialog
        objectType={objectType}
        {...(editor.attributeId === undefined ? {} : { attributeId: editor.attributeId })}
        open={editor.open}
        onOpenChange={(open) => {
          if (!open) setEditor((current) => ({ ...current, open: false }))
        }}
      />

      <DeleteAttributeDialog
        ids={deleteRequest.ids}
        open={deleteRequest.open}
        onOpenChange={(open) => {
          if (!open) setDeleteRequest((current) => ({ ...current, open: false }))
        }}
        isDeleting={deletion.isPending}
        onConfirm={(ids) => {
          setDeleteRequest((current) => ({ ...current, open: false }))
          deletion.mutate(ids)
        }}
      />
    </>
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
