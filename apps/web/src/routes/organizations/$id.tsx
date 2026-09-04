/**
 * §6.3's organization detail page.
 *
 * The same three parts as the contact page — header, tabs, "All information" sidebar — assembled
 * from the same components. What differs is the context line and that the roster of people is a
 * first-class tab rather than a section of Connections, because on an organization that list *is*
 * the point.
 */
import { OrganizationSchema } from '@mutuals/core'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import { DisplayProvider } from '@/attributes/display-context.tsx'
import { prettyUrl } from '@/attributes/format.ts'
import { InteractionTimeline } from '@/features/interactions/interaction-timeline.tsx'
import { AttributeSidebar } from '@/features/records/detail/attribute-sidebar.tsx'
import { RecordHeader } from '@/features/records/detail/record-header.tsx'
import { useAttributeDefinitions } from '@/features/records/use-attribute-definitions.ts'
import { useOrganization } from '@/features/records/use-record.ts'
import { useDeleteRecords } from '@/features/records/use-record-mutations.ts'
import { useRecordEdit } from '@/features/records/use-record-edit.ts'
import { api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'
import { recordFieldResolver } from '@/table/fields.ts'
import { ConfirmDialog } from '@/ui/confirm-dialog.tsx'
import { Skeleton } from '@/ui/skeleton.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs.tsx'

export const Route = createFileRoute('/organizations/$id')({
  component: OrganizationDetailPage,
  loader: async ({ context, params }) => {
    const record = await context.queryClient.ensureQueryData({
      queryKey: qk.record(params.id),
      queryFn: () => api.get(OrganizationSchema, `/organizations/${params.id}`),
    })
    return { crumb: record.displayName }
  },
})

function OrganizationDetailPage() {
  const { id } = Route.useParams()
  const navigate = useNavigate()

  const record = useOrganization(id)
  const definitions = useAttributeDefinitions('organization')
  const editor = useRecordEdit('organization')
  const remove = useDeleteRecords('organization')
  const [confirming, setConfirming] = useState(false)

  const bySlug = useMemo(
    () => new Map((definitions.data ?? []).map((definition) => [definition.slug, definition])),
    [definitions.data],
  )
  const fields = useMemo(
    () => recordFieldResolver('organization', definitions.data ?? []).list(),
    [definitions.data],
  )

  if (record.isPending || definitions.isPending) {
    return <Skeleton className="h-64 w-full" />
  }
  if (record.isError) return <p className="text-destructive text-sm">{record.error.message}</p>

  const row = record.data
  const website = row.attributes['website']
  const city = row.attributes['city']
  const people = row.peopleCount

  return (
    <DisplayProvider>
      <div className="flex items-start gap-10">
        <div className="min-w-0 flex-1">
          <RecordHeader
            displayName={row.displayName}
            provenance={row.provenance}
            onDelete={() => {
              setConfirming(true)
            }}
            context={
              <>
                {city?.type === 'short_text' && <span>{city.value}</span>}
                {website?.type === 'url' && (
                  <a
                    href={website.value}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="hover:underline"
                  >
                    {prettyUrl(website.value)}
                  </a>
                )}
                {/* Clicks through to the contacts table filtered to this organization (§6.3). */}
                <Link
                  to="/contacts"
                  search={{
                    filter: [{ field: 'organization', op: 'has_any_of', values: [id] }],
                  }}
                  className="hover:underline"
                >
                  {people === 1 ? '1 person' : `${String(people)} people`}
                </Link>
              </>
            }
          />

          <Tabs defaultValue="overview" className="mt-6">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="activities">Activities</TabsTrigger>
            </TabsList>

            <TabsContent value="overview">
              <InteractionTimeline organizationId={id} limit={3} />
            </TabsContent>

            <TabsContent value="activities">
              <InteractionTimeline organizationId={id} />
            </TabsContent>
          </Tabs>
        </div>

        <AttributeSidebar
          row={row}
          objectType="organization"
          fields={fields}
          definitions={bySlug}
          editor={editor}
        />
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${row.displayName}?`}
        description={`This will delete the organization and unlink the ${String(people)} ${people === 1 ? 'person' : 'people'} attached to it. The contacts themselves are kept. It cannot be undone.`}
        confirmLabel="Delete organization"
        onConfirm={() => {
          remove.mutate([id], {
            onSuccess: () => {
              void navigate({ to: '/organizations' })
            },
          })
        }}
      />
    </DisplayProvider>
  )
}
