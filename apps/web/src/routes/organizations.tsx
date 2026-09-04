import { createFileRoute } from '@tanstack/react-router'
import { Building2 } from 'lucide-react'

import { EmptyState, PageHeader } from '@/components/app-shell/page.tsx'
import { useStats } from '@/hooks/use-stats.ts'

export const Route = createFileRoute('/organizations')({
  component: OrganizationsPage,
  staticData: { crumb: 'Organizations' },
})

function OrganizationsPage() {
  const stats = useStats()

  return (
    <>
      <PageHeader
        title="Organizations"
        description="The companies, funds and collectives the people you know belong to."
      />
      <EmptyState
        icon={Building2}
        title="The organizations table arrives in Stage 3"
        description={
          stats.data
            ? `${stats.data.totalOrganizations.toLocaleString('en-GB')} organizations are already in the database, each with its linked people (§6.3).`
            : 'Organizations, their linked people and the contact detail page are Stage 3 (§6.3).'
        }
      />
    </>
  )
}
