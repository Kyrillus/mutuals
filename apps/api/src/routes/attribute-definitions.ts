/**
 * Attribute definitions (§4.2, §6.7) — the heart of the product, as an API.
 *
 * Creating a field is one `INSERT` plus one per option. There is no DDL, no migration and no
 * restart: the next list request loads the new definition, the resolver puts it in the same
 * namespace as the system columns, and it is filterable and sortable immediately. That is the whole
 * bet of the typed-EAV design (ADR-013), and this file is where a user cashes it in.
 *
 * `slug` and `type` are immutable after creation (§4.2). `slug` because it is the machine name
 * every saved view and every URL is written against, `type` because the composite foreign key
 * `(attribute_id, value_kind, is_multi)` makes a change impossible while any value exists — so the
 * update schema simply has neither field.
 */
import {
  AttributeDefinitionSchema,
  CreateAttributeDefinitionSchema,
  DeleteAttributePreviewSchema,
  IdParamSchema,
  ObjectTypeSchema,
  UpdateAttributeDefinitionSchema,
  isAttributeType,
  issue,
  listResponseSchema,
  typeDef,
  validateSlug,
  type AttributeDefinition,
  type AttributeDefinitionDto,
  type CoreIssue,
} from '@mutuals/core'
import {
  addAttributeOption,
  createAttributeDefinition,
  deleteAttributeDefinition,
  getAttributeDefinition,
  listAttributeDefinitions,
  updateAttributeDefinition,
  updateAttributeOption,
  type JsonValue,
} from '@mutuals/db'
import { z } from 'zod'

import type { AppContext } from '../context.ts'
import { ApiError, validationFailed } from '../errors.ts'
import { ok200, ok200WithNotFound, created201 } from '../http/schema.ts'
import { routePlugin } from './shared.ts'

const DeleteResultSchema = z.object({ id: z.uuid(), deleted: z.literal(true) })

const SELECT_TYPES = new Set(['single_select', 'multi_select'])

export const attributeDefinitionRoutes = routePlugin((app, ctx) => {
  app.get(
    '/attribute-definitions',
    {
      schema: {
        operationId: 'listAttributeDefinitions',
        tags: ['attributes'],
        summary: 'Every user-defined field, with the "Used in N records" count',
        querystring: z.object({ objectType: ObjectTypeSchema.optional() }),
        response: ok200(listResponseSchema(AttributeDefinitionSchema)),
      },
    },
    async (request) => {
      const definitions = await listAttributeDefinitions(ctx.db, request.query.objectType)
      const counts = await usageCounts(
        ctx,
        definitions.map((definition) => definition.id),
      )
      return {
        data: definitions.map((definition) =>
          serialize(definition, counts.get(definition.id) ?? 0),
        ),
        // Settings lists tens of attributes, not thousands: it is one page by construction.
        page: { cursor: null, hasMore: false },
        meta: { total: definitions.length },
      }
    },
  )

  app.post(
    '/attribute-definitions',
    {
      schema: {
        operationId: 'createAttributeDefinition',
        tags: ['attributes'],
        summary: 'Create a field. No DDL runs; it is filterable and sortable on the next request.',
        body: CreateAttributeDefinitionSchema,
        response: created201(AttributeDefinitionSchema),
      },
    },
    async (request, reply) => {
      const body = request.body
      const objectType = body.objectType

      if (!isAttributeType(body.type)) {
        throw validationFailed([
          issue('invalid_input', `"${body.type}" is not an attribute type.`, ['type']),
        ])
      }

      const existing = await listAttributeDefinitions(ctx.db, objectType)
      const slug = validateSlug(body.slug, {
        objectType,
        taken: new Set(existing.map((definition) => definition.slug)),
      })
      if (!slug.ok) throw validationFailed(slug.issues.map((entry) => onPath(entry, 'slug')))

      const config = parseConfig(body.type, body.config ?? {})
      const options = normaliseOptions(body.type, body.options ?? [])

      const created = await createAttributeDefinition(ctx.db, {
        objectType,
        title: body.title,
        slug: slug.value,
        type: body.type,
        config,
        group: body.group ?? null,
        description: body.description ?? null,
        ...(body.position === undefined ? {} : { position: body.position }),
        ...(body.showByDefault === undefined ? {} : { showByDefault: body.showByDefault }),
        options,
      })
      return reply.status(201).send(serialize(created, 0))
    },
  )

  app.patch(
    '/attribute-definitions/:id',
    {
      schema: {
        operationId: 'updateAttributeDefinition',
        tags: ['attributes'],
        summary:
          'Rename, regroup, reorder or reconfigure a field, and add or relabel select options. ' +
          '`slug` and `type` are immutable and are not accepted.',
        params: IdParamSchema,
        body: UpdateAttributeDefinitionSchema,
        response: ok200WithNotFound(AttributeDefinitionSchema),
      },
    },
    async (request) => {
      const id = request.params.id
      const current = await getAttributeDefinition(ctx.db, id)
      if (current === undefined) throw notFoundAttribute(id)

      const body = request.body
      const config = body.config === undefined ? undefined : parseConfig(current.type, body.config)

      await updateAttributeDefinition(ctx.db, id, {
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.group === undefined ? {} : { group: body.group ?? null }),
        ...(body.description === undefined ? {} : { description: body.description ?? null }),
        ...(body.position === undefined ? {} : { position: body.position }),
        ...(body.showByDefault === undefined ? {} : { showByDefault: body.showByDefault }),
        ...(config === undefined ? {} : { config }),
      })

      for (const option of body.options ?? []) {
        if (option.id === undefined) {
          await addAttributeOption(ctx.db, id, {
            key: option.key,
            label: option.label,
            color: option.color ?? null,
            ...(option.position === undefined ? {} : { position: option.position }),
          })
          continue
        }
        // An option's `key` is its stable identity and is never rewritten; the label and colour
        // are what §6.7 lets a user change, and history keeps rendering either way.
        await updateAttributeOption(ctx.db, option.id, {
          label: option.label,
          color: option.color ?? null,
          ...(option.position === undefined ? {} : { position: option.position }),
        })
      }

      const updated = await getAttributeDefinition(ctx.db, id)
      if (updated === undefined) throw notFoundAttribute(id)
      const counts = await usageCounts(ctx, [id])
      return serialize(updated, counts.get(id) ?? 0)
    },
  )

  app.get(
    '/attribute-definitions/:id/delete-preview',
    {
      schema: {
        operationId: 'previewDeleteAttributeDefinition',
        tags: ['attributes'],
        summary: "§5.4's confirmation, stated in numbers before the button is offered",
        params: IdParamSchema,
        response: ok200WithNotFound(DeleteAttributePreviewSchema),
      },
    },
    async (request) => {
      const id = request.params.id
      const definition = await getAttributeDefinition(ctx.db, id)
      if (definition === undefined) throw notFoundAttribute(id)
      const counts = await usageCounts(ctx, [id])
      const used = counts.get(id) ?? 0
      return {
        id,
        title: definition.title,
        objectType: definition.objectType,
        recordCount: used,
        isSystem: definition.isSystem,
        message: confirmationMessage(definition, used),
      }
    },
  )

  app.delete(
    '/attribute-definitions/:id',
    {
      schema: {
        operationId: 'deleteAttributeDefinition',
        tags: ['attributes'],
        summary: 'Delete a field and every value of it. Facts, values and links cascade.',
        params: IdParamSchema,
        response: ok200WithNotFound(DeleteResultSchema),
      },
    },
    async (request) => {
      const id = request.params.id
      const definition = await getAttributeDefinition(ctx.db, id)
      if (definition === undefined) throw notFoundAttribute(id)
      if (definition.isSystem) {
        throw new ApiError({
          status: 409,
          code: 'conflict',
          title: 'Conflict',
          detail: `"${definition.title}" is a system attribute and cannot be deleted.`,
        })
      }
      await deleteAttributeDefinition(ctx.db, id)
      return { id, deleted: true as const }
    },
  )
})

/** §5.4: "This will delete 3 contacts and 12 interactions" — the consequence, in numbers. */
export function confirmationMessage(definition: AttributeDefinition, used: number): string {
  const noun = definition.objectType === 'contact' ? 'contact' : `${definition.objectType} record`
  if (used === 0) {
    return `This will delete "${definition.title}". No ${noun}s have a value.`
  }
  return `This will delete "${definition.title}" and its value on ${String(used)} ${noun}${
    used === 1 ? '' : 's'
  }.`
}

function serialize(definition: AttributeDefinition, recordCount: number): AttributeDefinitionDto {
  return {
    id: definition.id,
    objectType: definition.objectType,
    title: definition.title,
    slug: definition.slug,
    type: definition.type,
    config: definition.config ?? {},
    options: (definition.options ?? []).map((option) => ({
      id: option.id,
      key: option.key,
      label: option.label,
      color: option.color ?? null,
      position: option.position,
      archivedAt: option.archivedAt ?? null,
    })),
    group: definition.group ?? null,
    description: definition.description ?? null,
    isSystem: definition.isSystem,
    isMulti: definition.isMulti,
    isDerived: definition.isDerived,
    sortable: definition.sortable,
    position: definition.position,
    showByDefault: definition.showByDefault,
    recordCount,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  }
}

/**
 * "Used in N records" for a whole page, in two queries rather than two per attribute.
 *
 * Relations live in `record_link` and everything else in `attribute_value`, so both are counted;
 * an attribute is never both, so adding the two is not double counting.
 */
async function usageCounts(ctx: AppContext, ids: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (ids.length === 0) return counts

  const values = await ctx.db
    .selectFrom('attribute_value')
    .select((eb) => ['attribute_id', eb.fn.count<string>('record_id').distinct().as('used')])
    .where('attribute_id', 'in', [...ids])
    .groupBy('attribute_id')
    .execute()
  for (const row of values) counts.set(row.attribute_id, Number(row.used))

  const links = await ctx.db
    .selectFrom('record_link')
    .select((eb) => ['attribute_id', eb.fn.count<string>('from_record_id').distinct().as('used')])
    .where('attribute_id', 'in', [...ids])
    .groupBy('attribute_id')
    .execute()
  for (const row of links) {
    counts.set(row.attribute_id, (counts.get(row.attribute_id) ?? 0) + Number(row.used))
  }

  return counts
}

/** The type's own config schema is the validator; nothing here knows what a config contains. */
function parseConfig(type: string, raw: Record<string, unknown>): Record<string, JsonValue> {
  if (!isAttributeType(type)) {
    throw validationFailed([
      issue('invalid_input', `"${type}" is not an attribute type.`, ['type']),
    ])
  }
  const parsed = typeDef(type).configSchema.safeParse(raw)
  if (!parsed.success) {
    throw validationFailed(
      parsed.error.issues.map((entry) => ({
        code: 'invalid_input' as const,
        path: ['config', ...entry.path.map((segment) => String(segment))],
        message: entry.message,
      })),
    )
  }
  return parsed.data
}

/**
 * ADR-038: a select attribute must have at least one option.
 *
 * `z.enum([])` constructs happily in zod and then rejects every value with "Invalid option:
 * expected one of " — a field nobody can fill, reporting an error that names nothing. Refusing the
 * creation is what makes that state unreachable.
 */
function normaliseOptions(
  type: string,
  options: readonly { key: string; label: string; color?: string | null; position?: number }[],
): { key: string; label: string; color: string | null; position: number }[] {
  if (!SELECT_TYPES.has(type)) return []
  if (options.length === 0) {
    throw validationFailed([
      issue('required', 'A select field needs at least one option.', ['options']),
    ])
  }

  const issues: CoreIssue[] = []
  const keys = new Set<string>()
  const labels = new Set<string>()
  options.forEach((option, index) => {
    if (keys.has(option.key)) {
      issues.push(
        issue('duplicate_slug', `Two options share the key "${option.key}".`, [
          'options',
          index,
          'key',
        ]),
      )
    }
    if (labels.has(option.label)) {
      issues.push(
        issue('invalid_input', `Two options share the label "${option.label}".`, [
          'options',
          index,
          'label',
        ]),
      )
    }
    keys.add(option.key)
    labels.add(option.label)
  })
  if (issues.length > 0) throw validationFailed(issues)

  return options.map((option, index) => ({
    key: option.key,
    label: option.label,
    color: option.color ?? null,
    position: option.position ?? index,
  }))
}

function onPath(entry: CoreIssue, field: string): CoreIssue {
  return { ...entry, path: entry.path.length === 0 ? [field] : entry.path }
}

function notFoundAttribute(id: string): ApiError {
  return new ApiError({
    status: 404,
    code: 'not_found',
    title: 'Not found',
    detail: `There is no attribute definition with id ${id}.`,
  })
}
