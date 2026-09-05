import { AlertTriangleIcon, SearchXIcon, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/ui/button.tsx'
import { Skeleton } from '@/ui/skeleton.tsx'

/**
 * The three states §5.2 asks for, as table rows rather than as replacements for the table.
 *
 * They render *inside* the `<tbody>` on purpose: the header, the filter chips and the Columns
 * picker stay where they were, so a search that returns nothing does not move every control on
 * the page and then move it back.
 */
export function SkeletonRows({ columns, rows = 12 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, index) => (
        <tr key={index} className="h-row border-border/60 border-b" aria-hidden>
          {Array.from({ length: columns }, (_, column) => (
            <td key={column} className="px-3">
              <Skeleton
                className="h-3"
                // A ragged edge reads as text; equal bars read as a progress meter that is stuck.
                style={{ width: `${String(45 + ((index * 7 + column * 13) % 40))}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

export function TableMessageRow({
  columns,
  icon: Icon,
  title,
  description,
  children,
}: {
  columns: number
  icon: LucideIcon
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <tr>
      <td colSpan={columns} className="px-6 py-20">
        {/*
          The cell spans a table that is usually wider than its scroll container, so centring
          inside it would put the message off-screen to the right. Sticking to the left edge and
          capping the width keeps it where the reader is looking, whatever the horizontal scroll.
        */}
        <div className="sticky left-0 flex w-[min(100%,56rem)] flex-col items-center text-center">
          <span className="bg-muted text-muted-foreground mb-4 grid size-10 place-items-center rounded-full">
            <Icon className="size-5" />
          </span>
          <h3 className="text-foreground text-base font-medium">{title}</h3>
          <p className="text-muted-foreground mt-1 max-w-md text-sm">{description}</p>
          {children !== undefined && <div className="mt-5 flex items-center gap-2">{children}</div>}
        </div>
      </td>
    </tr>
  )
}

/**
 * Nothing matched — and *why* nothing matched is the whole message.
 *
 * A search and a filter fail differently and are fixed differently, so the sentence names the one
 * the reader actually used. Telling somebody who typed three letters into the search box to "loosen
 * a filter" sends them looking for a filter that is not there.
 */
export function NoMatchesRow({
  columns,
  noun,
  filterCount,
  search,
  onClear,
}: {
  columns: number
  noun: string
  filterCount: number
  search: string | null
  onClear: () => void
}) {
  const searched = search !== null && search.trim() !== ''
  return (
    <TableMessageRow
      columns={columns}
      icon={SearchXIcon}
      title={searched ? `No ${noun} matches “${search.trim()}”` : `No ${noun} matches`}
      description={
        filterCount === 0
          ? `The search runs over the text columns on screen. Try a shorter word, or add the column you are looking in from the Columns menu.`
          : searched
            ? `Nothing satisfies the search and all ${String(filterCount)} ${filterCount === 1 ? 'filter' : 'filters'} at once. Filters combine with AND, so removing one widens the result.`
            : `Nothing satisfies all ${String(filterCount)} ${filterCount === 1 ? 'filter' : 'filters'} at once. Filters combine with AND, so removing one widens the result.`
      }
    >
      <Button variant="outline" size="sm" onClick={onClear}>
        {filterCount === 0 ? 'Clear the search' : 'Clear filters and search'}
      </Button>
    </TableMessageRow>
  )
}

export function ErrorRow({
  columns,
  message,
  onRetry,
}: {
  columns: number
  message: string
  onRetry: () => void
}) {
  return (
    <TableMessageRow
      columns={columns}
      icon={AlertTriangleIcon}
      title="This view could not be loaded"
      description={message}
    >
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </TableMessageRow>
  )
}
