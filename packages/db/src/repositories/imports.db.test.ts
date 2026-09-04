/**
 * The wizard's staging tables.
 *
 * Most of this is straightforward CRUD and is tested for the boring reason that the Review grid's
 * toolbar is built on it. The parts worth reading are the four counters, which are one statement
 * and easy to get subtly wrong, and find-and-replace, which is real SQL over jsonb and has three
 * ways to be dangerous: a regex metacharacter in the needle, a non-string cell, and a needle that
 * matches in the `WHERE` but not in the replacement.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Uuid } from '@mutuals/core'

import { testDb } from '../test-support/index.ts'
import { createContact } from '../write/records.ts'
import {
  addImportCounts,
  countImportRows,
  createImportBatch,
  getImportBatch,
  listImportRows,
  replaceInImportBatch,
  setDuplicateDecisions,
  setRowDuplicates,
  stageImportRows,
  updateImportBatch,
  updateImportRow,
} from './imports.ts'

let batch: Uuid

beforeEach(async () => {
  batch = await createImportBatch(testDb(), {
    fileName: 'linkedin_connections_sample.csv',
    objectType: 'contact',
    mapping: { source: 'linkedin' },
  })
})

async function stage(): Promise<void> {
  await stageImportRows(testDb(), batch, [
    {
      rowNumber: 1,
      raw: { 'First Name': 'Anna' },
      mapped: { first_name: 'Anna', last_name: 'Berger', city: 'Munich' },
      errors: [],
    },
    {
      rowNumber: 2,
      raw: { 'First Name': 'Ana' },
      mapped: { first_name: 'Ana', last_name: 'Silva', city: 'Munich' },
      errors: [{ code: 'invalid_email', path: ['email'], message: 'not an email' }],
    },
    {
      rowNumber: 3,
      raw: { 'First Name': 'Jonas' },
      mapped: { first_name: 'Jonas', last_name: 'Weber', pinned_important: true },
      errors: [],
    },
  ])
}

describe('the batch', () => {
  it('starts in parsing with everything at zero', async () => {
    const row = await getImportBatch(testDb(), batch)
    expect(row).toMatchObject({
      fileName: 'linkedin_connections_sample.csv',
      objectType: 'contact',
      status: 'parsing',
      rowCount: 0,
      lastCommittedRow: 0,
      createdCount: 0,
      mergedCount: 0,
      skippedCount: 0,
      errorDetail: null,
    })
    expect(row?.mapping).toEqual({ source: 'linkedin' })
  })

  it('records the row count when the rows are staged', async () => {
    await stage()
    expect((await getImportBatch(testDb(), batch))?.rowCount).toBe(3)
  })

  it('moves through its states and can carry a failure', async () => {
    await updateImportBatch(testDb(), batch, { status: 'reviewing' })
    expect((await getImportBatch(testDb(), batch))?.status).toBe('reviewing')

    await updateImportBatch(testDb(), batch, {
      status: 'failed',
      lastCommittedRow: 12,
      errorDetail: { message: 'connection lost' },
    })
    const failed = await getImportBatch(testDb(), batch)
    expect(failed).toMatchObject({ status: 'failed', lastCommittedRow: 12 })
    expect(failed?.errorDetail).toEqual({ message: 'connection lost' })
  })

  /**
   * ADR-061 commits in chunks, so the counters are incremented per chunk. Read-add-write would lose
   * a chunk on any interleaving, and a failed import's result screen has to say how many rows landed
   * before it stopped.
   */
  it('adds to the counters without reading them first', async () => {
    await addImportCounts(testDb(), batch, { created: 400, skipped: 3, lastCommittedRow: 403 })
    await addImportCounts(testDb(), batch, { created: 400, merged: 2, lastCommittedRow: 805 })
    expect(await getImportBatch(testDb(), batch)).toMatchObject({
      createdCount: 800,
      mergedCount: 2,
      skippedCount: 3,
      lastCommittedRow: 805,
    })
  })

  it('answers nothing for a batch that does not exist', async () => {
    expect(await getImportBatch(testDb(), '00000000-0000-4000-8000-00000000dead')).toBeUndefined()
  })
})

describe('the rows', () => {
  beforeEach(stage)

  it('come back in row order', async () => {
    const rows = await listImportRows(testDb(), batch)
    expect(rows.map((row) => row.rowNumber)).toEqual([1, 2, 3])
    expect(rows[0]?.mapped).toEqual({ first_name: 'Anna', last_name: 'Berger', city: 'Munich' })
  })

  it('can be narrowed to the error rows, which is step 4s second tab', async () => {
    const rows = await listImportRows(testDb(), batch, { onlyErrors: true })
    expect(rows.map((row) => row.rowNumber)).toEqual([2])
  })

  it('can be narrowed to a resume point', async () => {
    const rows = await listImportRows(testDb(), batch, { fromRow: 3 })
    expect(rows.map((row) => row.rowNumber)).toEqual([3])
  })

  it('takes an edit to one cell and a decision', async () => {
    expect(
      await updateImportRow(testDb(), batch, 2, {
        mapped: { first_name: 'Ana', last_name: 'Silva', email: 'ana@orchard.example' },
        errors: [],
        decision: 'create',
      }),
    ).toBe(true)

    const [row] = await listImportRows(testDb(), batch, { fromRow: 2, limit: 1 })
    expect(row?.errors).toEqual([])
    expect(row?.decision).toBe('create')
  })

  it('reports an edit to a row that is not there rather than pretending', async () => {
    expect(await updateImportRow(testDb(), batch, 99, { errors: [] })).toBe(false)
    expect(await updateImportRow(testDb(), batch, 1, {})).toBe(false)
  })
})

describe('the counters the Review header shows', () => {
  beforeEach(stage)

  it('counts rows, errors, duplicates and undecided duplicates in one statement', async () => {
    const anna = await createContact(testDb(), { firstName: 'Anna', lastName: 'Berger' })
    await setRowDuplicates(testDb(), batch, [
      { rowNumber: 1, duplicateOf: anna, detail: { band: 'certain', confidence: 0.97 } },
      { rowNumber: 3, duplicateOfRow: 1, detail: { band: 'possible', confidence: 0.7 } },
    ])

    expect(await countImportRows(testDb(), batch)).toEqual({
      total: 3,
      withErrors: 1,
      duplicates: 2,
      undecidedDuplicates: 2,
    })

    await updateImportRow(testDb(), batch, 1, { decision: 'skip' })
    expect((await countImportRows(testDb(), batch)).undecidedDuplicates).toBe(1)
  })

  /**
   * The two pointers are mutually exclusive, and a verdict can change kind between two runs of
   * detection — so the write always sets both, one of them to null. Setting only the new one fails
   * the CHECK on exactly the rows whose verdict moved.
   */
  it('replaces a record pointer with a row pointer without tripping the check', async () => {
    const anna = await createContact(testDb(), { firstName: 'Anna', lastName: 'Berger' })
    await setRowDuplicates(testDb(), batch, [{ rowNumber: 2, duplicateOf: anna }])
    await setRowDuplicates(testDb(), batch, [{ rowNumber: 2, duplicateOfRow: 1 }])

    const [row] = await listImportRows(testDb(), batch, { fromRow: 2, limit: 1 })
    expect(row?.duplicateOf).toBeNull()
    expect(row?.duplicateOfRow).toBe(1)
  })

  it('applies one decision to every flagged row, which is step 4s bulk choice', async () => {
    await setRowDuplicates(testDb(), batch, [
      { rowNumber: 1, duplicateOfRow: null, duplicateOf: null },
      { rowNumber: 2, duplicateOfRow: 1 },
      { rowNumber: 3, duplicateOfRow: 1 },
    ])
    expect(await setDuplicateDecisions(testDb(), batch, 'skip')).toBe(2)

    const rows = await listImportRows(testDb(), batch, { onlyDuplicates: true })
    expect(rows.map((row) => row.decision)).toEqual(['skip', 'skip'])
  })
})

describe('find and replace', () => {
  beforeEach(stage)

  it('rewrites one target across the batch and says which rows moved', async () => {
    const moved = await replaceInImportBatch(testDb(), batch, {
      targetId: 'city',
      find: 'Munich',
      replace: 'München',
    })
    expect([...moved].sort()).toEqual([1, 2])

    const rows = await listImportRows(testDb(), batch)
    expect((rows[0]?.mapped as Record<string, string>)['city']).toBe('München')
    expect((rows[2]?.mapped as Record<string, string>)['city']).toBeUndefined()
  })

  it('is case-insensitive by default and exact when asked', async () => {
    expect(
      await replaceInImportBatch(testDb(), batch, {
        targetId: 'city',
        find: 'munich',
        replace: 'Munich',
      }),
    ).toHaveLength(2)

    expect(
      await replaceInImportBatch(testDb(), batch, {
        targetId: 'city',
        find: 'munich',
        replace: 'nope',
        caseSensitive: true,
      }),
    ).toHaveLength(0)
  })

  /** A search for `a.b` must not match `axb`: the needle is text, not a pattern. */
  it('treats a regex metacharacter as a literal', async () => {
    await updateImportRow(testDb(), batch, 1, { mapped: { first_name: 'Anna', city: 'M.nich' } })

    expect(
      await replaceInImportBatch(testDb(), batch, {
        targetId: 'city',
        find: 'M.nich',
        replace: 'Munich',
      }),
    ).toEqual([1])
    // The literal needle must not have matched row 2's real "Munich".
    const rows = await listImportRows(testDb(), batch)
    expect((rows[1]?.mapped as Record<string, string>)['city']).toBe('Munich')
  })

  /**
   * A replacement on a boolean is a category error. `jsonb_typeof` refuses it rather than coercing,
   * which would turn `true` into the string `"true"` and change the cell's type behind the user.
   */
  it('leaves a cell that is not a string alone', async () => {
    expect(
      await replaceInImportBatch(testDb(), batch, {
        targetId: 'pinned_important',
        find: 'true',
        replace: 'false',
      }),
    ).toEqual([])

    const rows = await listImportRows(testDb(), batch)
    expect((rows[2]?.mapped as Record<string, unknown>)['pinned_important']).toBe(true)
  })

  it('does nothing for an empty needle rather than matching every row', async () => {
    expect(
      await replaceInImportBatch(testDb(), batch, { targetId: 'city', find: '', replace: 'x' }),
    ).toEqual([])
  })

  it('touches no other batch', async () => {
    const other = await createImportBatch(testDb(), {
      fileName: 'other.csv',
      objectType: 'contact',
    })
    await stageImportRows(testDb(), other, [
      { rowNumber: 1, raw: {}, mapped: { city: 'Munich' }, errors: [] },
    ])

    await replaceInImportBatch(testDb(), batch, {
      targetId: 'city',
      find: 'Munich',
      replace: 'München',
    })
    const rows = await listImportRows(testDb(), other)
    expect((rows[0]?.mapped as Record<string, string>)['city']).toBe('Munich')
  })
})
