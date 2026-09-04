/**
 * One row, as the table sees it.
 *
 * `Contact` and `Organization` are structurally different everywhere except here: an id, a label,
 * provenance, timestamps and the `attributes` map. Everything else a column might want —
 * `warmth`, `people_count`, `first_name` — is reached through {@link systemValue}, which is the
 * single reason this table can render an object type it has never heard of.
 */
import type { Attributes, ObjectType } from '@mutuals/core'

export interface RecordProvenance {
  readonly createdVia: string
  readonly importBatchId: string | null
  readonly createdAt: string
}

export interface RecordRow {
  readonly id: string
  readonly objectType: ObjectType
  /** `record.display_label` on the wire: what the sticky first column renders. */
  readonly displayName: string
  /** Optional so a subtype that carries no §4.4 marker — an interaction — still fits this shape. */
  readonly provenance?: RecordProvenance
  readonly createdAt: string
  readonly updatedAt: string
  readonly attributes: Attributes
}

/**
 * `display_name` → `displayName`, `interaction_count_12m` → `interactionCount12m`.
 *
 * The capture is `.` rather than `[a-z]` on purpose: `_12m` has to lose its underscore too, and a
 * letter-only class leaves `interactionCount_12m`, which reads as a missing value rather than as
 * the bug it is.
 */
export function camelCase(slug: string): string {
  return slug.replace(/_(.)/g, (_match, char: string) => char.toUpperCase())
}

/**
 * The value of a system or derived field, by its `packages/core` slug.
 *
 * Two containers are searched, not one: §4.4's provenance travels as a nested object while
 * `created_at` and the metrics are top-level, and `SYSTEM_FIELDS` declares both kinds side by
 * side. Searching the row and then `provenance` is a rule about the wire shape; naming which
 * slugs live where would be the hard-coded column CLAUDE.md forbids.
 */
export function systemValue(row: RecordRow, slug: string): unknown {
  const key = camelCase(slug)
  const top = (row as unknown as Record<string, unknown>)[key]
  if (top !== undefined) return top
  return (row.provenance as unknown as Record<string, unknown> | undefined)?.[key]
}

/** The initials an avatar falls back to. Two words at most, so `SR` never becomes `SRB`. */
export function initialsOf(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0] ?? ''
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : ''
  return `${[...first][0] ?? ''}${[...last][0] ?? ''}`.toUpperCase()
}
