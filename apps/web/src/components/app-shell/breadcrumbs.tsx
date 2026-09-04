import { Link, useMatches } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { Fragment } from 'react'

type Crumb = { label: string; to: string }

/**
 * §5.1's breadcrumb, read off the matched routes rather than off the pathname. A route declares its
 * own crumb in `staticData` (see `lib/route-meta.ts`), so `Contacts › Anna Berger` is what the
 * detail route says it is — the breadcrumb never has to learn the URL grammar of a later stage.
 */
export function Breadcrumbs() {
  const crumbs = useMatches({
    select: (matches): Crumb[] =>
      matches.flatMap((match) => {
        const label = match.staticData.crumb
        return label === undefined ? [] : [{ label, to: match.pathname }]
      }),
  })

  if (crumbs.length === 0) return null

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1
        return (
          <Fragment key={crumb.to}>
            {index > 0 && <ChevronRight className="text-muted-foreground/50 size-3.5 shrink-0" />}
            {last ? (
              <span aria-current="page" className="truncate font-medium">
                {crumb.label}
              </span>
            ) : (
              <Link
                to={crumb.to}
                className="text-muted-foreground hover:text-foreground truncate rounded-sm"
              >
                {crumb.label}
              </Link>
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}
