/**
 * §6.5's Connections tab, and the first screen in the product that reads `record_link` directly.
 *
 * Three lists, all from one operation (`GET /contacts/:id/connections`) rather than three the UI
 * would have to sequence:
 *
 *  1. **Organizations** — current before past, so it reads as a CV. The link carries the job title
 *     and its dates (§4.3), which is the whole reason a relation is a row and not a foreign key.
 *  2. **People** — contact↔contact links, grouped by the attribute that made them, so "Introduced
 *     by" and "Knows" are sections rather than a flat list with a type column.
 *  3. **Also at the same organization** — derived, read-only, and the one thing here nobody typed.
 */
import { Link } from '@tanstack/react-router'
import { Building2, UsersRound } from 'lucide-react'

import { useDisplay } from '@/attributes/display-context.tsx'
import { formatCivilDate } from '@/attributes/format.ts'
import { EmptyState } from '@/components/app-shell/page.tsx'
import { useConnections } from '@/features/records/use-record.ts'
import { Skeleton } from '@/ui/skeleton.tsx'

export function ConnectionsTab({ contactId }: { contactId: string }) {
  const connections = useConnections(contactId)
  const { locale } = useDisplay()

  if (connections.isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }
  if (connections.isError) {
    return <p className="text-destructive text-sm">{connections.error.message}</p>
  }

  const { organizations, people, alsoAtSameOrganization } = connections.data
  const empty =
    organizations.length === 0 && people.length === 0 && alsoAtSameOrganization.length === 0

  if (empty) {
    return (
      <EmptyState
        icon={UsersRound}
        title="No connections yet"
        description="Link this contact to an organization from the sidebar and their work history will build itself here — current role first, previous roles below."
      />
    )
  }

  const byAttribute = new Map<string, typeof people>()
  for (const person of people) {
    const list = byAttribute.get(person.attributeTitle) ?? []
    list.push(person)
    byAttribute.set(person.attributeTitle, list)
  }

  return (
    <div className="flex flex-col gap-8">
      {organizations.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium">Organizations</h3>
          <ul className="flex flex-col">
            {organizations.map((organization) => (
              <li
                key={`${organization.id}-${organization.from ?? ''}`}
                className="flex items-baseline gap-3 border-b py-2 last:border-b-0"
              >
                <Building2 className="text-muted-foreground size-4 shrink-0 self-center" />
                <Link
                  to="/organizations/$id"
                  params={{ id: organization.id }}
                  className="font-medium hover:underline"
                >
                  {organization.displayName}
                </Link>
                {organization.title !== null && (
                  <span className="text-muted-foreground text-sm">{organization.title}</span>
                )}
                {organization.isPrimary && (
                  <span className="text-muted-foreground rounded border px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
                    primary
                  </span>
                )}
                <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                  {organization.from === null ? '' : formatCivilDate(organization.from, locale)}
                  {' – '}
                  {organization.to === null ? 'now' : formatCivilDate(organization.to, locale)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {[...byAttribute].map(([title, group]) => (
        <section key={title}>
          <h3 className="mb-2 text-sm font-medium">{title}</h3>
          <ul className="flex flex-col">
            {group.map((person) => (
              <li
                key={`${person.id}-${person.direction}`}
                className="border-b py-2 last:border-b-0"
              >
                <Link
                  to="/contacts/$id"
                  params={{ id: person.id }}
                  className="font-medium hover:underline"
                >
                  {person.displayName}
                </Link>
                {person.direction === 'incoming' && (
                  <span className="text-muted-foreground ml-2 text-xs">links to this contact</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {alsoAtSameOrganization.length > 0 && (
        <section>
          <h3 className="mb-1 text-sm font-medium">Also at the same organization</h3>
          <p className="text-muted-foreground mb-2 text-xs">
            Worked out from current roles, not typed by anyone.
          </p>
          <ul className="flex flex-wrap gap-2">
            {alsoAtSameOrganization.map((person) => (
              <li key={person.id}>
                <Link
                  to="/contacts/$id"
                  params={{ id: person.id }}
                  className="hover:bg-accent inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm"
                >
                  {person.displayName}
                  <span className="text-muted-foreground text-xs">{person.organizationName}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
