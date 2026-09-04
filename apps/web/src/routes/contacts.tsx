import { createFileRoute } from '@tanstack/react-router'
import { Users } from 'lucide-react'

import { EmptyState, PageHeader } from '@/components/app-shell/page.tsx'
import { useStats } from '@/hooks/use-stats.ts'

export const Route = createFileRoute('/contacts')({
  component: ContactsPage,
  staticData: { crumb: 'Contacts' },
})

function ContactsPage() {
  const stats = useStats()

  return (
    <>
      <PageHeader
        title="Contacts"
        description="Everyone you know, described by the fields you decide matter."
      />
      <EmptyState
        icon={Users}
        title="The contacts table arrives next"
        description={
          stats.data
            ? `${stats.data.totalContacts.toLocaleString('en-GB')} contacts are already in the database. The filter bar, the columns picker and inline editing (§5.2) are the next section of this stage.`
            : 'The filter bar, the columns picker and inline editing (§5.2) are the next section of this stage.'
        }
      />
    </>
  )
}
