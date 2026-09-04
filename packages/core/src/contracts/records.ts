/**
 * Contacts and organizations on the wire.
 *
 * System fields are named columns; everything the user invented lives under `attributes` (§4.2),
 * and the derived columns of §4.7 — warmth, last interaction, the counts — are read-only members
 * of the record rather than a second nested object, because the table renders them in the same row
 * as everything else.
 */
import { z } from 'zod'

import { CREATED_VIA_VALUES, FACT_SOURCE_VALUES } from './shared.ts'
import { AttributesSchema, AttributeValueSchema, AttributeWriteSchema } from './attributes.ts'
import { CivilDateSchema, IsoDateTimeSchema, ObjectTypeSchema, UuidSchema } from './primitives.ts'
import { filterSetSchema } from '../filters/model.ts'
import { sortRequestSchema } from '../filters/query.ts'

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

export type Connections = z.output<typeof ConnectionsSchema>

/**
 * §4.5's history popover: every value one attribute on one record has ever held.
 *
 * Each entry carries a rendered {@link AttributeValueSchema} rather than the slot it came out of,
 * so the client draws history with the same component it draws the current value with — and so the
 * wire contract stays clear of the physical columns CLAUDE.md confines to one file.
 *
 * `value` is null for a tombstone: removing an element of a multi-valued attribute writes a fact
 * rather than deleting one, and "Energy, removed in March" is a thing the popover has to say.
 */
export const ValueHistoryEntrySchema = z.object({
  factId: UuidSchema,
  value: AttributeValueSchema.nullable(),
  /** The day the value became true, which is not the day it was recorded. */
  validFrom: CivilDateSchema,
  observedAt: IsoDateTimeSchema,
  source: z.enum(FACT_SOURCE_VALUES),
  sourceRef: z.string().nullable(),
  /** `1` for anything a human typed; lower for what an importer or a model proposed. */
  confidence: z.string(),
  /** True for the one row the projection currently serves. */
  isCurrent: z.boolean(),
  /** True where this fact records a removal rather than a value. */
  isRemoval: z.boolean(),
  removedAt: IsoDateTimeSchema.nullable(),
})

export const ValueHistorySchema = z.object({
  attributeSlug: z.string(),
  attributeTitle: z.string(),
  entries: z.array(ValueHistoryEntrySchema),
})

/** `Dto`, like {@link AttributeDefinitionDto}: `packages/db` exports a `ValueHistoryEntry` too, and
 * they are different things — that one is the row, this one is the wire shape. */
export type ValueHistoryDto = z.output<typeof ValueHistorySchema>
export type ValueHistoryEntryDto = z.output<typeof ValueHistoryEntrySchema>

export const HistoryParamSchema = z.object({ id: UuidSchema, attributeId: UuidSchema })

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

/**
 * §6.6's saved views. ADR-048 settles the semantics this shape has to carry: the URL is the working
 * copy and a view is a named snapshot of `(filters, sort, columns)` loaded into it.
 *
 * `columns` is a list of slugs in display order. The migration's comment says `[{slug, width?}]`,
 * which the implementation never did — widths are not part of a view and `ViewSnapshot` has always
 * been `string[]`. Recorded rather than corrected, because an applied migration is not edited.
 */
export const SavedViewSchema = z.object({
  id: UuidSchema,
  objectType: ObjectTypeSchema,
  name: z.string(),
  /** What the bare `/contacts` route loads. `sv_default_uq` enforces one per object type. */
  isDefault: z.boolean(),
  columns: z.array(z.string()),
  filters: filterSetSchema,
  sort: sortRequestSchema.nullable(),
  position: z.int(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})

export type SavedView = z.output<typeof SavedViewSchema>

export const CreateSavedViewSchema = z.object({
  objectType: ObjectTypeSchema,
  name: z.string().trim().min(1).max(120),
  columns: z.array(z.string()).max(200),
  filters: filterSetSchema,
  sort: sortRequestSchema.nullish(),
  isDefault: z.boolean().optional(),
})

export type CreateSavedView = z.output<typeof CreateSavedViewSchema>

/**
 * Every field optional: `Save changes to view` sends the snapshot, and renaming sends only a name.
 * `objectType` is absent on purpose — a view does not move between object types, and allowing it
 * would let a contacts view acquire organization columns.
 */
export const UpdateSavedViewSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  columns: z.array(z.string()).max(200).optional(),
  filters: filterSetSchema.optional(),
  sort: sortRequestSchema.nullish(),
  isDefault: z.boolean().optional(),
  position: z.int().optional(),
})

export const SavedViewListQuerySchema = z.object({ objectType: ObjectTypeSchema.optional() })
