/**
 * §6.5's Activities tab: every touchpoint with one record, newest first, grouped by month.
 *
 * Grouped by month rather than shown as a flat list because a timeline with forty rows and no
 * landmarks is a scroll, not a history. The month heading is derived from `occurredAt` in the
 * profile's timezone — which day an instant falls on is a timezone question, and getting it from
 * the string would put a late-evening call in the wrong month for half the year.
 */
import { civilIn, type Interaction, type InteractionType } from '@mutuals/core'
import {
  CalendarDays,
  Mail,
  MessageSquare,
  Mic,
  Phone,
  StickyNote,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'

import { useDisplay } from '@/attributes/display-context.tsx'
import { formatRelativeDay } from '@/attributes/format.ts'
import { EmptyState } from '@/components/app-shell/page.tsx'
import { Button } from '@/ui/button.tsx'
import { ConfirmDialog } from '@/ui/confirm-dialog.tsx'
import { Skeleton } from '@/ui/skeleton.tsx'

import { InteractionDialog } from './interaction-dialog.tsx'
import { useDeleteInteraction, useInteractions } from './use-interactions.ts'

const TYPE_ICON: Record<InteractionType, LucideIcon> = {
  Meeting: Users,
  Call: Phone,
  Email: Mail,
  Message: MessageSquare,
  Intro: Mic,
  Event: CalendarDays,
  Note: StickyNote,
}

export function InteractionTimeline({
  contactId,
  organizationId,
  limit,
}: {
  contactId?: string
  organizationId?: string
  /** Set on the Overview tab, where §6.5 asks for the three most recent and a "See all". */
  limit?: number
}) {
  const recordId = contactId ?? organizationId ?? ''
  const query = {
    ...(contactId ? { contactId } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(limit ? { limit } : {}),
  }
  const interactions = useInteractions(recordId, query)
  const remove = useDeleteInteraction(recordId)

  const [composing, setComposing] = useState(false)
  const [editing, setEditing] = useState<Interaction | null>(null)
  const [deleting, setDeleting] = useState<Interaction | null>(null)

  const { locale, timeZone, today } = useDisplay()

  if (interactions.isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }
  if (interactions.isError) {
    return <p className="text-destructive text-sm">{interactions.error.message}</p>
  }

  const rows = interactions.data
  const addButton = (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        setComposing(true)
      }}
    >
      New activity
    </Button>
  )

  if (rows.length === 0) {
    return (
      <>
        <EmptyState
          icon={CalendarDays}
          title="Nothing logged yet"
          description="Every meeting, call and email you record here feeds the warmth score and the last-interaction column. Log the first one."
        >
          {addButton}
        </EmptyState>
        <InteractionDialog
          open={composing}
          onOpenChange={setComposing}
          recordId={recordId}
          contactId={contactId}
          organizationId={organizationId}
        />
      </>
    )
  }

  // Month buckets, in the order the rows already arrive in (newest first).
  const months = new Map<string, Interaction[]>()
  for (const row of rows) {
    const civil = civilIn(timeZone, new Date(row.occurredAt))
    const key = civil.slice(0, 7)
    const list = months.get(key) ?? []
    list.push(row)
    months.set(key, list)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">{addButton}</div>

      {[...months].map(([month, group]) => (
        <section key={month}>
          <h4 className="text-muted-foreground mb-1 text-xs font-medium">
            {new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone }).format(
              new Date(`${month}-01T12:00:00Z`),
            )}
          </h4>
          <ul className="flex flex-col">
            {group.map((row) => {
              const Icon = TYPE_ICON[row.type]
              const civil = civilIn(timeZone, new Date(row.occurredAt))
              return (
                <li
                  key={row.id}
                  className="group flex items-start gap-3 border-b py-2 last:border-b-0"
                >
                  <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{row.title ?? row.type}</p>
                    {row.body !== null && row.body !== '' && (
                      <p className="text-muted-foreground mt-0.5 line-clamp-3 text-sm whitespace-pre-wrap">
                        {row.body}
                      </p>
                    )}
                    <p className="text-muted-foreground/70 mt-0.5 text-xs">
                      {row.type}
                      {row.source !== 'manual' && ` · ${row.source}`}
                      {row.contacts.length > 1 && ` · ${String(row.contacts.length)} people`}
                    </p>
                  </div>

                  <span className="text-muted-foreground shrink-0 text-xs">
                    {formatRelativeDay(civil, today, locale)}
                  </span>

                  <span className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit ${row.title ?? row.type}`}
                      onClick={() => {
                        setEditing(row)
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete ${row.title ?? row.type}`}
                      onClick={() => {
                        setDeleting(row)
                      }}
                    >
                      Delete
                    </Button>
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      <InteractionDialog
        open={composing}
        onOpenChange={setComposing}
        recordId={recordId}
        contactId={contactId}
        organizationId={organizationId}
      />

      <InteractionDialog
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null)
        }}
        recordId={recordId}
        contactId={contactId}
        organizationId={organizationId}
        editing={editing}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
        title="Delete this activity?"
        description="The interaction is removed and the warmth score recomputed. It cannot be undone."
        confirmLabel="Delete activity"
        onConfirm={() => {
          if (deleting !== null) remove.mutate({ id: deleting.id })
          setDeleting(null)
        }}
      />
    </div>
  )
}
