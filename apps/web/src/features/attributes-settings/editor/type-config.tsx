/**
 * The type-specific section of the dialog.
 *
 * It renders nothing at all for the eight types that have no configuration — an empty "Settings"
 * panel is a question a person then tries to answer.
 *
 * `number` and `relation` are the only two the brief asks for, and they are read from the draft
 * rather than from a per-type schema walk: a generated form over `configSchema` would produce
 * "min", "max" and "hasLinkMetadata" as three more boxes to fill in, and the whole point of §6.7
 * is that inventing a field takes seconds.
 */
import { OBJECT_TYPES, type ObjectType } from '@mutuals/core'

import { Input } from '@/ui/input.tsx'

import type { AttributeDraft, NumberDraft, RelationDraft } from './draft.ts'
import { FieldRow, LockedNote } from './field-row.tsx'

const OBJECT_TYPE_LABELS: Record<ObjectType, string> = {
  contact: 'Contact',
  organization: 'Organization',
  interaction: 'Interaction',
}

export function TypeConfig({
  draft,
  issues,
  locked,
  onNumberChange,
  onRelationChange,
}: {
  draft: AttributeDraft
  issues: ReadonlyMap<string, string>
  /** True while editing: the relation's shape is fixed at creation. */
  locked: boolean
  onNumberChange: (next: NumberDraft) => void
  onRelationChange: (next: RelationDraft) => void
}) {
  if (draft.type === 'number') {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldRow
          label="Unit"
          help="Shown after the number, in the table and everywhere else. Leave empty for none."
          error={issues.get('config.unit')}
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={issues.has('config.unit')}
              value={draft.number.unit}
              placeholder="€, kg, years…"
              onChange={(event) => {
                onNumberChange({ ...draft.number, unit: event.target.value })
              }}
            />
          )}
        </FieldRow>

        <FieldRow
          label="Decimal places"
          help="How many digits to show. Empty shows the number exactly as it was entered."
          error={issues.get('config.decimals')}
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={issues.has('config.decimals')}
              inputMode="numeric"
              value={draft.number.decimals}
              placeholder="As entered"
              onChange={(event) => {
                onNumberChange({ ...draft.number, decimals: event.target.value })
              }}
            />
          )}
        </FieldRow>
      </div>
    )
  }

  if (draft.type === 'relation') {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldRow
          label="Links to"
          required
          help={
            locked ? (
              <LockedNote>
                Fixed when the field was created: every existing link points at this kind of record.
              </LockedNote>
            ) : (
              'Which kind of record this field points at.'
            )
          }
        >
          {({ id, describedBy }) => (
            <SegmentedChoice
              id={id}
              describedBy={describedBy}
              disabled={locked}
              value={draft.relation.targetObjectType}
              options={OBJECT_TYPES.map((type) => ({
                value: type,
                label: OBJECT_TYPE_LABELS[type],
              }))}
              onChange={(next) => {
                onRelationChange({ ...draft.relation, targetObjectType: next })
              }}
            />
          )}
        </FieldRow>

        <FieldRow
          label="How many"
          required
          help={
            locked ? (
              <LockedNote>
                Fixed when the field was created: it decides how values are stored, and the database
                is enforcing that answer for the links that already exist.
              </LockedNote>
            ) : (
              'One link, or a list of them.'
            )
          }
        >
          {({ id, describedBy }) => (
            <SegmentedChoice
              id={id}
              describedBy={describedBy}
              disabled={locked}
              value={draft.relation.cardinality}
              options={[
                { value: 'one', label: 'One' },
                { value: 'many', label: 'Many' },
              ]}
              onChange={(next) => {
                onRelationChange({ ...draft.relation, cardinality: next })
              }}
            />
          )}
        </FieldRow>
      </div>
    )
  }

  return null
}

/** Two or three mutually exclusive choices, where a dropdown would hide half the answer. */
function SegmentedChoice<T extends string>({
  value,
  options,
  onChange,
  id,
  describedBy,
  disabled,
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (next: T) => void
  id?: string
  describedBy?: string | undefined
  disabled?: boolean
}) {
  return (
    // `aria-pressed` toggles rather than `role="radio"`: a radio group owes the user arrow-key
    // navigation between its members, and these are three ordinary buttons that Tab reaches.
    <div
      id={id}
      role="group"
      aria-describedby={describedBy}
      className="border-input bg-background dark:bg-input/30 flex h-9 items-center gap-1 rounded-md border p-1"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => {
            onChange(option.value)
          }}
          className={
            option.value === value
              ? 'bg-primary text-primary-foreground h-7 flex-1 rounded text-xs font-medium disabled:opacity-60'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground h-7 flex-1 rounded text-xs disabled:opacity-60 disabled:hover:bg-transparent'
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
