/**
 * Find-or-create for organizations.
 *
 * The rule under test is that matching is exact on the normalised label. Most of these cases are
 * therefore about what it deliberately does *not* join — the pairs a fuzzy rule would merge, which
 * for company names are the ones a person would want kept apart.
 */
import { describe, expect, it } from 'vitest'
import type { Uuid } from '@mutuals/core'

import { testDb } from '../test-support/index.ts'
import { createOrganization } from './records.ts'
import { resolveOrganization, resolveOrganizations } from './organizations.ts'

async function labelOf(id: Uuid): Promise<string> {
  const row = await testDb()
    .selectFrom('record')
    .select('display_label')
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return row.display_label
}

async function countNamed(label: string): Promise<number> {
  const rows = await testDb()
    .selectFrom('record')
    .select('id')
    .where('object_type', '=', 'organization')
    .where('display_label', '=', label)
    .execute()
  return rows.length
}

describe('resolveOrganizations', () => {
  it('creates one that does not exist, and keeps the file’s own spelling', async () => {
    const resolved = await resolveOrganizations(testDb(), { names: ['Northstar Ventures'] })
    const id = resolved.byKey.get(resolved.keys[0] as string)
    expect(id).toBeDefined()
    expect(await labelOf(id as Uuid)).toBe('Northstar Ventures')
    expect(resolved.created).toHaveLength(1)
  })

  it('finds one that already exists rather than creating a second', async () => {
    const existing = await createOrganization(testDb(), { name: 'Bright Angle' })
    const resolved = await resolveOrganizations(testDb(), { names: ['Bright Angle'] })
    expect(resolved.byKey.get(resolved.keys[0] as string)).toBe(existing)
    expect(resolved.created).toEqual([])
  })

  /** Thirty rows at one company must not create thirty organizations. */
  it('collapses repeated names within one batch to a single record', async () => {
    const names = Array.from({ length: 12 }, () => 'Kiln Robotics')
    const resolved = await resolveOrganizations(testDb(), { names })
    expect(resolved.created).toHaveLength(1)
    expect(new Set(resolved.keys).size).toBe(1)
    expect(await countNamed('Kiln Robotics')).toBe(1)
  })

  it('matches through case and accent folding, because the label column is normalised', async () => {
    const existing = await createOrganization(testDb(), { name: 'Café Grün' })
    const resolved = await resolveOrganizations(testDb(), {
      names: ['CAFE GRUN', 'café grün', '  Café Grün  '],
    })
    expect(resolved.created).toEqual([])
    for (const key of resolved.keys) expect(resolved.byKey.get(key)).toBe(existing)
  })

  /**
   * The asymmetry with contact matching, stated as tests. A fuzzy rule would join every pair below,
   * and each is plausibly two different organizations — so the import creates both and §6.9's merge
   * is where a person decides.
   */
  it('does not join names that merely look alike', async () => {
    await createOrganization(testDb(), { name: 'Meyer Schulz' })
    await createOrganization(testDb(), { name: 'Kiln Robotics' })

    const resolved = await resolveOrganizations(testDb(), {
      names: ['Meyer, Schulz & Partner', 'Kiln Robotics GmbH'],
    })
    expect(resolved.created).toHaveLength(2)
    expect(await countNamed('Meyer, Schulz & Partner')).toBe(1)
    expect(await countNamed('Meyer Schulz')).toBe(1)
  })

  it('ignores blank names instead of creating an organization with no label', async () => {
    const resolved = await resolveOrganizations(testDb(), { names: ['', '   ', 'Palet'] })
    expect(resolved.created).toHaveLength(1)
    expect(resolved.keys[0]).toBe('')
    expect(resolved.byKey.get('')).toBeUndefined()
  })

  it('attributes what it creates to the batch it came from', async () => {
    const batch = await testDb()
      .insertInto('import_batch')
      .values({ file_name: 'linkedin.csv', object_type: 'contact' })
      .returning('id')
      .executeTakeFirstOrThrow()

    const resolved = await resolveOrganizations(testDb(), {
      names: ['Fjord Ledger'],
      importBatchId: batch.id,
      provenance: { source: 'import', sourceRef: batch.id },
    })

    const row = await testDb()
      .selectFrom('record')
      .select(['created_via', 'import_batch_id'])
      .where('id', '=', resolved.created[0] as Uuid)
      .executeTakeFirstOrThrow()
    expect(row.created_via).toBe('import')
    expect(row.import_batch_id).toBe(batch.id)
  })

  /** Re-importing the same export must point at the same record, not at a newer duplicate. */
  it('prefers the oldest record when duplicates already exist', async () => {
    const first = await createOrganization(testDb(), { name: 'Palet' })
    await createOrganization(testDb(), { name: 'Palet' })

    expect(await resolveOrganization(testDb(), 'Palet')).toBe(first)
    expect(await resolveOrganization(testDb(), 'palet')).toBe(first)
  })

  it('answers nothing for an empty request', async () => {
    const resolved = await resolveOrganizations(testDb(), { names: [] })
    expect(resolved.keys).toEqual([])
    expect(resolved.created).toEqual([])
    expect(await resolveOrganization(testDb(), '  ')).toBeUndefined()
  })
})
