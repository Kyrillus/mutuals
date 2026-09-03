/**
 * The attribute-definition repository: the one place a database row becomes the
 * `AttributeDefinition` that the API, the field resolver and the filter compiler all read.
 *
 * `is_multi`, `value_kind` and `sortable` are never taken from the caller — they are functions of
 * `type` and `config`, `packages/core`'s registry derives them, and the composite foreign key
 * `(attribute_id, value_kind, is_multi) → attribute_definition` makes a disagreement a write error
 * rather than a silently wrong column.
 */
import { sql } from 'kysely'
import {
  completeDefinition,
  isAttributeType,
  isMultiValued,
  VALUE_KIND_BY_ATTRIBUTE_TYPE,
  type AttributeDefinition,
  type AttributeOption,
  type AttributeType,
  type ObjectType,
  type Uuid,
} from '@mutuals/core'
import { WriteError, type Executor } from '../write/types.ts'
import { resolveWorkspaceId } from '../write/workspace.ts'
import { isoOf, isoOrNull } from './coerce.ts'
import type { JsonValue } from '../schema.ts'

/**
 * `attribute_definition` has no `show_by_default` column, so the flag lives under this key inside
 * `config` and is stripped before the config reaches a type's `configSchema`. It is only ever the
 * seed for a fresh view — what a user actually sees is `saved_view.columns` (ADR-048) — which is
 * why it did not earn a migration of its own.
 */
const SHOW_BY_DEFAULT_KEY = 'show_by_default'

interface DefinitionRow {
  id: string
  object_type: ObjectType
  title: string
  slug: string
  type: AttributeType
  config: JsonValue
  group_name: string | null
  description: string | null
  is_system: boolean
  is_multi: boolean
  position: number
  created_at: Date | string
  updated_at: Date | string
}

interface OptionRow {
  id: string
  attribute_id: string
  key: string
  label: string
  color: string | null
  position: number
  archived_at: Date | string | null
}

const DEFINITION_COLUMNS = [
  'id',
  'object_type',
  'title',
  'slug',
  'type',
  'config',
  'group_name',
  'description',
  'is_system',
  'is_multi',
  'position',
  'created_at',
  'updated_at',
] as const

function asObject(config: JsonValue): Record<string, JsonValue> {
  return config !== null && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, JsonValue>)
    : {}
}

/**
 * The stored config as `packages/core` expects it.
 *
 * Migration 0002 seeds the `organization` relation with `target_object_type` / `has_link_metadata`
 * and no `cardinality`, while `relation.configSchema` reads `targetObjectType`, `cardinality` and
 * `hasLinkMetadata` — and `cardinality` has no default, so parsing the seeded row throws. Rather
 * than let every read of the default attribute set fail, both spellings are accepted here and the
 * cardinality is taken from `is_multi`, which is the column the database actually enforces.
 */
function toCoreConfig(type: AttributeType, stored: JsonValue, isMulti: boolean): unknown {
  const raw = asObject(stored)
  const { [SHOW_BY_DEFAULT_KEY]: _shown, ...rest } = raw
  if (type !== 'relation') return rest

  return {
    ...rest,
    targetObjectType: rest['targetObjectType'] ?? rest['target_object_type'],
    cardinality: rest['cardinality'] ?? (isMulti ? 'many' : 'one'),
    hasLinkMetadata: rest['hasLinkMetadata'] ?? rest['has_link_metadata'] ?? false,
  }
}

function toOption(row: OptionRow): AttributeOption {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    position: row.position,
    archivedAt: isoOrNull(row.archived_at),
    ...(row.color === null ? {} : { color: row.color }),
  }
}

function toDefinition(
  row: DefinitionRow,
  options: readonly AttributeOption[],
): AttributeDefinition {
  const config = toCoreConfig(row.type, row.config, row.is_multi)
  const shown = asObject(row.config)[SHOW_BY_DEFAULT_KEY]

  return completeDefinition(
    {
      id: row.id,
      objectType: row.object_type,
      title: row.title,
      slug: row.slug,
      type: row.type,
      config,
      isSystem: row.is_system,
      position: row.position,
      showByDefault: shown === false ? false : true,
      ...(options.length === 0 ? {} : { options }),
      ...(row.group_name === null ? {} : { group: row.group_name }),
      ...(row.description === null ? {} : { description: row.description }),
    },
    { createdAt: isoOf(row.created_at), updatedAt: isoOf(row.updated_at) },
  )
}

async function optionsByAttribute(
  exec: Executor,
  attributeIds: readonly string[],
): Promise<Map<string, AttributeOption[]>> {
  const byAttribute = new Map<string, AttributeOption[]>()
  if (attributeIds.length === 0) return byAttribute

  const rows = await exec
    .selectFrom('attribute_option')
    .select(['id', 'attribute_id', 'key', 'label', 'color', 'position', 'archived_at'])
    .where('attribute_id', 'in', [...new Set(attributeIds)])
    .orderBy('attribute_id')
    .orderBy('position')
    .execute()

  for (const row of rows) {
    const list = byAttribute.get(row.attribute_id) ?? []
    list.push(toOption(row))
    byAttribute.set(row.attribute_id, list)
  }
  return byAttribute
}

export async function listAttributeDefinitions(
  exec: Executor,
  objectType?: ObjectType,
): Promise<AttributeDefinition[]> {
  let query = exec.selectFrom('attribute_definition').select(DEFINITION_COLUMNS)
  if (objectType !== undefined) query = query.where('object_type', '=', objectType)
  const rows = await query.orderBy('position').orderBy('id').execute()

  const options = await optionsByAttribute(
    exec,
    rows.map((row) => row.id),
  )
  return rows.map((row) => toDefinition(row, options.get(row.id) ?? []))
}

export async function getAttributeDefinition(
  exec: Executor,
  id: Uuid,
): Promise<AttributeDefinition | undefined> {
  const row = await exec
    .selectFrom('attribute_definition')
    .select(DEFINITION_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst()
  if (row === undefined) return undefined
  const options = await optionsByAttribute(exec, [row.id])
  return toDefinition(row, options.get(row.id) ?? [])
}

export async function getAttributeDefinitionBySlug(
  exec: Executor,
  objectType: ObjectType,
  slug: string,
): Promise<AttributeDefinition | undefined> {
  const row = await exec
    .selectFrom('attribute_definition')
    .select(DEFINITION_COLUMNS)
    .where('object_type', '=', objectType)
    .where('slug', '=', slug)
    .executeTakeFirst()
  if (row === undefined) return undefined
  const options = await optionsByAttribute(exec, [row.id])
  return toDefinition(row, options.get(row.id) ?? [])
}

export interface OptionDraft {
  readonly key: string
  readonly label: string
  readonly color?: string | null
  readonly position?: number
}

export interface AttributeDefinitionDraftInput {
  readonly objectType: ObjectType
  readonly title: string
  readonly slug: string
  readonly type: AttributeType
  readonly config?: Record<string, JsonValue>
  readonly group?: string | null
  readonly description?: string | null
  readonly position?: number
  readonly showByDefault?: boolean
  readonly options?: readonly OptionDraft[]
  readonly workspaceId?: string | null
}

function storedConfig(
  config: Record<string, JsonValue> | undefined,
  showByDefault: boolean | undefined,
): JsonValue {
  const base: Record<string, JsonValue> = { ...(config ?? {}) }
  if (showByDefault === false) base[SHOW_BY_DEFAULT_KEY] = false
  return base
}

/** §4.2: creating an attribute is one `INSERT`, plus one per option. No DDL, ever. */
export async function createAttributeDefinition(
  exec: Executor,
  input: AttributeDefinitionDraftInput,
): Promise<AttributeDefinition> {
  // The parameter is typed, but this function is also the landing point for JSON off the wire,
  // so the guard is real. `input.type` narrows to `never` in this branch, hence the widening.
  if (!isAttributeType(input.type)) {
    throw new WriteError(`unknown attribute type ${String(input.type)}`)
  }

  return exec.transaction().execute(async (trx) => {
    const workspaceId = await resolveWorkspaceId(trx, input.workspaceId)
    const isMulti = isMultiValued(
      input.type,
      toCoreConfig(input.type, storedConfig(input.config, true), false),
    )

    const inserted = await trx
      .insertInto('attribute_definition')
      .values({
        workspace_id: workspaceId,
        object_type: input.objectType,
        title: input.title,
        slug: input.slug,
        type: input.type,
        value_kind: VALUE_KIND_BY_ATTRIBUTE_TYPE[input.type],
        is_multi: isMulti,
        config: storedConfig(input.config, input.showByDefault),
        group_name: input.group ?? null,
        description: input.description ?? null,
        position: input.position ?? (await nextPosition(trx, input.objectType)),
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    const options = input.options ?? []
    if (options.length > 0) {
      await trx
        .insertInto('attribute_option')
        .values(
          options.map((option, index) => ({
            workspace_id: workspaceId,
            attribute_id: inserted.id,
            key: option.key,
            label: option.label,
            color: option.color ?? null,
            position: option.position ?? index,
          })),
        )
        .execute()
    }

    const created = await getAttributeDefinition(trx, inserted.id)
    if (created === undefined) throw new WriteError('the definition vanished mid-transaction')
    return created
  })
}

async function nextPosition(exec: Executor, objectType: ObjectType): Promise<number> {
  const row = await exec
    .selectFrom('attribute_definition')
    .select((eb) => eb.fn.max('position').as('max_position'))
    .where('object_type', '=', objectType)
    .executeTakeFirst()
  return (row?.max_position ?? -1) + 1
}

export interface AttributeDefinitionPatch {
  readonly title?: string
  readonly group?: string | null
  readonly description?: string | null
  readonly position?: number
  readonly showByDefault?: boolean
  readonly config?: Record<string, JsonValue>
}

/**
 * `type` and `slug` are absent on purpose: §4.2 makes both immutable, and the composite FK means
 * a type change would be rejected by the database anyway while any value exists.
 */
export async function updateAttributeDefinition(
  exec: Executor,
  id: Uuid,
  patch: AttributeDefinitionPatch,
): Promise<AttributeDefinition | undefined> {
  const current = await exec
    .selectFrom('attribute_definition')
    .select(['config'])
    .where('id', '=', id)
    .executeTakeFirst()
  if (current === undefined) return undefined

  const merged: Record<string, JsonValue> = {
    ...asObject(current.config),
    ...(patch.config ?? {}),
  }
  if (patch.showByDefault === true) delete merged[SHOW_BY_DEFAULT_KEY]
  if (patch.showByDefault === false) merged[SHOW_BY_DEFAULT_KEY] = false

  await exec
    .updateTable('attribute_definition')
    .set({
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.group === undefined ? {} : { group_name: patch.group }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.position === undefined ? {} : { position: patch.position }),
      config: merged,
      updated_at: new Date(),
    })
    .where('id', '=', id)
    .execute()

  return getAttributeDefinition(exec, id)
}

/** §6.7's confirmation dialog reads this before it offers the button. Index-backed by `av_attr_rec_idx`. */
export async function countRecordsUsingAttribute(exec: Executor, id: Uuid): Promise<number> {
  const value = await exec
    .selectFrom('attribute_value')
    .select((eb) => eb.fn.count<string>('record_id').distinct().as('used'))
    .where('attribute_id', '=', id)
    .executeTakeFirst()
  const link = await exec
    .selectFrom('record_link')
    .select((eb) => eb.fn.count<string>('from_record_id').distinct().as('used'))
    .where('attribute_id', '=', id)
    .executeTakeFirst()
  return Number(value?.used ?? 0) + Number(link?.used ?? 0)
}

/** One `DELETE`; `fact`, `attribute_value`, `record_link` and `attribute_option` cascade. */
export async function deleteAttributeDefinition(exec: Executor, id: Uuid): Promise<boolean> {
  const result = await exec
    .deleteFrom('attribute_definition')
    .where('id', '=', id)
    .executeTakeFirst()
  return Number(result.numDeletedRows) > 0
}

/** A drag-reorder in Settings: one statement per row, one transaction, positions 0..n-1. */
export async function reorderAttributeDefinitions(
  exec: Executor,
  orderedIds: readonly Uuid[],
): Promise<void> {
  await exec.transaction().execute(async (trx) => {
    for (const [position, id] of orderedIds.entries()) {
      await trx
        .updateTable('attribute_definition')
        .set({ position, updated_at: new Date() })
        .where('id', '=', id)
        .execute()
    }
  })
}

async function nextOptionPosition(exec: Executor, attributeId: Uuid): Promise<number> {
  const row = await exec
    .selectFrom('attribute_option')
    .select((eb) => eb.fn.max('position').as('max_position'))
    .where('attribute_id', '=', attributeId)
    .executeTakeFirst()
  return (row?.max_position ?? -1) + 1
}

export async function addAttributeOption(
  exec: Executor,
  attributeId: Uuid,
  option: OptionDraft,
): Promise<AttributeOption> {
  const row = await exec
    .insertInto('attribute_option')
    .values({
      workspace_id: await resolveWorkspaceId(exec),
      attribute_id: attributeId,
      key: option.key,
      label: option.label,
      color: option.color ?? null,
      position: option.position ?? (await nextOptionPosition(exec, attributeId)),
    })
    .returning(['id', 'attribute_id', 'key', 'label', 'color', 'position', 'archived_at'])
    .executeTakeFirstOrThrow()

  return toOption(row)
}

export interface OptionPatch {
  readonly label?: string
  readonly color?: string | null
  readonly position?: number
}

export async function updateAttributeOption(
  exec: Executor,
  id: Uuid,
  patch: OptionPatch,
): Promise<boolean> {
  const columns = {
    ...(patch.label === undefined ? {} : { label: patch.label }),
    ...(patch.color === undefined ? {} : { color: patch.color }),
    ...(patch.position === undefined ? {} : { position: patch.position }),
  }
  if (Object.keys(columns).length === 0) return false
  const result = await exec
    .updateTable('attribute_option')
    .set(columns)
    .where('id', '=', id)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0
}

/**
 * §6.7: an option in use is archived, never deleted — it disappears from pickers while history
 * still renders its label. A hard `DELETE` succeeds only for a genuinely unused option, which the
 * `ON DELETE RESTRICT` on `fact.option_id` proves.
 */
export async function archiveAttributeOption(
  exec: Executor,
  id: Uuid,
  archivedAt: Date | string,
): Promise<boolean> {
  const result = await exec
    .updateTable('attribute_option')
    .set({ archived_at: archivedAt })
    .where('id', '=', id)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0
}

/** The unique on `(attribute_id, position)` is `DEFERRABLE`, so a whole reorder is one transaction. */
export async function reorderAttributeOptions(
  exec: Executor,
  orderedIds: readonly Uuid[],
): Promise<void> {
  await exec.transaction().execute(async (trx) => {
    // `ao_pos_uq` is a full UNIQUE constraint precisely so it can be deferred: a drag-reorder
    // passes through states where two options share a position, and a partial unique index could
    // not have allowed that. Saying it here keeps the reason at the call site.
    await sql`set constraints ao_pos_uq deferred`.execute(trx)
    for (const [position, id] of orderedIds.entries()) {
      await trx.updateTable('attribute_option').set({ position }).where('id', '=', id).execute()
    }
  })
}
