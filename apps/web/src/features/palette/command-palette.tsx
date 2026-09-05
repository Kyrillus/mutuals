/**
 * §6.10's ⌘K palette: search across records, plus the six actions the brief names.
 *
 * One control, two jobs, and the ordering is what keeps them from fighting. With an empty box it is
 * a list of actions — *New contact*, *Quick capture*, *Go to Settings* — because that is what ⌘K on
 * an empty input means everywhere else. From the third character it is a search, with the actions
 * still reachable underneath. Nothing is hidden; what changes is what is first.
 *
 * The results are grouped by object type (§4.8) and each row says which index answered, so a
 * contact found because a meeting note mentions them does not look like a name match that went
 * wrong.
 */
import type { RecordRef, SearchResponse } from '@mutuals/core'
import { useNavigate } from '@tanstack/react-router'
import {
  Building2,
  CalendarClock,
  MessageSquare,
  Search,
  Settings,
  Sparkles,
  Users,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/ui/command.tsx'

import { MIN_SEARCH_LENGTH, useDebounced, useSearch } from './use-search.ts'

export type PaletteAction =
  | { readonly kind: 'navigate'; readonly to: string }
  | { readonly kind: 'quick-capture' }
  | { readonly kind: 'new-record'; readonly objectType: 'contact' | 'organization' }
  | { readonly kind: 'new-follow-up' }
  | { readonly kind: 'new-interaction' }

interface ActionEntry {
  readonly id: string
  readonly label: string
  readonly icon: typeof Users
  readonly action: PaletteAction
  /** Words a person might type that are not in the label. */
  readonly keywords?: readonly string[]
}

/** §6.10 names these six by hand. Order is by how often they are reached for, not alphabetically. */
const ACTIONS: readonly ActionEntry[] = [
  {
    id: 'quick-capture',
    label: 'Quick capture',
    icon: Sparkles,
    action: { kind: 'quick-capture' },
    keywords: ['note', 'met', 'capture', 'ai'],
  },
  {
    id: 'new-contact',
    label: 'New contact',
    icon: Users,
    action: { kind: 'new-record', objectType: 'contact' },
    keywords: ['person', 'add'],
  },
  {
    id: 'new-organization',
    label: 'New organization',
    icon: Building2,
    action: { kind: 'new-record', objectType: 'organization' },
    keywords: ['company', 'fund', 'add'],
  },
  {
    id: 'new-follow-up',
    label: 'New follow-up',
    icon: CalendarClock,
    action: { kind: 'new-follow-up' },
    keywords: ['reminder', 'todo', 'add'],
  },
  {
    id: 'new-interaction',
    label: 'New interaction',
    icon: MessageSquare,
    action: { kind: 'new-interaction' },
    keywords: ['meeting', 'call', 'note', 'log', 'add'],
  },
  {
    id: 'settings',
    label: 'Go to Settings',
    icon: Settings,
    action: { kind: 'navigate', to: '/settings/profile' },
    keywords: ['fields', 'attributes', 'profile'],
  },
]

const GROUP_LABELS: Record<string, string> = {
  contact: 'Contacts',
  organization: 'Organizations',
  interaction: 'Interactions',
}

const VIA_LABELS: Record<string, string> = {
  label: 'name',
  identifier: 'email or link',
  text: 'in a note',
}

export function CommandPalette({
  open,
  onOpenChange,
  onAction,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  onAction: (action: PaletteAction) => void
}) {
  const [query, setQuery] = useState('')
  const needle = useDebounced(query)
  const search = useSearch(open ? needle : '')
  const navigate = useNavigate()

  // Cleared on close rather than on open: clearing on open makes the box flicker through the old
  // needle while the dialog animates in.
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const searching = query.trim().length >= MIN_SEARCH_LENGTH
  const groups = groupByType(search.data)

  const run = (action: PaletteAction): void => {
    onOpenChange(false)
    if (action.kind === 'navigate') {
      void navigate({ to: action.to })
      return
    }
    onAction(action)
  }

  const openRecord = (record: RecordRef): void => {
    onOpenChange(false)
    if (record.objectType === 'interaction') {
      // An interaction has no page of its own (§6.5 puts it on the contact's Activities tab), so
      // the honest destination is the timeline it lives in rather than a route that does not exist.
      void navigate({ to: '/contacts' })
      return
    }
    void navigate({
      to: record.objectType === 'contact' ? '/contacts/$id' : '/organizations/$id',
      params: { id: record.id },
    })
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} label="Search and commands">
      <Command>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search people, companies and notes, or type a command…"
        />
        <CommandList>
          {searching && search.isPending && (
            <p className="text-muted-foreground px-2 py-8 text-center text-sm">Searching…</p>
          )}

          {searching && !search.isPending && groups.length === 0 && (
            <CommandEmpty>Nothing matches “{query.trim()}”.</CommandEmpty>
          )}

          {groups.map((group) => (
            <CommandGroup
              key={group.objectType}
              heading={GROUP_LABELS[group.objectType] ?? 'Other'}
            >
              {group.hits.map((hit) => (
                <CommandItem
                  key={hit.record.id}
                  value={`record:${hit.record.id}`}
                  onSelect={() => {
                    openRecord(hit.record)
                  }}
                >
                  <Search className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{hit.record.displayName}</span>
                  {hit.snippet !== null && (
                    <span className="text-muted-foreground min-w-0 max-w-[45%] truncate text-xs">
                      {hit.snippet}
                    </span>
                  )}
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {VIA_LABELS[hit.via]}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}

          <CommandGroup heading="Actions">
            {ACTIONS.filter((entry) => matchesAction(entry, query)).map((entry) => (
              <Row
                key={entry.id}
                entry={entry}
                onSelect={() => {
                  run(entry.action)
                }}
              />
            ))}
          </CommandGroup>

          {!searching && query.trim() !== '' && (
            <p className="text-muted-foreground px-2 pb-2 text-center text-xs">
              Type {MIN_SEARCH_LENGTH} characters to search your records.
            </p>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

function Row({ entry, onSelect }: { entry: ActionEntry; onSelect: () => void }): ReactNode {
  const Icon = entry.icon
  return (
    <CommandItem value={`action:${entry.id}`} onSelect={onSelect} keywords={entry.keywords}>
      <Icon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="flex-1">{entry.label}</span>
    </CommandItem>
  )
}

/**
 * Actions are filtered here rather than by cmdk, because cmdk's filter is switched off for the
 * whole list — the record rows come pre-ranked from Postgres and re-scoring them locally would
 * fight that query. So the actions get the simple substring match a fixed list of six deserves.
 */
function matchesAction(entry: ActionEntry, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return true
  if (entry.label.toLocaleLowerCase().includes(needle)) return true
  return (entry.keywords ?? []).some((word) => word.includes(needle))
}

interface Group {
  readonly objectType: string
  readonly hits: SearchResponse['data']
}

/** §4.8: "Results grouped by object type." Server order is kept inside each group. */
function groupByType(response: SearchResponse | undefined): readonly Group[] {
  if (response === undefined) return []
  const groups = new Map<string, SearchResponse['data']>()
  for (const hit of response.data) {
    const bucket = groups.get(hit.record.objectType)
    if (bucket === undefined) groups.set(hit.record.objectType, [hit])
    else bucket.push(hit)
  }
  return [...groups].map(([objectType, hits]) => ({ objectType, hits }))
}
