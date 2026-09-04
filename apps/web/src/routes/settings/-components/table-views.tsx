/**
 * The second card's destination. Saved views are Stage 4 (§6.6, ADR-048), so this page exists to
 * answer the question the chevron raised rather than to apologise for a missing screen — and the
 * answer is useful today, because ADR-047 already put the working copy of a view in the URL.
 */
import { Link } from '@tanstack/react-router'
import { TableProperties } from 'lucide-react'

import { EmptyState, PageHeader } from '@/components/app-shell/page.tsx'
import { Button } from '@/ui/button.tsx'

import type { SettingsObject } from './objects.ts'

export function TableViews({ object }: { object: SettingsObject }) {
  return (
    <>
      <PageHeader
        title="Table views"
        description={`Named column sets for the ${object.label} table.`}
      />

      <EmptyState
        icon={TableProperties}
        title="There are no saved views yet"
        description={`A view will be a name given to a set of columns, a filter and a sort order — what the breadcrumb reads as “${object.label} › Investors in Munich”. Until then the address bar is the view: filter the ${object.label} table, sort it, choose its columns, and the link carries all three.`}
      >
        <Button asChild variant="outline">
          <Link to={object.table}>Open the {object.label} table</Link>
        </Button>
      </EmptyState>
    </>
  )
}
