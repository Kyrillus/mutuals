/**
 * The dashboard's numbers, the profile, and the three Stage-6 operations.
 *
 * `search`, `ask` and `quickCapture` answer 501 today. Their shapes are here, and in the OpenAPI
 * document, because §7 makes the API the contract every client is written against: a frontend or
 * an MCP adapter should be able to see the destination before the engine is fitted.
 */
import { z } from 'zod'

import { CivilDateSchema, IsoDateTimeSchema, RecordRefSchema, UuidSchema } from './primitives.ts'
import { filterSetSchema } from '../filters/model.ts'

/** §6.1's stat cards. Each one links to a pre-filtered view, so each is an exact count. */
export const StatsSchema = z.object({
  totalContacts: z.int(),
  totalOrganizations: z.int(),
  totalInteractions: z.int(),
  contactsAddedLast30Days: z.int(),
  followUpsDueThisWeek: z.int(),
  followUpsOverdue: z.int(),
  /** The civil day the counts were computed against, in the profile's timezone (ADR-045). */
  today: CivilDateSchema,
})

export const ProfileSchema = z.object({
  /**
   * `null` until the first save. No profile row exists on a fresh database, and a GET that writes
   * one is a GET with a side effect — so the API answers with the environment defaults instead and
   * `updateProfile` is the first write.
   */
  id: UuidSchema.nullable(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().nullable(),
  language: z.string(),
  /** ADR-045: without it a national phone number cannot be normalised at all. */
  phoneRegion: z.string(),
  /** ADR-045: without it the nightly warmth sweep would depend on the server's `TZ`. */
  timeZone: z.string(),
  createdAt: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema.nullable(),
})

export type Profile = z.output<typeof ProfileSchema>

export const UpdateProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(120).optional(),
  lastName: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().max(254).nullish(),
  language: z.string().trim().min(2).max(16).optional(),
  phoneRegion: z.string().trim().length(2).optional(),
  timeZone: z.string().trim().min(1).max(64).optional(),
})

// -- Stage 6 -----------------------------------------------------------------------------------

export const SearchQuerySchema = z.object({
  q: z.string().min(1).max(256),
  limit: z.coerce.number().int().min(1).max(50).optional(),
})

export const SearchResponseSchema = z.object({
  data: z.array(
    z.object({
      record: RecordRefSchema,
      /** Which index answered: the palette merges a trigram, a prefix and a `tsvector` probe. */
      via: z.enum(['label', 'identifier', 'text']),
      snippet: z.string().nullable(),
    }),
  ),
})

export const AskRequestSchema = z.object({
  question: z.string().min(1).max(2000),
  objectType: z.enum(['contact', 'organization']).optional(),
})

/**
 * §4.8: the answer always ships the filter it ran, so the user can trust it or correct it. That is
 * why `filter` is the ordinary filter model and not a private shape — "how I searched" is a link
 * into the same table the user could have built by hand.
 */
export const AskResponseSchema = z.object({
  answer: z.string(),
  filter: filterSetSchema,
  matches: z.array(RecordRefSchema),
})

export const QuickCaptureRequestSchema = z.object({
  text: z.string().min(1).max(10_000),
})

/**
 * Nothing is saved before confirmation (§4.8), so this is a *preview*: every element says whether
 * it would be created or matched onto an existing record, and the client posts the confirmed
 * version back through the ordinary create operations.
 */
export const QuickCaptureResponseSchema = z.object({
  contact: z
    .object({ action: z.enum(['create', 'match']), matchId: UuidSchema.nullable() })
    .nullable(),
  organization: z
    .object({ action: z.enum(['create', 'match']), matchId: UuidSchema.nullable() })
    .nullable(),
  interaction: z.unknown().nullable(),
  followUp: z.unknown().nullable(),
})
