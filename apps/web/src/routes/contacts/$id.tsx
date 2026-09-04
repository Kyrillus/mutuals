/**
 * §6.5's contact detail page.
 *
 * Four tabs and a right-hand column of every field the contact can hold. Nothing on this page names
 * a user-facing field: the sidebar walks the resolver's field list, the Connections tab walks
 * `record_link`, and the Overview's relationship card reads the derived columns of §4.7.
 *
 * The Summary card of §6.5 is deliberately a stub — it is LLM-generated and that is Stage 6. It
 * says so on the card rather than being absent, because an empty slot reads as a bug.
 */
import { civilIn, ContactSchema, type Contact } from '@mutuals/core'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import { DisplayProvider, useDisplay } from '@/attributes/display-context.tsx'
import { formatRelativeDay, mailtoHref, phoneHref } from '@/attributes/format.ts'
import { Section } from '@/components/app-shell/page.tsx'
import { ConfirmDialog } from '@/ui/confirm-dialog.tsx'
import { AttributeSidebar } from '@/features/records/detail/attribute-sidebar.tsx'
import { ConnectionsTab } from '@/features/records/detail/connections-tab.tsx'
import { RecordHeader } from '@/features/records/detail/record-header.tsx'
import { InteractionTimeline } from '@/features/interactions/interaction-timeline.tsx'
import { useAttributeDefinitions } from '@/features/records/use-attribute-definitions.ts'
import { useContact } from '@/features/records/use-record.ts'
import { useDeleteRecords } from '@/features/records/use-record-mutations.ts'
import { useRecordEdit } from '@/features/records/use-record-edit.ts'
import { qk } from '@/lib/query.ts'
import { api } from '@/lib/api.ts'

import { recordFieldResolver } from '@/table/fields.ts'
import { Skeleton } from '@/ui/skeleton.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs.tsx'

export const Route = createFileRoute('/contacts/$id')({
  component: ContactDetailPage,
  /**
   * The loader exists for the breadcrumb, which needs the contact's name before the component
   * renders. It prefetches into the same cache `useRecord` reads, so the page does not fetch twice.
   */
  loader: async ({ context, params }) => {
    const record = await context.queryClient.ensureQueryData({
      queryKey: qk.record(params.id),
      queryFn: () => api.get(ContactSchema, `/contacts/${params.id}`),
    })
    return { crumb: record.displayName }
  },
})

function ContactDetailPage() {
  const { id } = Route.useParams()
  const navigate = useNavigate()

  const record = useContact(id)
  const definitions = useAttributeDefinitions('contact')
  const editor = useRecordEdit('contact')
  const remove = useDeleteRecords('contact')
  const [confirming, setConfirming] = useState(false)

  const bySlug = useMemo(
    () => new Map((definitions.data ?? []).map((definition) => [definition.slug, definition])),
    [definitions.data],
  )
  const fields = useMemo(
    () => recordFieldResolver('contact', definitions.data ?? []).list(),
    [definitions.data],
  )

  if (record.isPending || definitions.isPending) return <DetailSkeleton />
  if (record.isError) {
    return <p className="text-destructive text-sm">{record.error.message}</p>
  }

  const row = record.data

  return (
    <DisplayProvider>
      <div className="flex items-start gap-10">
        <div className="min-w-0 flex-1">
          <RecordHeader
            displayName={row.displayName}
            provenance={row.provenance}
            context={<ContactContext row={row} />}
            onDelete={() => {
              setConfirming(true)
            }}
          />

          <Tabs defaultValue="overview" className="mt-6">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="activities">Activities</TabsTrigger>
              <TabsTrigger value="connections">Connections</TabsTrigger>
              <TabsTrigger value="follow-ups">Follow-ups</TabsTrigger>
            </TabsList>

            <TabsContent value="overview">
              <div className="flex flex-col gap-8">
                <Highlights row={row} />
                <Section title="Activities">
                  <InteractionTimeline contactId={id} limit={3} />
                </Section>
              </div>
            </TabsContent>

            <TabsContent value="activities">
              <InteractionTimeline contactId={id} />
            </TabsContent>

            <TabsContent value="connections">
              <ConnectionsTab contactId={id} />
            </TabsContent>

            <TabsContent value="follow-ups">
              <p className="text-muted-foreground text-sm">
                Follow-ups arrive in Stage 4 (§6.4). This contact has {String(row.openFollowups)}{' '}
                open.
              </p>
            </TabsContent>
          </Tabs>
        </div>

        <AttributeSidebar
          row={row}
          objectType="contact"
          fields={fields}
          definitions={bySlug}
          editor={editor}
        />
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${row.displayName}?`}
        description="This will delete the contact and everything attached to them — interactions, follow-ups and the value history behind every field. It cannot be undone."
        confirmLabel="Delete contact"
        onConfirm={() => {
          remove.mutate([id], {
            onSuccess: () => {
              void navigate({ to: '/contacts' })
            },
          })
        }}
      />
    </DisplayProvider>
  )
}

/** §6.5's one line of context: primary organization and title, city, the ways to reach them. */
function ContactContext({ row }: { row: Contact }) {
  const organization = row.attributes['organization']
  const primary =
    organization?.type === 'relation'
      ? (organization.value.find((link) => link.isPrimary) ?? organization.value[0])
      : undefined
  const city = row.attributes['city']
  const email = row.attributes['email']
  const phone = row.attributes['phone']

  return (
    <>
      {primary !== undefined && (
        <span>
          <Link to="/organizations/$id" params={{ id: primary.id }} className="hover:underline">
            {primary.label}
          </Link>
          {primary.title !== null && ` · ${primary.title}`}
        </span>
      )}
      {city?.type === 'short_text' && <span>{city.value}</span>}
      {email?.type === 'email' && (
        <a href={mailtoHref(email.value)} className="hover:underline">
          {email.value}
        </a>
      )}
      {phone?.type === 'phone' && (
        <a href={phoneHref(phone.value) ?? '#'} className="hover:underline">
          {phone.value}
        </a>
      )}
    </>
  )
}

/** §6.5's Highlights row: the Summary stub, and the relationship numbers that are real today. */
function Highlights({ row }: { row: Contact }) {
  const { today, locale, timeZone } = useDisplay()
  // The instant is a point in time; "3 weeks ago" is a count of civil days, and which day an
  // instant falls on depends on the timezone. `civilIn` is the only thing that bridges the two.
  const last =
    row.lastInteractionAt === null ? null : civilIn(timeZone, new Date(row.lastInteractionAt))

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <article className="rounded-lg border p-4">
        <h3 className="mb-1 text-sm font-medium">Summary</h3>
        <p className="text-muted-foreground text-sm">
          A two-sentence summary of who this person is and what they need, written on demand. It
          arrives with the LLM layer in Stage 6 (§6.5).
        </p>
      </article>

      <article className="rounded-lg border p-4">
        <h3 className="mb-2 text-sm font-medium">Relationship</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Last interaction</dt>
          <dd>{last === null ? '—' : formatRelativeDay(last, today, locale)}</dd>
          <dt className="text-muted-foreground">Interactions (12m)</dt>
          <dd>{String(row.interactionCount12m)}</dd>
          <dt className="text-muted-foreground">Open follow-ups</dt>
          <dd>{String(row.openFollowups)}</dd>
          <dt className="text-muted-foreground">Warmth</dt>
          <dd>{String(row.warmth)}</dd>
        </dl>
      </article>
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="flex items-start gap-10">
      <div className="min-w-0 flex-1 space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-4 w-80" />
        <Skeleton className="h-40 w-full" />
      </div>
      <div className="w-80 space-y-2">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-6 w-full" />
        ))}
      </div>
    </div>
  )
}
