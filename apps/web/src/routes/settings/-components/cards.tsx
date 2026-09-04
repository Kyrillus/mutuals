/**
 * The card list §6.6 and `10-settings-objects.png` describe: a bordered card, one row per thing
 * you can configure, each with a title, a line explaining it, a count and a chevron.
 */
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { Skeleton } from '@/ui/skeleton.tsx'

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="border-border divide-border bg-card divide-y overflow-hidden rounded-lg border">
      {children}
    </div>
  )
}

export interface CardRowProps {
  readonly title: string
  readonly description: string
  /**
   * The count, already worded: `14 attributes`. `null` while it is loading, and `undefined` when
   * there is nothing to count yet — the two are different states and the row shows different
   * things for them, because a spinner that never resolves is worse than a plain answer.
   */
  readonly count: string | null | undefined
  readonly to?: string
  /** Shown in place of the count when there is none. */
  readonly note?: string
}

export function CardRow({ title, description, count, to, note }: CardRowProps) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="text-muted-foreground block text-xs">{description}</span>
      </span>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {count === null ? <Skeleton className="h-3.5 w-20" /> : (count ?? note)}
      </span>
      <ChevronRight className="text-muted-foreground/60 size-4 shrink-0" />
    </>
  )

  if (to === undefined) {
    return <div className="flex items-center gap-4 px-4 py-3.5 opacity-60">{body}</div>
  }

  return (
    <Link to={to} className="hover:bg-muted/60 flex items-center gap-4 px-4 py-3.5">
      {body}
    </Link>
  )
}
