/**
 * The two lookups every integration test needs before it can write anything.
 *
 * Migration 0002 seeds twenty-two attribute definitions with fixed uuids, and a test could paste
 * them. It does not: a test that names `00000001-…-000000000005` says nothing about what it is
 * testing, and it stops compiling the day the seed moves. Slug in, id out.
 */
import type { ObjectType, Uuid } from '@mutuals/core'
import { testDb } from './database.ts'

export async function attributeIdBySlug(objectType: ObjectType, slug: string): Promise<Uuid> {
  const row = await testDb()
    .selectFrom('attribute_definition')
    .select('id')
    .where('object_type', '=', objectType)
    .where('slug', '=', slug)
    .executeTakeFirst()
  if (row === undefined) throw new Error(`no seeded ${objectType} attribute "${slug}"`)
  return row.id
}

export async function optionIdByKey(attributeId: Uuid, key: string): Promise<Uuid> {
  const row = await testDb()
    .selectFrom('attribute_option')
    .select('id')
    .where('attribute_id', '=', attributeId)
    .where('key', '=', key)
    .executeTakeFirst()
  if (row === undefined) throw new Error(`no option "${key}" on attribute ${attributeId}`)
  return row.id
}
