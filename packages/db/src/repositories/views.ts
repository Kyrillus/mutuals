/**
 * §6.6's saved views: the five reads and writes the API needs, and nothing else.
 *
 * A view is a named snapshot of `(filters, sort, columns)` (ADR-048). None of the three is
 * interpreted here — the filter set is compiled by `filter/compile.ts` when a *list* runs, and a
 * view is only ever the thing that put it in the URL.
 */
import { sql } from 'kysely'
import type { Filter, ObjectType, SortRequest, Uuid } from '@mutuals/core'

import type { Executor } from '../write/types.ts'
import { isoOf } from './coerce.ts'
import { resolveWorkspaceId } from '../write/workspace.ts'

export interface SavedViewRow {
  readonly id: Uuid
  readonly objectType: ObjectType
  readonly name: string
  readonly isDefault: boolean
  readonly columns: readonly string[]
  readonly filters: readonly Filter[]
  readonly sort: SortRequest | null
  readonly position: number
  readonly createdAt: string
  readonly updatedAt: string
}

interface Raw {
  id: string
  object_type: ObjectType
  name: string
  is_default: boolean
  columns: unknown
  filters: unknown
  sort: unknown
  position: number
  created_at: Date | string
  updated_at: Date | string
}

function toView(row: Raw): SavedViewRow {
  return {
    id: row.id,
    objectType: row.object_type,
    name: row.name,
    isDefault: row.is_default,
    columns: Array.isArray(row.columns) ? (row.columns as string[]) : [],
    filters: Array.isArray(row.filters) ? (row.filters as Filter[]) : [],
    sort: (row.sort ?? null) as SortRequest | null,
    position: row.position,
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
  }
}

export async function listViews(exec: Executor, objectType?: ObjectType): Promise<SavedViewRow[]> {
  let query = exec.selectFrom('saved_view').selectAll()
  if (objectType !== undefined) query = query.where('object_type', '=', objectType)
  const rows = await query.orderBy('position').orderBy('name').execute()
  return rows.map((row) => toView(row as Raw))
}

export async function getView(exec: Executor, id: Uuid): Promise<SavedViewRow | undefined> {
  const row = await exec
    .selectFrom('saved_view')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  return row === undefined ? undefined : toView(row)
}

export interface SavedViewInput {
  readonly objectType: ObjectType
  readonly name: string
  readonly columns: readonly string[]
  readonly filters: readonly Filter[]
  readonly sort: SortRequest | null
  readonly isDefault?: boolean
  readonly workspaceId?: string | null
}

/**
 * `sv_default_uq` is a partial unique index over `is_default`, so promoting a view has to demote the
 * incumbent in the same transaction. Doing it the other way round — insert then demote — trips the
 * index rather than replacing the default.
 */
async function clearDefault(
  exec: Executor,
  objectType: ObjectType,
  exceptId?: Uuid,
): Promise<void> {
  let query = exec
    .updateTable('saved_view')
    .set({ is_default: false, updated_at: new Date() })
    .where('object_type', '=', objectType)
    .where('is_default', '=', true)
  if (exceptId !== undefined) query = query.where('id', '!=', exceptId)
  await query.execute()
}

export async function createView(exec: Executor, input: SavedViewInput): Promise<Uuid> {
  return exec.transaction().execute(async (trx) => {
    if (input.isDefault === true) await clearDefault(trx, input.objectType)

    const next = await sql<{ position: number }>`
      select coalesce(max(position), -1) + 1 as position
        from saved_view where object_type = ${input.objectType}
    `.execute(trx)

    const row = await trx
      .insertInto('saved_view')
      .values({
        workspace_id: await resolveWorkspaceId(trx, input.workspaceId),
        object_type: input.objectType,
        name: input.name,
        is_default: input.isDefault ?? false,
        columns: JSON.stringify(input.columns),
        filters: JSON.stringify(input.filters),
        sort: input.sort === null ? null : JSON.stringify(input.sort),
        position: next.rows[0]?.position ?? 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    return row.id
  })
}

export interface SavedViewPatch {
  readonly name?: string
  readonly columns?: readonly string[]
  readonly filters?: readonly Filter[]
  readonly sort?: SortRequest | null
  readonly isDefault?: boolean
  readonly position?: number
}

export async function updateView(exec: Executor, id: Uuid, patch: SavedViewPatch): Promise<void> {
  await exec.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('saved_view')
      .select(['object_type'])
      .where('id', '=', id)
      .executeTakeFirst()
    if (existing === undefined) return

    if (patch.isDefault === true) await clearDefault(trx, existing.object_type, id)

    await trx
      .updateTable('saved_view')
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.columns === undefined ? {} : { columns: JSON.stringify(patch.columns) }),
        ...(patch.filters === undefined ? {} : { filters: JSON.stringify(patch.filters) }),
        ...(patch.sort === undefined
          ? {}
          : { sort: patch.sort === null ? null : JSON.stringify(patch.sort) }),
        ...(patch.isDefault === undefined ? {} : { is_default: patch.isDefault }),
        ...(patch.position === undefined ? {} : { position: patch.position }),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute()
  })
}

export async function deleteView(exec: Executor, id: Uuid): Promise<boolean> {
  const result = await exec.deleteFrom('saved_view').where('id', '=', id).executeTakeFirst()
  return Number(result.numDeletedRows ?? 0) > 0
}
