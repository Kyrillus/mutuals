import { createFileRoute } from '@tanstack/react-router'

import { ObjectSettings } from '../-components/object-settings.tsx'
import { ORGANIZATIONS_OBJECT } from '../-components/objects.ts'

export const Route = createFileRoute('/settings/organizations/')({
  component: () => <ObjectSettings object={ORGANIZATIONS_OBJECT} />,
})
