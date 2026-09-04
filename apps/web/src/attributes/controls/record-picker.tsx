/**
 * `relation` — §4.2's "searchable picker".
 *
 * The search runs on the server, against the object type the attribute's own config names. That is
 * the whole reason this control never mentions "organization": `targetObjectType` and
 * `cardinality` come out of `relation.configSchema`, so the same component links a contact to an
 * organization, a contact to another contact ("introduced by") and — the day someone creates one —
 * a contact to an interaction.
 *
 * Existing values keep their §4.3 link metadata. Title, from, to and primary are what make a work
 * history readable, they are edited on the detail page (Stage 3), and a picker that dropped them
 * on every save would quietly delete a CV.
 */
import { ObjectTypeSchema, type ObjectType, type RelationValue } from '@mutuals/core'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Building2, MessageSquare, User } from 'lucide-react'
import { useMemo, useState, type ComponentType } from 'react'
import { z } from 'zod'

import { api } from '@/lib/api.ts'

import type { AttributeInputProps } from '../input-props.ts'
import { relationConfigOf } from '../value.ts'
import {
  Picker,
  PickerContent,
  PickerEmpty,
  PickerGroup,
  PickerItem,
  PickerTrigger,
} from './picker.tsx'
import { RemovableChip } from './select-controls.tsx'

const RECORD_ICONS: Record<ObjectType, ComponentType<{ className?: string }>> = {
  contact: User,
  organization: Building2,
  interaction: MessageSquare,
}

/**
 * Only the four fields a chip needs. Every list endpoint answers with more than this and zod
 * strips the rest, so one schema serves contacts, organizations and interactions — the last of
 * which has a `title` where the other two have a `displayName`.
 */
const PickableSchema = z.object({
  id: z.string(),
  objectType: ObjectTypeSchema,
  displayName: z.string().optional(),
  title: z.string().nullable().optional(),
})

const PickableListSchema = z.object({ data: z.array(PickableSchema) })

type Pickable = z.output<typeof PickableSchema>

function labelOf(record: Pickable): string {
  return record.displayName ?? record.title ?? 'Untitled'
}

/** Every list route is the object type, pluralised. */
function listPath(objectType: ObjectType): string {
  return `/${objectType}s`
}

export function RecordPickerControl({
  definition,
  value,
  onChange,
  onCommit,
  onCancel,
  error,
  errorId,
  disabled,
  id,
  className,
  ...rest
}: AttributeInputProps<'relation'>) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const config = useMemo(() => relationConfigOf(definition), [definition])
  const selected = value ?? []
  const single = config.cardinality === 'one'

  const results = useQuery({
    queryKey: ['record-picker', config.targetObjectType, search],
    queryFn: ({ signal }) =>
      api.get(PickableListSchema, listPath(config.targetObjectType), {
        signal,
        search: { limit: 20, ...(search.trim() === '' ? {} : { q: search.trim() }) },
      }),
    enabled: open,
    // Without it the list empties on every keystroke and the popover flickers between heights.
    placeholderData: keepPreviousData,
  })

  function pick(record: Pickable) {
    if (selected.some((entry) => entry.id === record.id)) {
      apply(selected.filter((entry) => entry.id !== record.id))
      return
    }
    const added: RelationValue = {
      id: record.id,
      label: labelOf(record),
      objectType: record.objectType,
      title: null,
      from: null,
      to: null,
      // `record_link.is_primary` defaults to true, and the first link a contact has is its primary
      // one. A second must not also claim to be, so only an empty list makes a primary.
      isPrimary: selected.length === 0,
    }
    apply(single ? [added] : [...selected, added])
    if (single) {
      setOpen(false)
      onCommit?.()
    }
  }

  function apply(next: readonly RelationValue[]) {
    onChange(next.length === 0 ? undefined : next)
  }

  return (
    <Picker
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setSearch('')
        // A one-to-one pick commits as it closes itself; a many picks several and commits once.
        if (!next && !single) onCommit?.()
        if (!next && single) onCancel?.()
      }}
    >
      <PickerTrigger
        id={id}
        disabled={disabled}
        empty={selected.length === 0}
        aria-label={rest['aria-label'] ?? definition.title}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
        className={className}
      >
        {selected.map((record) => (
          <RemovableChip
            key={record.id}
            label={record.label}
            onRemove={() => {
              apply(selected.filter((entry) => entry.id !== record.id))
            }}
          />
        ))}
      </PickerTrigger>

      <PickerContent
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder={`Search ${config.targetObjectType}s…`}
        // Postgres already ranked these; cmdk re-scoring them would fight the query.
        shouldFilter={false}
      >
        <PickerEmpty>
          {results.isFetching ? 'Searching…' : `No ${config.targetObjectType} matches.`}
        </PickerEmpty>
        <PickerGroup>
          {(results.data?.data ?? []).map((record) => {
            const Icon = RECORD_ICONS[record.objectType]
            return (
              <PickerItem
                key={record.id}
                value={record.id}
                selected={selected.some((entry) => entry.id === record.id)}
                onSelect={() => {
                  pick(record)
                }}
              >
                <Icon className="size-3.5 shrink-0 opacity-70" />
                <span className="truncate">{labelOf(record)}</span>
              </PickerItem>
            )
          })}
        </PickerGroup>
      </PickerContent>
    </Picker>
  )
}
