import { Breadcrumbs } from './breadcrumbs.tsx'

/**
 * §5.1's top bar carries the breadcrumb and nothing else yet. §6.10's quick-capture `+` belongs
 * here and arrives with the command palette in Stage 6; the row is sized for it already.
 */
export function TopBar() {
  return (
    <header className="border-border bg-background flex h-topbar shrink-0 items-center gap-3 border-b px-6">
      <Breadcrumbs />
    </header>
  )
}
