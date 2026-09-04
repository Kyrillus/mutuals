import { createFileRoute, Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { PageHeader, Section } from '@/components/app-shell/page.tsx'
import { useProfile } from '@/hooks/use-profile.ts'
import { useStats } from '@/hooks/use-stats.ts'

export const Route = createFileRoute('/settings/')({
  component: SettingsIndexPage,
})

function SettingsIndexPage() {
  const profile = useProfile()
  const stats = useStats()

  return (
    <>
      <PageHeader title="Settings" description="Your profile, and how each object is described." />

      <Section title="Account">
        <Card>
          <Row
            title="Profile"
            description="Name, email and the language the app speaks."
            meta={profile.data ? `${profile.data.firstName} ${profile.data.lastName}` : null}
            to="/settings/profile"
          />
        </Card>
      </Section>

      <Section title="Objects">
        <Card>
          <Row
            title="Contacts"
            description="Attributes and table views for people (§6.6, §6.7)."
            meta={stats.data ? `${stats.data.totalContacts.toLocaleString('en-GB')} records` : null}
          />
          <Row
            title="Organizations"
            description="Attributes and table views for organizations."
            meta={
              stats.data ? `${stats.data.totalOrganizations.toLocaleString('en-GB')} records` : null
            }
          />
        </Card>
      </Section>
    </>
  )
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="border-border divide-border bg-card divide-y overflow-hidden rounded-lg border">
      {children}
    </div>
  )
}

function Row({
  title,
  description,
  meta,
  to,
}: {
  title: string
  description: string
  meta: string | null
  /** Absent while the destination is still a later section: the row stays, the affordance goes. */
  to?: string
}) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="text-muted-foreground block text-xs">{description}</span>
      </span>
      <span className="text-muted-foreground shrink-0 text-xs">{meta ?? ''}</span>
      {to !== undefined && <ChevronRight className="text-muted-foreground/60 size-4 shrink-0" />}
    </>
  )

  if (to === undefined) {
    return <div className="flex items-center gap-4 px-4 py-3.5 opacity-60">{body}</div>
  }

  return (
    <Link to={to} className="hover:bg-muted/60 flex items-center gap-4 px-4 py-3.5">
      {body}
    </Link>
  )
}
