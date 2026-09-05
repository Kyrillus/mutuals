import { listResponseSchema, SavedViewSchema } from '@mutuals/core'
import { createFileRoute, retainSearchParams, useNavigate } from '@tanstack/react-router'
import { Building2 } from 'lucide-react'

import { api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'

import { PageHeader } from '@/components/app-shell/page.tsx'
import { AddRecordButton } from '@/features/records/add-record-dialog.tsx'
import { RecordTable } from '@/features/records/record-table.tsx'
import { validateListSearch } from '@/hooks/use-list-query.ts'

/**
 * §6.3's default view.
 *
 * The whole of this page is a column list and an object type. That is the claim §5.2 makes — one
 * `DataTable`, driven by attribute definitions — and this file is what it costs to be right about
 * it: no second table, no second cell registry, no second filter bar.
 */
const DEFAULT_COLUMNS = [
  'name',
  'type',
  'industry',
  'city',
  'country',
  'people_count',
  'website',
  'created_at',
] as const

const DIALOG_FIELDS = ['type', 'industry', 'city', 'country', 'website'] as const

export const Route = createFileRoute('/organizations/')({
  component: OrganizationsPage,
  // ADR-047: filters, sort, columns and the view live in the URL, so a link is a view.
  validateSearch: validateListSearch,
  // ADR-048: `?view=` rides along with every later navigation, so the breadcrumb keeps the saved
  // view's name while the working copy drifts.
  search: { middlewares: [retainSearchParams(['view'])] },
  /**
   * §5.2 wants the open view's name in the breadcrumb — `Organizations › Investors in Munich`. It is a
   * second crumb rather than a rewrite of the first, which is why it lives on this route and not on
   * the layout above it. The list is already in the cache; this reads it rather than fetching.
   */
  loaderDeps: ({ search }) => ({ view: search.view }),
  loader: async ({ context, deps }) => {
    if (deps.view === undefined) return {}
    // `fetchQuery`, not `ensureQueryData`: a view saved a moment ago has just invalidated this
    // key, and the crumb must name it rather than the list from before it existed. `staleTime`
    // still keeps this from being a request per navigation.
    const views = await context.queryClient.fetchQuery({
      queryKey: qk.views('organization'),
      queryFn: () =>
        api
          .get(listResponseSchema(SavedViewSchema), '/views', {
            search: { objectType: 'organization' },
          })
          .then((response) => response.data),
      staleTime: 5 * 60_000,
    })
    const open = views.find((view) => view.id === deps.view)
    return open === undefined ? {} : { crumb: open.name }
  },
})

function OrganizationsPage() {
  const navigate = useNavigate()

  return (
    <>
      <PageHeader
        title="Organizations"
        description="The companies, funds and collectives the people you know belong to."
      />
      <RecordTable
        objectType="organization"
        defaultColumns={DEFAULT_COLUMNS}
        primaryAction={
          <AddRecordButton
            objectType="organization"
            label="organization"
            primaryColumns={DIALOG_FIELDS}
          />
        }
        emptyAction={
          <AddRecordButton
            objectType="organization"
            label="organization"
            primaryColumns={DIALOG_FIELDS}
          />
        }
        emptyIcon={Building2}
        onTableSettings={() => {
          void navigate({ to: '/settings/organizations/attributes' })
        }}
      />
    </>
  )
}
