import { createFileRoute } from '@tanstack/react-router'
import { CalendarClock } from 'lucide-react'

import { EmptyState, PageHeader } from '@/components/app-shell/page.tsx'
import { useStats } from '@/hooks/use-stats.ts'

export const Route = createFileRoute('/follow-ups')({
  component: FollowUpsPage,
  staticData: { crumb: 'Follow-ups' },
})

function FollowUpsPage() {
  const stats = useStats()

  return (
    <>
      <PageHeader title="Follow-ups" description="What you said you would do, and by when." />
      <EmptyState
        icon={CalendarClock}
        title="The follow-ups table arrives in Stage 4"
        description={
          stats.data
            ? `${String(stats.data.followUpsOverdue)} overdue and ${String(stats.data.followUpsDueThisWeek)} due this week are waiting. The status toggle, the quick filter tabs and recurrence are §6.4.`
            : 'The status toggle, the quick filter tabs and recurrence are §6.4.'
        }
      />
    </>
  )
}
