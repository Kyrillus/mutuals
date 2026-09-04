/**
 * §6.6's Table views screen.
 *
 * Renaming, reordering by default-ness, and deleting. It deliberately cannot *edit* a view's
 * filters or columns: ADR-048 makes the table the only place a snapshot is composed, and a second
 * editor here would be a second definition of what a view is.
 */
import type { ObjectType, SavedView } from '@mutuals/core'
import { Link } from '@tanstack/react-router'
import { Star, TableProperties } from 'lucide-react'
import { useState } from 'react'

import { EmptyState, PageHeader } from '@/components/app-shell/page.tsx'
import { useDeleteView, useUpdateView, useViews } from '@/features/views/use-views.ts'
import { Button } from '@/ui/button.tsx'
import { ConfirmDialog } from '@/ui/confirm-dialog.tsx'
import { Input } from '@/ui/input.tsx'
import { Skeleton } from '@/ui/skeleton.tsx'
import { cn } from '@/lib/utils.ts'

import type { SettingsObject } from './objects.ts'

export function TableViews({ object }: { object: SettingsObject }) {
  const objectType = object.objectType as ObjectType
  const views = useViews(objectType)
  const update = useUpdateView(objectType)
  const remove = useDeleteView(objectType)

  const [renaming, setRenaming] = useState<SavedView | null>(null)
  const [draft, setDraft] = useState('')
  const [deleting, setDeleting] = useState<SavedView | null>(null)

  return (
    <>
      <PageHeader
        title="Table views"
        description={`Named column sets, filters and sort orders for the ${object.label} table.`}
      />

      {views.isPending && <Skeleton className="h-32 w-full" />}

      {views.data?.length === 0 && (
        <EmptyState
          icon={TableProperties}
          title="No saved views yet"
          description={`Filter and sort the ${object.label} table however you like, then choose “Save as new view” from its ⋮ menu. Until then the address bar is the view — the link carries the filters, the sort and the columns.`}
        >
          <Button asChild variant="outline">
            <Link to={object.table}>Open the {object.label} table</Link>
          </Button>
        </EmptyState>
      )}

      {views.data !== undefined && views.data.length > 0 && (
        <ul className="flex flex-col">
          {views.data.map((view) => (
            <li
              key={view.id}
              className="group flex items-center gap-3 border-b py-2 last:border-b-0"
            >
              <button
                type="button"
                aria-label={
                  view.isDefault
                    ? `${view.name} is the default view`
                    : `Make ${view.name} the default`
                }
                disabled={view.isDefault}
                onClick={() => {
                  update.mutate({ id: view.id, body: { isDefault: true } })
                }}
                className={cn(
                  'shrink-0',
                  view.isDefault
                    ? 'text-foreground'
                    : 'text-muted-foreground/40 hover:text-foreground',
                )}
              >
                <Star className={cn('size-4', view.isDefault && 'fill-current')} />
              </button>

              {renaming?.id === view.id ? (
                <Input
                  value={draft}
                  autoFocus
                  aria-label={`Rename ${view.name}`}
                  className="h-8 max-w-64"
                  onChange={(event) => {
                    setDraft(event.target.value)
                  }}
                  onBlur={() => {
                    setRenaming(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setRenaming(null)
                    if (event.key === 'Enter' && draft.trim() !== '') {
                      update.mutate({ id: view.id, body: { name: draft.trim() } })
                      setRenaming(null)
                    }
                  }}
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{view.name}</span>
              )}

              <span className="text-muted-foreground shrink-0 text-xs">
                {view.filters.length === 0
                  ? 'no filters'
                  : `${String(view.filters.length)} filter${view.filters.length === 1 ? '' : 's'}`}
                {' · '}
                {view.columns.length} columns
              </span>

              <span className="flex shrink-0 gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <Button asChild variant="ghost" size="sm">
                  <Link to={object.table} search={{ view: view.id }}>
                    Open
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Rename ${view.name}`}
                  onClick={() => {
                    setRenaming(view)
                    setDraft(view.name)
                  }}
                >
                  Rename
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete ${view.name}`}
                  onClick={() => {
                    setDeleting(view)
                  }}
                >
                  Delete
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
        title={`Delete "${deleting?.name ?? ''}"?`}
        description="The view is removed. The records it showed are untouched — a view is only a saved way of looking at them."
        confirmLabel="Delete view"
        onConfirm={() => {
          if (deleting !== null) remove.mutate({ id: deleting.id, name: deleting.name })
          setDeleting(null)
        }}
      />
    </>
  )
}
