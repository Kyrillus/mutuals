import { createFileRoute } from '@tanstack/react-router'

import { validateListSearch } from '@/hooks/use-list-query.ts'

import { AttributesPage } from '../-components/attributes-page.tsx'
import { ORGANIZATIONS_OBJECT } from '../-components/objects.ts'

export const Route = createFileRoute('/settings/organizations/attributes')({
  component: () => <AttributesPage object={ORGANIZATIONS_OBJECT} />,
  validateSearch: validateListSearch,
  staticData: { crumb: 'Attributes' },
})
