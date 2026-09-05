/**
 * §6.3's roster: who works at this organization.
 *
 * The page's own doc comment has claimed since Stage 3 that "the roster of people is a first-class
 * tab", and it was not — an organization with nobody in it had nowhere to say so, and the only
 * route to its people was a link into the contacts table, where an empty result reads as a filter
 * that matched nothing rather than as a company with no staff.
 *
 * **Nothing here names a field.** The link between a contact and an organization is a user-defined
 * `relation` attribute like any other, so the slug is resolved from the definitions — the one
 * contact attribute whose target object type is `organization`. A workspace that renamed it, or
 * that has two of them, still works; a workspace that deleted it renders the tab as absent rather
 * than as broken.
 */
import type { AttributeDefinitionDto, RelationValue } from '@mutuals/core'
import { Link } from '@tanstack/react-router'
import { UsersRound } from 'lucide-react'

import { relationConfigOf } from '@/attributes/value.ts'
import { EmptyState } from '@/components/app-shell/page.tsx'
import { useRecordList } from '@/features/records/use-record-list.ts'
import { Button } from '@/ui/button.tsx'
import { Skeleton } from '@/ui/skeleton.tsx'

/**
 * The slug of the contact attribute that points at an organization, or `null` when the workspace
 * has none. Exported because the header's "N people" link has to build the same filter, and two
 * places guessing the same slug is exactly how a renamed field breaks one of them.
 */
export function organizationRelationSlug(
  definitions: readonly AttributeDefinitionDto[] | undefined,
): string | null {
  const match = (definitions ?? []).find(
    (definition) =>
      definition.type === 'relation' &&
      relationConfigOf(definition).targetObjectType === 'organization',
  )
  return match?.slug ?? null
}

export function PeopleTab({
  organizationId,
  relationSlug,
}: {
  organizationId: string
  relationSlug: string | null
}) {
  const people = useRecordList('contact', {
    filter:
      relationSlug === null
        ? []
        : [{ field: relationSlug, op: 'has_any_of', values: [organizationId] }],
    sort: null,
    columns: null,
    q: null,
    view: null,
    limit: 100,
    cursor: null,
  })

  if (relationSlug === null) {
    return (
      <EmptyState
        icon={UsersRound}
        title="Contacts cannot be linked to an organization"
        description="This roster is built from the contact field that points at an organization, and this workspace has none. Create a relation field on Contacts that targets Organizations, and everyone linked through it will appear here."
      >
        <Button variant="outline" size="sm" asChild>
          <Link to="/settings/contacts/attributes">Open contact fields</Link>
        </Button>
      </EmptyState>
    )
  }

  if (people.query.isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }

  if (people.query.isError) {
    return <p className="text-destructive text-sm">{people.query.error.message}</p>
  }

  if (people.rows.length === 0) {
    return (
      <EmptyState
        icon={UsersRound}
        title="Nobody works here yet"
        description="Open a contact and set their organization to this one. Their job title and dates live on that link, so a person can move on without losing the history."
      >
        <Button variant="outline" size="sm" asChild>
          <Link to="/contacts">Go to Contacts</Link>
        </Button>
      </EmptyState>
    )
  }

  return (
    <ul className="flex flex-col">
      {people.rows.map((row) => {
        const link = linkTo(row.attributes[relationSlug], organizationId)
        return (
          <li key={row.id} className="flex items-baseline gap-3 border-b py-2 last:border-b-0">
            <Link
              to="/contacts/$id"
              params={{ id: row.id }}
              className="min-w-0 truncate text-sm font-medium hover:underline"
            >
              {row.displayName}
            </Link>
            {link?.title !== null && link?.title !== undefined && (
              <span className="text-muted-foreground min-w-0 truncate text-sm">{link.title}</span>
            )}
            {link?.isPrimary === true && (
              <span className="text-muted-foreground shrink-0 rounded border px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
                primary
              </span>
            )}
            {link?.to !== null && link?.to !== undefined && (
              <span className="text-muted-foreground ml-auto shrink-0 text-xs">past</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** The one element of the contact's relation that points back at this organization. */
function linkTo(value: unknown, organizationId: string): RelationValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as { type?: unknown; value?: unknown }
  if (entry.type !== 'relation' || !Array.isArray(entry.value)) return undefined
  return (entry.value as RelationValue[]).find((element) => element.id === organizationId)
}
