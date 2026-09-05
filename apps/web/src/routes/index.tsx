import { addDays, civilIn } from '@mutuals/core'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Building2, CalendarClock, ChevronRight, History, Users } from 'lucide-react'

import { useDisplay } from '@/attributes/display-context.tsx'
import { formatRelativeDay } from '@/attributes/format.ts'
import { EmptyState, PageHeader, Section } from '@/components/app-shell/page.tsx'
import { AskPanel } from '@/features/ask/ask-panel.tsx'
import { FollowUpList } from '@/features/follow-ups/follow-up-list.tsx'
import { useFollowUps } from '@/features/follow-ups/use-follow-ups.ts'
import { useRecordList } from '@/features/records/use-record-list.ts'
import { useProfile } from '@/hooks/use-profile.ts'
import { useStats } from '@/hooks/use-stats.ts'
import { cn } from '@/lib/utils.ts'
import { Button } from '@/ui/button.tsx'
import { Skeleton } from '@/ui/skeleton.tsx'

export const Route = createFileRoute('/')({
  component: DashboardPage,
  staticData: { crumb: 'Dashboard' },
})

const QUICK_LINKS = [
  { to: '/contacts', label: 'Contacts', hint: 'Everyone you know', icon: Users },
  { to: '/organizations', label: 'Organizations', hint: 'Where they work', icon: Building2 },
  { to: '/follow-ups', label: 'Follow-ups', hint: 'What you owe people', icon: CalendarClock },
] as const

function DashboardPage() {
  const profile = useProfile()
  const stats = useStats()

  const counts: Record<string, number | undefined> = {
    '/contacts': stats.data?.totalContacts,
    '/organizations': stats.data?.totalOrganizations,
    '/follow-ups': stats.data?.followUpsDueThisWeek,
  }

  return (
    <>
      <PageHeader
        title={greeting(profile.data?.firstName)}
        description={stats.data ? formatToday(stats.data.today) : undefined}
      />

      {/*
        §6.1 puts this directly under the greeting and above the numbers: it is the most prominent
        thing on the page, which is what "a prominent single input" asks for.
      */}
      <Section title="Ask the network">
        <AskPanel />
      </Section>

      <Section title="Key numbers">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Contacts"
            value={stats.data?.totalContacts}
            failed={stats.isError}
            to="/contacts"
            search={{}}
          />
          <StatCard
            label="Added in 30 days"
            value={stats.data?.contactsAddedLast30Days}
            failed={stats.isError}
            to="/contacts"
            search={{ sort: 'created_at:desc' }}
          />
          <StatCard
            label="Due this week"
            value={stats.data?.followUpsDueThisWeek}
            failed={stats.isError}
            to="/follow-ups"
            search={{}}
          />
          <StatCard
            label="Overdue"
            value={stats.data?.followUpsOverdue}
            failed={stats.isError}
            to="/follow-ups"
            search={{}}
            emphasis={(stats.data?.followUpsOverdue ?? 0) > 0}
          />
        </div>
      </Section>

      <Section title="Quick links">
        <div className="grid gap-3 sm:grid-cols-3">
          {QUICK_LINKS.map((link) => {
            const Icon = link.icon
            const count = counts[link.to]
            return (
              <Link
                key={link.to}
                to={link.to}
                className="border-border bg-card hover:border-ring/50 group flex items-center gap-3 rounded-lg border p-4"
              >
                <span className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-md">
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{link.label}</span>
                  <span className="text-muted-foreground block text-xs">{link.hint}</span>
                </span>
                {count === undefined ? (
                  stats.isError ? (
                    <span className="text-muted-foreground text-sm">—</span>
                  ) : (
                    <Skeleton className="h-4 w-8" />
                  )
                ) : (
                  <span className="text-muted-foreground tabular text-sm">
                    {count.toLocaleString('en-GB')}
                  </span>
                )}
                <ChevronRight className="text-muted-foreground/60 size-4 shrink-0" />
              </Link>
            )
          })}
        </div>
      </Section>

      <Section title="Needs your attention">
        <AttentionList />
      </Section>

      <Section title="Recently interacted">
        <RecentlyInteracted />
      </Section>
    </>
  )
}

/**
 * §6.1's stat cards. Each one links to the view it is a count of, per the brief.
 *
 * `failed` exists because a skeleton is a promise that a number is on its way. With the API
 * stopped, every card on this page used to pulse for ever — the one screen in the product where
 * "still loading" and "never coming" looked identical.
 */
function StatCard({
  label,
  value,
  failed,
  to,
  search,
  emphasis = false,
}: {
  label: string
  value: number | undefined
  failed: boolean
  to: '/contacts' | '/follow-ups'
  search: Record<string, unknown>
  emphasis?: boolean
}) {
  return (
    <Link
      to={to}
      search={search}
      className="border-border bg-card hover:border-ring/50 flex flex-col gap-1 rounded-lg border p-4"
    >
      <span className="text-muted-foreground text-xs">{label}</span>
      {value === undefined ? (
        failed ? (
          <span className="text-muted-foreground text-2xl font-semibold" title="Not available">
            —
          </span>
        ) : (
          <Skeleton className="h-7 w-12" />
        )
      ) : (
        <span className={cn('text-2xl font-semibold tabular', emphasis && 'text-destructive')}>
          {value.toLocaleString('en-GB')}
        </span>
      )}
    </Link>
  )
}

/**
 * §6.1's attention list: overdue first, then the next seven days.
 *
 * Two queries rather than one, because "overdue" and "upcoming" are two of the server's derived
 * states and asking for both in one call would mean asking for all open follow-ups and filtering
 * here — which is exactly the recomputation of `state` that ADR-091 rules out.
 */
function AttentionList() {
  const { today } = useDisplay()
  const overdue = useFollowUps({ state: 'overdue', limit: 50 })
  const upcoming = useFollowUps({ status: 'Open', dueBefore: addDays(today, 7), limit: 50 })

  const seen = new Set<string>()
  const rows = [...(overdue.data ?? []), ...(upcoming.data ?? [])].filter((row) => {
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })

  return (
    <FollowUpList
      rows={overdue.isPending || upcoming.isPending ? undefined : rows}
      pending={overdue.isPending || upcoming.isPending}
      error={overdue.error ?? upcoming.error}
      compact
      emptyTitle="Nothing needs you this week"
      emptyDescription="Overdue follow-ups and anything due in the next seven days show up here."
    />
  )
}

/** §6.1's "last 10 contacts by interaction date". */
function RecentlyInteracted() {
  const recent = useRecordList('contact', {
    filter: [],
    sort: { field: 'last_interaction_at', direction: 'desc' },
    columns: null,
    q: null,
    view: null,
    limit: 10,
    cursor: null,
  })

  if (recent.query.isPending) return <Skeleton className="h-32 w-full" />
  // Before the empty state, because a list that failed to load also has no rows — and telling
  // somebody with 200 contacts that they have none is worse than telling them nothing.
  if (recent.query.isError) {
    return <p className="text-destructive text-sm">{recent.query.error.message}</p>
  }
  // A contact with nothing logged still appears here, dated "—", so this list is only ever empty
  // because the workspace has no contacts at all. That is what the message says.
  if (recent.rows.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="Nobody here yet"
        description="The ten people you spoke to most recently show up here, newest first. Add someone, then log what you talked about."
      >
        <Button variant="outline" size="sm" asChild>
          <Link to="/contacts">Add your first contact</Link>
        </Button>
      </EmptyState>
    )
  }

  return (
    <ul className="flex flex-col">
      {recent.rows.map((row) => (
        <li key={row.id} className="flex items-center gap-3 border-b py-2 text-sm last:border-b-0">
          <Link
            to="/contacts/$id"
            params={{ id: row.id }}
            className="min-w-0 flex-1 truncate font-medium hover:underline"
          >
            {row.displayName}
          </Link>
          <LastInteraction value={(row as { lastInteractionAt?: unknown }).lastInteractionAt} />
        </li>
      ))}
    </ul>
  )
}

function LastInteraction({ value }: { value: unknown }) {
  const { today, locale, timeZone } = useDisplay()
  if (typeof value !== 'string') return <span className="text-muted-foreground text-xs">—</span>
  return (
    <span className="text-muted-foreground shrink-0 text-xs">
      {formatRelativeDay(civilIn(timeZone, new Date(value)), today, locale)}
    </span>
  )
}

/**
 * Presentation, not domain logic: the counts come from the API against the profile's timezone,
 * while whether it is morning where the reader is sitting is only ever the reader's own clock.
 */
function timeOfDayGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/**
 * §6.1 greets by first name — and a fresh workspace has no profile row filled in, which is the
 * state the very first person to open this app is in. Interpolating an empty string leaves a
 * trailing comma addressed to nobody, so the comma belongs to the name and not to the greeting.
 */
function greeting(firstName: string | undefined): string {
  const name = firstName?.trim() ?? ''
  return name === '' ? timeOfDayGreeting() : `${timeOfDayGreeting()}, ${name}`
}

function formatToday(civilDate: string): string {
  const [year, month, day] = civilDate.split('-').map(Number)
  if (year === undefined || month === undefined || day === undefined) return civilDate
  return new Date(year, month - 1, day).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}
