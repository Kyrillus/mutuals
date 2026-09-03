/**
 * Contacts and organizations on the wire.
 *
 * System fields are named columns; everything the user invented lives under `attributes` (§4.2),
 * and the derived columns of §4.7 — warmth, last interaction, the counts — are read-only members
 * of the record rather than a second nested object, because the table renders them in the same row
 * as everything else.
 */
import { z } from 'zod'

import { CREATED_VIA_VALUES } from './shared.ts'
import { AttributesSchema, AttributeWriteSchema } from './attributes.ts'
import { CivilDateSchema, IsoDateTimeSchema, ObjectTypeSchema, UuidSchema } from './primitives.ts'

/** §4.4's provenance marker: "Imported 12 Mar 2026 from linkedin_connections.csv". */
export const ProvenanceSchema = z.object({
  createdVia: z.enum(CREATED_VIA_VALUES),
  importBatchId: UuidSchema.nullable(),
  createdAt: IsoDateTimeSchema,
})

export const ContactSchema = z.object({
  id: UuidSchema,
  objectType: z.literal('contact'),
  /** Generated in the database from first and last name; editing it means editing those. */
  displayName: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  /** §4.7's manual overrides: a floor of 60 and a cap of 10 respectively. */
  pinnedImportant: z.boolean(),
  notImportant: z.boolean(),
  warmth: z.int(),
  lastInteractionAt: IsoDateTimeSchema.nullable(),
  interactionCount12m: z.int(),
  openFollowups: z.int(),
  nextFollowupAt: CivilDateSchema.nullable(),
  provenance: ProvenanceSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  attributes: AttributesSchema,
})

export type Contact = z.output<typeof ContactSchema>

export const OrganizationSchema = z.object({
  id: UuidSchema,
  objectType: z.literal('organization'),
  displayName: z.string(),
  name: z.string(),
  /** Contacts currently linked to it — §6.3's "People" column. */
  peopleCount: z.int(),
  lastInteractionAt: IsoDateTimeSchema.nullable(),
  provenance: ProvenanceSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  attributes: AttributesSchema,
})

export type Organization = z.output<typeof OrganizationSchema>

/**
 * §5.3's create dialog. Both names are optional and at least one is required — a contact known
 * only as "Anna" is a real contact, a contact with no name at all is a row nobody can find.
 */
export const CreateContactSchema = z.object({
  firstName: z.string().trim().max(120).nullish(),
  lastName: z.string().trim().max(120).nullish(),
  pinnedImportant: z.boolean().optional(),
  notImportant: z.boolean().optional(),
  attributes: AttributeWriteSchema.optional(),
})

export type CreateContact = z.output<typeof CreateContactSchema>

export const UpdateContactSchema = CreateContactSchema

export const CreateOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  attributes: AttributeWriteSchema.optional(),
})

export type CreateOrganization = z.output<typeof CreateOrganizationSchema>

export const UpdateOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  attributes: AttributeWriteSchema.optional(),
})

/** §6.5's Connections tab, in one operation rather than three the UI would have to sequence. */
export const ConnectionsSchema = z.object({
  organizations: z.array(
    z.object({
      id: UuidSchema,
      displayName: z.string(),
      objectType: ObjectTypeSchema,
      title: z.string().nullable(),
      from: CivilDateSchema.nullable(),
      to: CivilDateSchema.nullable(),
      isPrimary: z.boolean(),
    }),
  ),
  /** Contact↔contact links, grouped by the attribute that made them ("Introduced by", "Knows"). */
  people: z.array(
    z.object({
      attributeSlug: z.string(),
      attributeTitle: z.string(),
      direction: z.enum(['outgoing', 'incoming']),
      id: UuidSchema,
      displayName: z.string(),
    }),
  ),
  /** Derived and read-only: other contacts sharing a current organization. */
  alsoAtSameOrganization: z.array(
    z.object({
      id: UuidSchema,
      displayName: z.string(),
      organizationId: UuidSchema,
      organizationName: z.string(),
    }),
  ),
})

export const BulkDeleteSchema = z.object({ ids: z.array(UuidSchema).min(1).max(500) })

/**
 * §5.2's bulk action bar: one attribute, one value, many records. `value: null` clears it, which is
 * how "remove tag from 40 contacts" is expressed without a second operation.
 */
export const BulkUpdateAttributeSchema = z.object({
  ids: z.array(UuidSchema).min(1).max(500),
  slug: z.string().min(1).max(63),
  value: z.unknown(),
})
