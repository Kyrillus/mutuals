/**
 * §6.4's "contact* (searchable picker)".
 *
 * Deliberately not `RecordPickerControl`: that one is an attribute control and needs a definition
 * and its relation config to know what it is picking. A follow-up's contact is a column, not an
 * attribute, so bending the control to accept a fake definition would be worse than eighty lines.
 * The search itself is the same server-side `?q=` the picker uses.
 */
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'

import { api } from '@/lib/api.ts'
import { Input } from '@/ui/input.tsx'
import { cn } from '@/lib/utils.ts'

const ContactListSchema = z.object({
  data: z.array(z.object({ id: z.string(), displayName: z.string() })),
})

export interface PickedContact {
  readonly id: string
  readonly displayName: string
}

export function ContactPicker({
  value,
  onChange,
  invalid,
}: {
  value: PickedContact | null
  onChange: (contact: PickedContact | null) => void
  invalid?: boolean
}) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)

  const results = useQuery({
    queryKey: ['contact-picker', search],
    queryFn: ({ signal }) =>
      api.get(ContactListSchema, '/contacts', {
        signal,
        search: { limit: 15, ...(search.trim() === '' ? {} : { q: search.trim() }) },
      }),
    enabled: open,
    placeholderData: keepPreviousData,
  })

  if (value !== null) {
    return (
      <div className="flex items-center gap-2">
        <span className="bg-accent rounded-full px-2.5 py-1 text-sm">{value.displayName}</span>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-xs"
          onClick={() => {
            onChange(null)
            setOpen(true)
          }}
        >
          Change
        </button>
      </div>
    )
  }

  return (
    <div className="relative">
      <Input
        value={search}
        aria-label="Contact"
        aria-invalid={invalid === true}
        placeholder="Search contacts…"
        onFocus={() => {
          setOpen(true)
        }}
        onChange={(event) => {
          setSearch(event.target.value)
          setOpen(true)
        }}
      />
      {open && (
        <ul className="bg-popover absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border p-1 shadow-md">
          {results.data?.data.length === 0 && (
            <li className="text-muted-foreground px-2 py-1.5 text-sm">No contact matches.</li>
          )}
          {results.data?.data.map((contact) => (
            <li key={contact.id}>
              <button
                type="button"
                className={cn('hover:bg-accent w-full rounded px-2 py-1.5 text-left text-sm')}
                onClick={() => {
                  onChange(contact)
                  setOpen(false)
                  setSearch('')
                }}
              >
                {contact.displayName}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
