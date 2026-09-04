import { createFileRoute, Link } from '@tanstack/react-router'
import { Building2, CalendarClock, ChevronRight, Sparkles, Users } from 'lucide-react'

import { PageHeader, Section } from '@/components/app-shell/page.tsx'
import { useProfile } from '@/hooks/use-profile.ts'
import { useStats } from '@/hooks/use-stats.ts'
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
        title={`${timeOfDayGreeting()}${profile.data ? `, ${profile.data.firstName}` : ''}`}
        description={stats.data ? formatToday(stats.data.today) : undefined}
      />

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
                  <Skeleton className="h-4 w-8" />
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

      <Section title="Still to come">
        <div className="border-border text-muted-foreground rounded-lg border border-dashed p-5 text-sm">
          <p className="text-foreground mb-2 flex items-center gap-2 font-medium">
            <Sparkles className="size-4" />
            This dashboard fills in as the stages land
          </p>
          <p>
            Ask the network, the four stat cards, &ldquo;Needs your attention&rdquo; and the
            recently interacted list all belong here (§6.1). The shell, the navigation and the data
            layer they sit on are what exists today.
          </p>
        </div>
      </Section>
    </>
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

function formatToday(civilDate: string): string {
  const [year, month, day] = civilDate.split('-').map(Number)
  if (year === undefined || month === undefined || day === undefined) return civilDate
  return new Date(year, month - 1, day).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}
