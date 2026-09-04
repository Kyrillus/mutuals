/**
 * §6.5's header: who this is, in one line, plus the destructive actions behind a `⋯`.
 *
 * The context line is assembled from whatever the record actually has. A contact with no
 * organization and no city gets a shorter line, not an empty one with separators in it.
 */
import { MoreHorizontal, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'

import { formatDateTime } from '@/attributes/format.ts'
import { useDisplay } from '@/attributes/display-context.tsx'
import { initialsOf } from '@/table/record-row.ts'
import { Avatar, AvatarFallback } from '@/ui/avatar.tsx'
import { Button } from '@/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu.tsx'

const CREATED_VIA_LABEL: Record<string, string> = {
  manual: 'Added by you',
  import: 'Imported',
  api: 'Added through the API',
  agent: 'Added by the assistant',
}

export function RecordHeader({
  displayName,
  provenance,
  context,
  actions,
  onDelete,
}: {
  displayName: string
  provenance: { createdVia: string; createdAt: string }
  /** The middle line: organization, city, role — whatever the type has to say. */
  context?: ReactNode
  actions?: ReactNode
  onDelete: () => void
}) {
  const { locale, timeZone } = useDisplay()

  return (
    <header className="flex items-start gap-4">
      <Avatar size="lg" className="shrink-0">
        <AvatarFallback>{initialsOf(displayName)}</AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-2xl font-semibold">{displayName}</h1>
        {context !== undefined && (
          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            {context}
          </div>
        )}
        {/* §4.4: where this record came from, in small grey text rather than as a field. */}
        <p className="text-muted-foreground/70 mt-1 text-xs">
          {CREATED_VIA_LABEL[provenance.createdVia] ?? provenance.createdVia} ·{' '}
          {formatDateTime(provenance.createdAt, locale, timeZone)}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {actions}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" aria-label="Record actions">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* Merge is §6.9, Stage 5. Shown disabled rather than hidden so the menu does not grow
                an item later and move the one people have already learnt. */}
            <DropdownMenuItem disabled>Merge into another record…</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
