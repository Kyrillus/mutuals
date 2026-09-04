/**
 * One follow-up list, used in three places: §6.4's page, §6.1's "Needs your attention", and the
 * contact detail page's Follow-ups tab.
 *
 * `state` decides the colour and the icon and is never recomputed here — it arrives from the server,
 * derived against the profile's today, so the red on this row and the "overdue" count on the
 * dashboard cannot disagree at midnight (ADR-091).
 */
import { addDays, civil, type FollowUp } from '@mutuals/core'
import { Link } from '@tanstack/react-router'
import { CalendarClock, CircleCheck, Circle, Clock } from 'lucide-react'
import { useState } from 'react'

import { useDisplay } from '@/attributes/display-context.tsx'
import { formatCivilDate, formatRelativeDay } from '@/attributes/format.ts'
import { EmptyState } from '@/components/app-shell/page.tsx'
import { Button } from '@/ui/button.tsx'
import { ConfirmDialog } from '@/ui/confirm-dialog.tsx'
import { Skeleton } from '@/ui/skeleton.tsx'
import { cn } from '@/lib/utils.ts'

import { FollowUpDialog } from './follow-up-dialog.tsx'
import { recurrenceLabel } from './recurrence-label.ts'
import { useDeleteFollowUp, useUpdateFollowUp } from './use-follow-ups.ts'

export function FollowUpList({
  rows,
  pending,
  error,
  emptyTitle,
  emptyDescription,
  emptyAction,
  showContact = true,
  compact = false,
}: {
  rows: readonly FollowUp[] | undefined
  pending: boolean
  error: Error | null
  emptyTitle: string
  emptyDescription: string
  emptyAction?: React.ReactNode
  /** Off on a contact's own page, where every row would repeat the same name. */
  showContact?: boolean
  /** The dashboard's version: no edit or delete, just the checkbox and the link. */
  compact?: boolean
}) {
  const update = useUpdateFollowUp()
  const remove = useDeleteFollowUp()
  const { locale, today } = useDisplay()

  const [editing, setEditing] = useState<FollowUp | null>(null)
  const [deleting, setDeleting] = useState<FollowUp | null>(null)

  if (pending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }
  if (error !== null) return <p className="text-destructive text-sm">{error.message}</p>
  if (rows === undefined || rows.length === 0) {
    return (
      <EmptyState icon={CalendarClock} title={emptyTitle} description={emptyDescription}>
        {emptyAction}
      </EmptyState>
    )
  }

  return (
    <>
      <ul className="flex flex-col">
        {rows.map((row) => {
          const done = row.status === 'Done'
          const StatusIcon = done ? CircleCheck : row.status === 'Snoozed' ? Clock : Circle
          const repeats = recurrenceLabel(row.recurrence)

          return (
            <li
              key={row.id}
              className="group flex items-center gap-3 border-b py-2 text-sm last:border-b-0"
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={done}
                aria-label={`Mark ${row.title} ${done ? 'not done' : 'done'}`}
                className="text-muted-foreground hover:text-foreground shrink-0"
                onClick={() => {
                  update.mutate({ id: row.id, body: { status: done ? 'Open' : 'Done' } })
                }}
              >
                <StatusIcon className={cn('size-4', done && 'text-foreground')} />
              </button>

              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  done && 'text-muted-foreground line-through',
                )}
              >
                {row.title}
              </span>

              {showContact && (
                <Link
                  to="/contacts/$id"
                  params={{ id: row.contact.id }}
                  className="bg-accent shrink-0 rounded-full px-2 py-0.5 text-xs hover:underline"
                >
                  {row.contact.displayName}
                </Link>
              )}

              {repeats !== '' && (
                <span className="text-muted-foreground shrink-0 rounded border px-1.5 py-0.5 text-[10px]">
                  {repeats}
                </span>
              )}

              <span
                className={cn(
                  'shrink-0 text-xs',
                  row.state === 'overdue'
                    ? 'text-destructive font-medium'
                    : 'text-muted-foreground',
                )}
                title={formatCivilDate(row.dueAt, locale)}
              >
                {formatRelativeDay(civil(row.dueAt), today, locale)}
              </span>

              {!compact && (
                <span className="flex shrink-0 gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Snooze ${row.title} by a week`}
                    onClick={() => {
                      // A week from **today**, not from whatever it already said: a follow-up three
                      // weeks overdue that snoozes to two weeks overdue has not been snoozed.
                      update.mutate({
                        id: row.id,
                        body: { status: 'Snoozed', dueAt: addDays(today, 7) },
                      })
                    }}
                  >
                    Snooze
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Edit ${row.title}`}
                    onClick={() => {
                      setEditing(row)
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete ${row.title}`}
                    onClick={() => {
                      setDeleting(row)
                    }}
                  >
                    Delete
                  </Button>
                </span>
              )}
            </li>
          )
        })}
      </ul>

      <FollowUpDialog
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null)
        }}
        editing={editing}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
        title={`Delete "${deleting?.title ?? ''}"?`}
        description="The reminder is removed. If it repeats, no further occurrences are created. It cannot be undone."
        confirmLabel="Delete follow-up"
        onConfirm={() => {
          if (deleting !== null) remove.mutate({ id: deleting.id })
          setDeleting(null)
        }}
      />
    </>
  )
}
