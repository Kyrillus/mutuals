/**
 * The `attributes` map, written down once (ADR-031).
 *
 * This is not an example in a document: it is the response validator that runs on every list
 * request, the type the DataTable consumes, and the contract the MCP server will read. An **empty
 * attribute is an absent key** — ADR-017's single definition of empty, so `city: null` and
 * `city: ''` never appear and no client has to decide which of the three means "no city".
 *
 * Select options travel by their stable `key`, never by uuid, so renaming an option is free and a
 * saved filter written last month still resolves.
 */
import { z } from 'zod'

import {
  CivilDateSchema,
  DecimalStringSchema,
  IsoDateTimeSchema,
  ObjectTypeSchema,
  SlugSchema,
  UuidSchema,
  AttributeTypeSchema,
} from './primitives.ts'

export const OptionRefSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** A design-system token name, never a hex value (ADR-056). */
  color: z.string().nullable(),
})

export type OptionRef = z.output<typeof OptionRefSchema>

/**
 * One end of a relation, as it is *read*.
 *
 * Deliberately not the `RelationRef` of `attributes/types/relation.ts`: that one is the *write*
 * shape and carries an id and link metadata only. This one also carries the label and object type,
 * which the read path joins in from `record.display_label`, because a chip has to render before
 * the client has fetched the target.
 */
export const RelationValueSchema = z.object({
  id: UuidSchema,
  label: z.string(),
  objectType: ObjectTypeSchema,
  title: z.string().nullable(),
  from: CivilDateSchema.nullable(),
  /** `null` means current — §4.3's open-ended job. */
  to: CivilDateSchema.nullable(),
  isPrimary: z.boolean(),
})

export type RelationValue = z.output<typeof RelationValueSchema>

export const AttributeValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('short_text'), value: z.string() }),
  z.object({ type: z.literal('long_text'), value: z.string() }),
  z.object({
    type: z.literal('number'),
    value: DecimalStringSchema,
    unit: z.string().optional(),
  }),
  z.object({ type: z.literal('date'), value: CivilDateSchema }),
  z.object({ type: z.literal('yes_no'), value: z.boolean() }),
  z.object({ type: z.literal('single_select'), value: OptionRefSchema }),
  z.object({ type: z.literal('multi_select'), value: z.array(OptionRefSchema) }),
  z.object({ type: z.literal('tags'), value: z.array(z.string()) }),
  z.object({ type: z.literal('url'), value: z.string() }),
  z.object({ type: z.literal('email'), value: z.string() }),
  /** E.164 when the number could be parsed; whatever the user typed when it could not. */
  z.object({ type: z.literal('phone'), value: z.string() }),
  z.object({ type: z.literal('relation'), value: z.array(RelationValueSchema) }),
])

export type AttributeValue = z.output<typeof AttributeValueSchema>

export const AttributesSchema = z.record(SlugSchema, AttributeValueSchema)

export type Attributes = z.output<typeof AttributesSchema>

/**
 * The write side of the same map.
 *
 * The value shape is per-attribute and therefore not knowable at schema-compile time: a `tags`
 * attribute takes `string[]`, a `single_select` takes an option key, a `relation` takes
 * `{ id, title?, from?, to?, isPrimary? }[]`. The API validates each entry against the schema its
 * own definition produces (`typeDef(type).value(config, ctx)`) and reports failures per field, so
 * "never hard-code a column" holds at the request boundary too. `null` clears the attribute.
 */
export const AttributeWriteSchema = z.record(SlugSchema, z.unknown())

export type AttributeWrite = z.output<typeof AttributeWriteSchema>

export const AttributeOptionSchema = z.object({
  id: UuidSchema,
  key: z.string(),
  label: z.string(),
  color: z.string().nullable(),
  position: z.int(),
  archivedAt: IsoDateTimeSchema.nullable(),
})

/** §6.7's attributes table, and the payload the DataTable's column factory is built from. */
export const AttributeDefinitionSchema = z.object({
  id: UuidSchema,
  objectType: ObjectTypeSchema,
  title: z.string(),
  slug: SlugSchema,
  type: AttributeTypeSchema,
  config: z.record(z.string(), z.unknown()),
  options: z.array(AttributeOptionSchema),
  group: z.string().nullable(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  isMulti: z.boolean(),
  isDerived: z.boolean(),
  sortable: z.boolean(),
  position: z.int(),
  showByDefault: z.boolean(),
  /** §6.7's "Used in" column. */
  recordCount: z.int(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})

export type AttributeDefinitionDto = z.output<typeof AttributeDefinitionSchema>

export const OptionDraftSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  color: z.string().max(32).nullish(),
  position: z.int().min(0).optional(),
})

export const CreateAttributeDefinitionSchema = z.object({
  objectType: ObjectTypeSchema,
  title: z.string().trim().min(1).max(120),
  /** Immutable after creation (§4.2); `updateAttributeDefinition` refuses to change it. */
  slug: z.string().min(1).max(63),
  type: AttributeTypeSchema,
  config: z.record(z.string(), z.unknown()).optional(),
  group: z.string().trim().max(120).nullish(),
  description: z.string().trim().max(2000).nullish(),
  position: z.int().min(0).optional(),
  showByDefault: z.boolean().optional(),
  /** Required, and non-empty, for `single_select` and `multi_select` (ADR-038). */
  options: z.array(OptionDraftSchema).max(200).optional(),
})

export type CreateAttributeDefinition = z.output<typeof CreateAttributeDefinitionSchema>

/** `type` and `slug` are absent on purpose: §4.2 makes both immutable and the database agrees. */
export const UpdateAttributeDefinitionSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  group: z.string().trim().max(120).nullish(),
  description: z.string().trim().max(2000).nullish(),
  position: z.int().min(0).optional(),
  showByDefault: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  /** Options may be added and relabelled here; removing one goes through the archive path. */
  options: z
    .array(OptionDraftSchema.extend({ id: UuidSchema.optional() }))
    .max(200)
    .optional(),
})

export type UpdateAttributeDefinition = z.output<typeof UpdateAttributeDefinitionSchema>

/** §5.4: the destructive confirmation states the consequence in numbers before it is offered. */
export const DeleteAttributePreviewSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  objectType: ObjectTypeSchema,
  recordCount: z.int(),
  isSystem: z.boolean(),
  message: z.string(),
})
