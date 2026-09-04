/**
 * §6.7's page: a heading, and the one DataTable pointed at the attribute definitions.
 *
 * The heading lives here rather than in the feature for the same reason it does on Contacts — the
 * shell owns page furniture, and a feature that renders its own `<h1>` cannot be put in a dialog
 * or a sidebar later.
 */
import { PageHeader } from '@/components/app-shell/page.tsx'
import { AttributesTable } from '@/features/attributes-settings/list/attributes-table.tsx'

import type { SettingsObject } from './objects.ts'

export function AttributesPage({ object }: { object: SettingsObject }) {
  return (
    <>
      <PageHeader
        title="Attributes"
        description={`Every field ${object.article} ${object.noun} can hold. Add one and it is a real column — filterable, sortable, on the table — with no deploy and no migration.`}
      />
      <AttributesTable objectType={object.objectType} />
    </>
  )
}
