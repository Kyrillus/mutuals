import { createFileRoute, retainSearchParams, useNavigate } from '@tanstack/react-router'

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
  validateSearch: validateListSearch,
  search: { middlewares: [retainSearchParams(['view'])] },
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
        onTableSettings={() => {
          void navigate({ to: '/settings/organizations/attributes' })
        }}
      />
    </>
  )
}
