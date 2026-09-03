/**
 * The scalar shapes every request and response schema is built from.
 *
 * They live in `packages/core` rather than in `apps/api` because ADR-030 deleted client codegen:
 * the frontend gets its types by importing these, the API implements them, and the OpenAPI
 * document is emitted from them. One declaration, three consumers.
 *
 * The canonical forms are ADR-039's: a number is an exact decimal *string* and a date is a civil
 * `'YYYY-MM-DD'` *string*, so `250000.50` and a birthday both survive the wire byte-identically.
 */
import { z } from 'zod'

import { isDecimalString } from '../decimal.ts'
import { OBJECT_TYPES } from '../attributes/kinds.ts'
import { ATTRIBUTE_TYPES } from '../attributes/registry.ts'
import { SLUG_PATTERN } from '../attributes/slug.ts'

export const UuidSchema = z.uuid()

/** An instant, as `Date#toISOString` writes it. */
export const IsoDateTimeSchema = z.iso.datetime()

/** A calendar day with no time and no zone (ADR-039). */
export const CivilDateSchema = z.iso.date()

/** An exact decimal, never a JavaScript number (ADR-039). */
export const DecimalStringSchema = z
  .string()
  .refine(isDecimalString, { error: 'Enter a number like 1250 or 1250.50.' })

/** The machine name of an attribute. The same pattern the `attribute_definition` CHECK enforces. */
export const SlugSchema = z.string().regex(SLUG_PATTERN)

export const ObjectTypeSchema = z.enum(OBJECT_TYPES)

export const AttributeTypeSchema = z.enum([...ATTRIBUTE_TYPES] as [string, ...string[]])

/** The `{ id, label }` pair a relation chip, a follow-up's contact and a search hit all render. */
export const RecordRefSchema = z.object({
  id: UuidSchema,
  displayName: z.string(),
  objectType: ObjectTypeSchema,
})

export type RecordRef = z.output<typeof RecordRefSchema>

/** Path parameter for every `/:id` route, so an unparseable id is a 400 and never a query. */
export const IdParamSchema = z.object({ id: UuidSchema })
