import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * The three pieces every page in §6 starts from. They live in the shell rather than in a feature
 * because every feature needs the same ones, and a heading that drifts by two pixels per page is
 * how an app stops feeling like one product (§5).
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-6">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {description !== undefined && (
          <p className="text-muted-foreground mt-1 text-sm">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <div className="border-border flex flex-col items-center rounded-lg border border-dashed px-6 py-16 text-center">
      <span className="bg-muted text-muted-foreground mb-4 grid size-10 place-items-center rounded-full">
        <Icon className="size-5" />
      </span>
      <h2 className="text-base font-medium">{title}</h2>
      <p className="text-muted-foreground mt-1 max-w-md text-sm">{description}</p>
      {children !== undefined && <div className="mt-5 flex items-center gap-2">{children}</div>}
    </div>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-medium">{title}</h2>
      {children}
    </section>
  )
}
