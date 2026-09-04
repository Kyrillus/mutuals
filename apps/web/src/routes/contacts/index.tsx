import { createFileRoute, retainSearchParams, useNavigate } from '@tanstack/react-router'

import { AddRecordButton } from '@/features/records/add-record-dialog.tsx'
import { RecordTable } from '@/features/records/record-table.tsx'
import { PageHeader } from '@/components/app-shell/page.tsx'
import { validateListSearch } from '@/hooks/use-list-query.ts'

/**
 * §6.2's default view.
 *
 * A page-level default, not a column definition: the table reads `FieldDescriptor[]` and would
 * render this page with none of these slugs present. In Stage 4 it becomes the seeded
 * `All contacts` saved view (§6.6) and this constant is deleted.
 */
const DEFAULT_COLUMNS = [
  'display_name',
  'email',
  'phone',
  'organization',
  'job_role',
  'city',
  'areas_of_interest',
  'last_interaction_at',
  'created_at',
] as const

/** §6.2's create dialog, which names a shorter list than the default view does. */
const DIALOG_FIELDS = ['email', 'phone', 'organization', 'job_role', 'city'] as const

export const Route = createFileRoute('/contacts/')({
  component: ContactsPage,
  // ADR-047: filters, sort, columns and the view live in the URL, so a link is a view.
  validateSearch: validateListSearch,
  // ADR-048: `?view=` rides along with every later navigation, so the breadcrumb keeps the saved
  // view's name while the working copy drifts. Inline rather than the shared constant so the
  // middleware's schema is inferred from this route's own search type.
  search: { middlewares: [retainSearchParams(['view'])] },
})

function ContactsPage() {
  const navigate = useNavigate()

  return (
    <>
      <PageHeader
        title="Contacts"
        description="Everyone you know, described by the fields you decide matter."
      />
      <RecordTable
        objectType="contact"
        defaultColumns={DEFAULT_COLUMNS}
        primaryAction={
          <AddRecordButton objectType="contact" label="contact" primaryColumns={DIALOG_FIELDS} />
        }
        emptyAction={
          <AddRecordButton objectType="contact" label="contact" primaryColumns={DIALOG_FIELDS} />
        }
        onTableSettings={() => {
          void navigate({ to: '/settings' })
        }}
      />
    </>
  )
}
