/**
 * Closed sets the wire contract needs that are not already a domain concept elsewhere in
 * `packages/core`.
 *
 * They are transcriptions of the `CHECK (x IN (…))` constraints in migrations 0001 and 0002. The
 * database is the backstop; these exist so a bad value is a 400 with a field name rather than a
 * 500 with a constraint name, and so the OpenAPI document lists the options.
 */

/** §4.4's provenance: how a record came to exist. */
export const CREATED_VIA_VALUES = ['manual', 'import', 'api', 'agent'] as const
export type CreatedVia = (typeof CREATED_VIA_VALUES)[number]

/** §4.1: only `manual` and `import` are reachable in Phase 1; the rest are the sync stubs of §9. */
export const INTERACTION_SOURCES = [
  'manual',
  'import',
  'gmail',
  'calendar',
  'whatsapp',
  'telegram',
  'agent',
] as const
export type InteractionSource = (typeof INTERACTION_SOURCES)[number]

/** §4.1: `system` is reserved for the automatic nudges of §9. */
export const FOLLOW_UP_ORIGINS = ['manual', 'system'] as const
export type FollowUpOrigin = (typeof FOLLOW_UP_ORIGINS)[number]
