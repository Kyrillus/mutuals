/**
 * The field picker: every filterable field, grouped and searchable (§5.2).
 *
 * Searching is done here rather than by cmdk's fuzzy scorer — `shouldFilter={false}` — so that
 * matching is the tested rule in `fields.ts` (label, slug or group, case-insensitively) and a
 * person looking for "Last interaction" by typing "inter" gets it, while the keyboard behaviour
 * cmdk exists for stays cmdk's.
 */
import type { FieldDescriptor } from '@mutuals/core'
import { Command } from 'cmdk'
import { Search } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/utils.ts'

import { pickerGroups } from './fields.ts'

export function FieldList({
  fields,
  onSelect,
}: {
  fields: readonly FieldDescriptor[]
  onSelect: (field: FieldDescriptor) => void
}) {
  const [term, setTerm] = useState('')
  const groups = pickerGroups(fields, term)

  return (
    <Command loop shouldFilter={false} className="flex flex-col">
      <div className="flex items-center gap-2 border-b px-2.5">
        <Search className="text-muted-foreground size-3.5 shrink-0" />
        <Command.Input
          autoFocus
          value={term}
          onValueChange={setTerm}
          placeholder="Find a field…"
          aria-label="Find a field"
          className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <Command.List className="max-h-72 overflow-y-auto p-1">
        <Command.Empty className="text-muted-foreground px-2 py-6 text-center text-sm">
          No field matches “{term}”.
        </Command.Empty>
        {groups.map((group) => (
          <Command.Group
            key={group.name}
            heading={group.name}
            className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium"
          >
            {group.fields.map((field) => (
              <Command.Item
                key={field.slug}
                value={field.slug}
                onSelect={() => {
                  onSelect(field)
                }}
                className={cn(
                  'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none',
                  'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
                )}
              >
                <span className="truncate">{field.label}</span>
                {field.source.kind === 'metric' && (
                  // §5.2's derived columns are filterable like any other field; saying so is the
                  // difference between "why is Last interaction not editable" and understanding.
                  <span className="text-muted-foreground ml-auto shrink-0 text-xs">computed</span>
                )}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command>
  )
}
