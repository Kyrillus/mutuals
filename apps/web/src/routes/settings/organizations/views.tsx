import { createFileRoute } from '@tanstack/react-router'

import { ORGANIZATIONS_OBJECT } from '../-components/objects.ts'
import { TableViews } from '../-components/table-views.tsx'

export const Route = createFileRoute('/settings/organizations/views')({
  component: () => <TableViews object={ORGANIZATIONS_OBJECT} />,
  staticData: { crumb: 'Table views' },
})
