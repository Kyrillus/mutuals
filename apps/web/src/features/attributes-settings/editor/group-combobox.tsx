/**
 * Group: pick one that already exists, or type a new one.
 *
 * A group is not a table of its own — it is a string on the definition (§6.5 uses it to lay out
 * the detail sidebar) — so "create" here means nothing more than typing. The existing values are
 * offered so a workspace does not end up with "Work", "work" and "Work " meaning three sections.
 */
import { Check, Plus } from 'lucide-react'
import { useState } from 'react'

import { Chip } from '@/ui/chip.tsx'

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxTrigger,
} from './combobox.tsx'

export function GroupCombobox({
  value,
  groups,
  onChange,
  id,
  describedBy,
  labelledBy,
}: {
  value: string
  /** Every group already used by an attribute of this object type. */
  groups: readonly string[]
  onChange: (next: string) => void
  id?: string
  describedBy?: string | undefined
  labelledBy?: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const typed = search.trim()
  const isNew =
    typed !== '' && !groups.some((group) => group.toLocaleLowerCase() === typed.toLocaleLowerCase())

  function choose(next: string) {
    onChange(next)
    setOpen(false)
    setSearch('')
  }

  return (
    <Combobox
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <ComboboxTrigger
        id={id}
        describedBy={describedBy}
        labelledBy={labelledBy}
        empty={value === ''}
        placeholder="No group"
      >
        <Chip>{value}</Chip>
      </ComboboxTrigger>

      <ComboboxContent
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Find or create a group…"
        footer={
          isNew ? (
            <button
              type="button"
              onClick={() => {
                choose(typed)
              }}
              className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 border-t px-3 py-2 text-left text-sm"
            >
              <Plus className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">
                Create group <span className="font-medium">{typed}</span>
              </span>
            </button>
          ) : undefined
        }
      >
        <ComboboxEmpty>No group yet — type one above.</ComboboxEmpty>

        {value !== '' && (
          <ComboboxItem
            value="No group"
            onSelect={() => {
              choose('')
            }}
          >
            <span className="text-muted-foreground flex-1">No group</span>
          </ComboboxItem>
        )}

        {groups.map((group) => (
          <ComboboxItem
            key={group}
            value={group}
            onSelect={() => {
              choose(group)
            }}
          >
            <span className="min-w-0 flex-1 truncate">{group}</span>
            {group === value && <Check className="size-3.5 shrink-0 opacity-70" />}
          </ComboboxItem>
        ))}
      </ComboboxContent>
    </Combobox>
  )
}
