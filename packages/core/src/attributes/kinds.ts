/**
 * The database's `object_type` and `value_kind` enums, and the canonical shape of one normalised
 * value on its way to a fact row.
 *
 * `value_kind` is which physical slot an attribute type lands in. It is derived from the type in
 * code and stored on the row so the composite foreign key
 * `(attribute_id, value_kind, is_multi) → attribute_definition` can make slot drift impossible.
 * {@link VALUE_KIND_BY_ATTRIBUTE_TYPE} is the single transcription of the `ad_kind_matches_type`
 * CHECK; `registry.test.ts` asserts the registry agrees with it, so the two cannot drift.
 */
import type { CivilDate } from '../time/civil.ts'
import type { DecimalString } from '../decimal.ts'

export const OBJECT_TYPES = ['contact', 'organization', 'interaction'] as const
export type ObjectType = (typeof OBJECT_TYPES)[number]

export const VALUE_KINDS = ['text', 'number', 'date', 'bool', 'option', 'relation'] as const
export type ValueKind = (typeof VALUE_KINDS)[number]

/** §4.6: every handle we have ever seen for a record, normalised, unique on (kind, value). */
export const IDENTIFIER_KINDS = [
  'email',
  'phone',
  'linkedin_url',
  'website',
  'google_contact_id',
  'telegram',
  'whatsapp',
  'other',
] as const
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number]

/**
 * Not branded. Core validates uuid *shape* where it matters and otherwise passes ids through, so
 * a brand here would only add casts at every boundary without catching a real class of bug.
 */
export type Uuid = string

/**
 * Transcribed from the `ad_kind_matches_type` CHECK in migration 0002, line for line.
 *
 * Keyed by plain strings rather than `AttributeType`, because `AttributeType` is derived from the
 * registry and the registry's type files read their `valueKind` from here — the dependency has to
 * run one way for that to be possible.
 */
export const VALUE_KIND_BY_ATTRIBUTE_TYPE = {
  short_text: 'text',
  long_text: 'text',
  url: 'text',
  email: 'text',
  phone: 'text',
  tags: 'text',
  number: 'number',
  date: 'date',
  yes_no: 'bool',
  single_select: 'option',
  multi_select: 'option',
  relation: 'relation',
} as const satisfies Record<string, ValueKind>

/** §4.3: the metadata a contact↔organization link carries, which is what makes a CV readable. */
export interface LinkMetadata {
  readonly title?: string
  readonly from?: CivilDate
  /** `null` means current. */
  readonly to?: CivilDate | null
  readonly isPrimary?: boolean
}

/**
 * One value that has been validated and normalised and is ready to be written as a fact.
 *
 * The `text` variant carries only the verbatim string: the normalised and sort forms are written
 * by the SQL projector and by nothing else (ADR-019, ADR-020), so TypeScript never produces a
 * value that is compared against a normalised column.
 */
export type SlotValue =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'number'; readonly num: DecimalString }
  | { readonly kind: 'date'; readonly date: CivilDate }
  | { readonly kind: 'bool'; readonly bool: boolean }
  | { readonly kind: 'option'; readonly optionId: Uuid; readonly optionKey: string }
  | { readonly kind: 'relation'; readonly targetRecordId: Uuid; readonly link?: LinkMetadata }

export function isObjectType(value: string): value is ObjectType {
  return (OBJECT_TYPES as readonly string[]).includes(value)
}

export function isValueKind(value: string): value is ValueKind {
  return (VALUE_KINDS as readonly string[]).includes(value)
}
