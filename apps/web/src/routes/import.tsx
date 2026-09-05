/**
 * §6.8's import wizard, as a full page.
 *
 * A route of its own rather than a dialog: the Review grid is a spreadsheet and needs the width,
 * and an import that takes ten minutes should survive a click on something else and be findable
 * again — which a modal cannot offer.
 */
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { ImportWizard } from '@/features/import/wizard.tsx'

const SearchSchema = z.object({
  /** Preselected from wherever the user came from, per §6.8 step 1. */
  objectType: z.enum(['contact', 'organization']).default('contact'),
})

export const Route = createFileRoute('/import')({
  component: ImportPage,
  validateSearch: SearchSchema,
})

function ImportPage() {
  const { objectType } = Route.useSearch()
  return <ImportWizard initialObjectType={objectType} />
}
