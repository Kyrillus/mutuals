/**
 * Interactions on the wire (§4.1, §6.5).
 *
 * An interaction is a `record` subtype like a contact, so it has an id space, provenance and — the
 * day §4.1's "model it so it would be a small change" is cashed in — custom attributes. What is
 * special is the participant junction, which is why `contacts` and `organizations` are first-class
 * members here rather than a relation attribute.
 */
import { z } from 'zod'

import { INTERACTION_TYPES } from '../warmth.ts'
import { INTERACTION_SOURCES } from './shared.ts'
import { IsoDateTimeSchema, RecordRefSchema, UuidSchema } from './primitives.ts'

export const InteractionTypeSchema = z.enum(INTERACTION_TYPES)
export const InteractionSourceSchema = z.enum(INTERACTION_SOURCES)

export const InteractionSchema = z.object({
  id: UuidSchema,
  objectType: z.literal('interaction'),
  type: InteractionTypeSchema,
  occurredAt: IsoDateTimeSchema,
  title: z.string().nullable(),
  /** Markdown, rendered by the client. */
  body: z.string().nullable(),
  source: InteractionSourceSchema,
  contacts: z.array(RecordRefSchema),
  organizations: z.array(RecordRefSchema),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})

export type Interaction = z.output<typeof InteractionSchema>

export const CreateInteractionSchema = z.object({
  type: InteractionTypeSchema,
  occurredAt: IsoDateTimeSchema,
  title: z.string().trim().max(300).nullish(),
  body: z.string().max(100_000).nullish(),
  source: InteractionSourceSchema.optional(),
  contactIds: z.array(UuidSchema).max(200).optional(),
  organizationIds: z.array(UuidSchema).max(200).optional(),
})

export type CreateInteraction = z.output<typeof CreateInteractionSchema>

/**
 * Participants are a **set**, not a log: an absent `contactIds` leaves them alone, an array — the
 * empty one included — makes that list true. Anything else needs an add and a remove operation for
 * something the UI edits as one multi-select.
 */
export const UpdateInteractionSchema = z.object({
  type: InteractionTypeSchema.optional(),
  occurredAt: IsoDateTimeSchema.optional(),
  title: z.string().trim().max(300).nullish(),
  body: z.string().max(100_000).nullish(),
  contactIds: z.array(UuidSchema).max(200).optional(),
  organizationIds: z.array(UuidSchema).max(200).optional(),
})

/**
 * The timeline query of §6.5: this contact, newest first, optionally one type.
 *
 * It pages by the same opaque cursor the record lists use rather than by a public `before`
 * timestamp — one pagination mechanism across the API, and the keyset walk down
 * `interaction_occurred_idx` stays an implementation detail.
 */
export const InteractionListQuerySchema = z.object({
  contactId: UuidSchema.optional(),
  organizationId: UuidSchema.optional(),
  type: InteractionTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(512).optional(),
})
