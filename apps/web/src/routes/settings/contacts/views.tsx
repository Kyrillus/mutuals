import { createFileRoute } from '@tanstack/react-router'

import { CONTACTS_OBJECT } from '../-components/objects.ts'
import { TableViews } from '../-components/table-views.tsx'

export const Route = createFileRoute('/settings/contacts/views')({
  component: () => <TableViews object={CONTACTS_OBJECT} />,
  staticData: { crumb: 'Table views' },
})
