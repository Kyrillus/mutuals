/**
 * §6.4's follow-ups page.
 *
 * A list with quick-filter tabs rather than the shared `DataTable`. §6.4 asks for a table, and this
 * is the one place the brief's own layout wins over reuse: a follow-up has no `attributes` map, so
 * every column would be a special case, the filter bar would have nothing to filter and the Columns
 * picker nothing to pick. The tabs are the filter model this object actually has. If follow-ups
 * ever grow custom attributes (§4.1 says design for it), this becomes a `RecordTable` and the tabs
 * become saved views.
 */
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { FollowUpState } from '@mutuals/core'

import { PageHeader } from '@/components/app-shell/page.tsx'
import { FollowUpDialog } from '@/features/follow-ups/follow-up-dialog.tsx'
import { FollowUpList } from '@/features/follow-ups/follow-up-list.tsx'
import { useFollowUps } from '@/features/follow-ups/use-follow-ups.ts'
import { Button } from '@/ui/button.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs.tsx'

export const Route = createFileRoute('/follow-ups')({
  component: FollowUpsPage,
  staticData: { crumb: 'Follow-ups' },
})

const TABS = [
  { value: 'open', label: 'Open', query: { status: 'Open' as const } },
  { value: 'overdue', label: 'Overdue', query: { state: 'overdue' as FollowUpState } },
  { value: 'done', label: 'Done', query: { status: 'Done' as const } },
  { value: 'all', label: 'All', query: {} },
]

function FollowUpsPage() {
  const [creating, setCreating] = useState(false)

  return (
    <>
      <PageHeader
        title="Follow-ups"
        description="What you owe people, and when."
        actions={
          <Button
            size="sm"
            onClick={() => {
              setCreating(true)
            }}
          >
            Create follow-up
          </Button>
        }
      />

      <Tabs defaultValue="open">
        <TabsList>
          {TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {TABS.map((tab) => (
          <TabsContent key={tab.value} value={tab.value}>
            <TabPanel
              query={tab.query}
              label={tab.label}
              onCreate={() => {
                setCreating(true)
              }}
            />
          </TabsContent>
        ))}
      </Tabs>

      <FollowUpDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}

function TabPanel({
  query,
  label,
  onCreate,
}: {
  query: Record<string, unknown>
  label: string
  onCreate: () => void
}) {
  const followUps = useFollowUps({ ...query, limit: 200 })

  return (
    <FollowUpList
      rows={followUps.data}
      pending={followUps.isPending}
      error={followUps.error}
      emptyTitle={
        label === 'Open' ? 'Nothing to follow up on' : `No ${label.toLowerCase()} follow-ups`
      }
      emptyDescription="A follow-up is a reminder attached to a person — send the deck, make the intro, check in after the round. Marking a repeating one done schedules the next automatically."
      emptyAction={
        <Button size="sm" onClick={onCreate}>
          Create follow-up
        </Button>
      }
    />
  )
}
