import { createFileRoute } from '@tanstack/react-router'

import { validateListSearch } from '@/hooks/use-list-query.ts'

import { AttributesPage } from '../-components/attributes-page.tsx'
import { CONTACTS_OBJECT } from '../-components/objects.ts'

export const Route = createFileRoute('/settings/contacts/attributes')({
  component: () => <AttributesPage object={CONTACTS_OBJECT} />,
  // ADR-047: the filter, the sort and the visible columns live in the URL here too, so a link to
  // "the select attributes, newest first" is a link like any other.
  validateSearch: validateListSearch,
  staticData: { crumb: 'Attributes' },
})
