/**
 * §6.6's object page: two cards, each with a live count and a chevron.
 *
 * **What the attributes count counts.** Every attribute definition this object has, system ones
 * included — the exact rows the table on the other side of the chevron will show, read from the
 * same cache entry. §6.6's example prints `14 attributes` and the seeded contact object has
 * fourteen definitions; the number and the table can therefore never disagree, which is the only
 * property that matters for a number you click on. The built-in *columns* — Name, Created, Warmth,
 * Last interaction — are not counted, because they are not attribute definitions: they cannot be
 * created, renamed or deleted, nothing on the page beyond the chevron could act on them, and they
 * are already offered where they are useful, in the Columns picker and the filter picker.
 */
import { PageHeader } from '@/components/app-shell/page.tsx'
import { useAttributeDefinitions } from '@/features/attributes-settings/list/attribute-api.ts'

import { Card, CardRow } from './cards.tsx'
import type { SettingsObject } from './objects.ts'

export function ObjectSettings({ object }: { object: SettingsObject }) {
  const definitions = useAttributeDefinitions(object.objectType)

  return (
    <>
      <PageHeader
        title={object.label}
        description={`What ${object.article} ${object.noun} can hold, and how the table shows it.`}
      />

      <Card>
        <CardRow
          title="Attributes"
          description={`The fields on ${object.article} ${object.noun}: what you can store, filter and sort by.`}
          count={attributeCount(definitions)}
          note={definitions.isError ? 'Could not be read' : undefined}
          to={`${object.to}/attributes`}
        />
        <CardRow
          title="Table views"
          description="Named column sets, each with its own filters and sort order."
          // No count, rather than a made-up one: saved views are seeded in the database but no
          // endpoint lists them yet, and a number nothing can produce is a number nobody should
          // trust. It appears here the day the API answers for it.
          count={undefined}
          note="Not built yet"
          to={`${object.to}/views`}
        />
      </Card>
    </>
  )
}

function attributeCount(
  query: ReturnType<typeof useAttributeDefinitions>,
): string | null | undefined {
  if (query.isPending) return null
  const total = query.data?.length
  if (total === undefined) return undefined
  return `${total.toLocaleString('en-GB')} ${total === 1 ? 'attribute' : 'attributes'}`
}
