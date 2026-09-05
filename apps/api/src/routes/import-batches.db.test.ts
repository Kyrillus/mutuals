/**
 * §6.8 end to end, over the real LinkedIn export.
 *
 * This is the test everything else in Stage 5 is scaffolding for. It drives the five steps through
 * the actual HTTP surface — upload, map, review, decide, commit — and asserts ADR-098's *measured*
 * numbers rather than the ones the acceptance test was written with: 31 data rows, six duplicate
 * pairs, one error row, 24 contacts landing.
 *
 * The e2e spec covers the same flow through the browser. This one covers what the browser cannot
 * see: which band each pair landed in, what the fact log recorded, and whether a second import of
 * the same file is really a no-op.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { testDb } from '@mutuals/db/test-support'

import { api, upload } from '../test-support/app.ts'

type Detail = {
  batch: {
    id: string
    status: string
    rowCount: number
    source: string
    columns: { header: string; targetId: string | null; step: string; confirmed: boolean }[]
    counts: {
      total: number
      withErrors: number
      duplicates: number
      undecidedDuplicates: number
      willImport: number
      willSkip: number
    }
    createdCount: number
    mergedCount: number
    skippedCount: number
    sheets: { name: string }[]
    sheetName: string | null
  }
  rows: {
    rowNumber: number
    mapped: Record<string, unknown>
    errors: { code: string }[]
    duplicate: { band: string; kind: string; rowNumber: number | null; evidence: string } | null
    decision: string | null
  }[]
}

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url)))
}

async function uploadLinkedIn(): Promise<Detail> {
  const response = await upload<Detail>(
    '/api/v1/import-batches',
    {
      name: 'linkedin_connections_sample.csv',
      content: fixture('linkedin_connections_sample.csv'),
    },
    { objectType: 'contact', source: 'linkedin' },
  )
  expect(response.status).toBe(201)
  return response.body
}

async function contactCount(): Promise<number> {
  const rows = await testDb()
    .selectFrom('record')
    .select('id')
    .where('object_type', '=', 'contact')
    .execute()
  return rows.length
}

describe('step 1 and 2 — upload', () => {
  it('finds the header under the preamble and stages 31 rows', async () => {
    const detail = await uploadLinkedIn()
    expect(detail.batch.rowCount).toBe(31)
    expect(detail.batch.status).toBe('reviewing')
    expect(detail.batch.source).toBe('linkedin')
    // A CSV has no worksheets to choose between.
    expect(detail.batch.sheetName).toBeNull()
  })

  it('auto-maps all seven columns with no fuzzy guess', async () => {
    const detail = await uploadLinkedIn()
    expect(detail.batch.columns.map((column) => column.targetId)).toEqual([
      'first_name',
      'last_name',
      'linkedin_url',
      'email',
      'organization',
      'organization.title',
      'organization.from',
    ])
    for (const column of detail.batch.columns) {
      expect(column.confirmed, column.header).toBe(true)
      expect(column.step, column.header).not.toBe('trigram')
    }
  })

  it('offers every worksheet of a workbook, and picks the one with content', async () => {
    const response = await upload<Detail>(
      '/api/v1/import-batches',
      { name: 'contacts_multi_sheet.xlsx', content: fixture('contacts_multi_sheet.xlsx') },
      { objectType: 'contact', source: 'generic' },
    )
    expect(response.status).toBe(201)
    expect(response.body.batch.sheets.map((sheet) => sheet.name)).toEqual([
      'Notes',
      'Team',
      'Archive 2019',
    ])
    // Not `Notes`, which is first: §6.8 step 2 exists because the first sheet is often prose.
    expect(response.body.batch.sheetName).toBe('Team')
    expect(response.body.batch.rowCount).toBe(5)
  })

  it('refuses a file it cannot read, and says what it reads', async () => {
    const response = await upload<{ detail: string; type: string }>(
      '/api/v1/import-batches',
      { name: 'contacts.vcf', content: Buffer.from('BEGIN:VCARD\nEND:VCARD') },
      { objectType: 'contact', source: 'apple_vcard' },
    )
    expect(response.status).toBe(415)
    expect(response.body.detail).toContain('.xlsx')
  })
})

describe('step 4 — the numbers the Review screen shows', () => {
  let detail: Detail

  beforeEach(async () => {
    detail = await uploadLinkedIn()
  })

  /** ADR-098's table, asserted through the API rather than from a script. */
  it('finds six duplicate pairs and one error row', () => {
    expect(detail.batch.counts).toMatchObject({
      total: 31,
      withErrors: 1,
      duplicates: 6,
      undecidedDuplicates: 6,
    })
  })

  it('flags each pair in the band ADR-098 measured, and says why', () => {
    const flagged = new Map(
      detail.rows.filter((row) => row.duplicate !== null).map((row) => [row.rowNumber, row]),
    )
    const expected: readonly [number, string, number, string][] = [
      [2, 'certain', 1, 'Same email'],
      [4, 'certain', 3, 'Same LinkedIn profile'],
      [8, 'probable', 7, 'Same name'],
      [10, 'possible', 9, 'Abbreviated name'],
      [12, 'possible', 11, 'Similar name'],
      [15, 'possible', 14, 'Similar name'],
    ]

    expect([...flagged.keys()].sort((a, b) => a - b)).toEqual(expected.map(([row]) => row))
    for (const [rowNumber, band, of, evidence] of expected) {
      const row = flagged.get(rowNumber)
      expect(row?.duplicate?.band, `row ${String(rowNumber)}`).toBe(band)
      // Every pair is row-against-row inside the file, which is what ADR-097 exists for.
      expect(row?.duplicate?.kind, `row ${String(rowNumber)}`).toBe('row')
      expect(row?.duplicate?.rowNumber, `row ${String(rowNumber)}`).toBe(of)
      expect(row?.duplicate?.evidence, `row ${String(rowNumber)}`).toContain(evidence)
    }
  })

  it('marks the one row with an unusable email and leaves the rest of it intact', () => {
    const bad = detail.rows.filter((row) => row.errors.length > 0)
    expect(bad).toHaveLength(1)
    expect(bad[0]?.errors[0]?.code).toBe('invalid_email')
    expect(bad[0]?.mapped['last_name']).toBe('Silva')
  })

  /** Q4: not importing is the default, so an undecided duplicate counts against the button. */
  it('says 24 rows will import while every duplicate is undecided', () => {
    expect(detail.batch.counts.willImport).toBe(24)
    expect(detail.batch.counts.willSkip).toBe(7)
  })

  it('keeps a quoted newline out of the mapped values', () => {
    const tomas = detail.rows.find((row) => row.mapped['last_name'] === 'Ferreira')
    expect(tomas?.mapped['organization.title']).toContain('\n')
    expect(tomas?.errors).toEqual([])
  })

  it("reads Connected On in LinkedIn's own spelling", () => {
    const anna = detail.rows.find((row) => row.rowNumber === 1)
    expect(anna?.mapped['organization.from']).toBe('2023-03-14')
  })
})

describe('step 4 — fixing things', () => {
  let batchId: string

  beforeEach(async () => {
    batchId = (await uploadLinkedIn()).batch.id
  })

  it('takes a corrected cell and clears the error', async () => {
    const response = await api.patch<Detail>(`/api/v1/import-batches/${batchId}/rows/27`, {
      values: { email: 'ana.silva@orchard-talent.example' },
    })
    expect(response.status).toBe(200)

    const row = response.body.rows.find((one) => one.rowNumber === 27)
    expect(row?.errors).toEqual([])
    expect(row?.mapped['email']).toBe('ana.silva@orchard-talent.example')
    expect(response.body.batch.counts.withErrors).toBe(0)
  })

  /** The reason `raw` is never written to: the file's own value has to survive an edit. */
  it('reverts an edited row to what the file said', async () => {
    await api.patch(`/api/v1/import-batches/${batchId}/rows/27`, {
      values: { email: 'ana.silva@orchard-talent.example' },
    })
    const reverted = await api.post<Detail>(`/api/v1/import-batches/${batchId}/rows/27/revert`, {})
    expect(reverted.status).toBe(200)

    const row = reverted.body.rows.find((one) => one.rowNumber === 27)
    expect(row?.errors[0]?.code).toBe('invalid_email')
    expect(reverted.body.batch.counts.withErrors).toBe(1)
  })

  it('finds and replaces across one column, then re-validates what it changed', async () => {
    const response = await api.post<{ count: number; changedRows: number[] }>(
      `/api/v1/import-batches/${batchId}/replace`,
      { targetId: 'organization', find: 'Northstar Ventures', replace: 'Northstar Capital' },
    )
    expect(response.status).toBe(200)
    expect(response.body.count).toBe(2)

    const after = await api.get<Detail>(`/api/v1/import-batches/${batchId}`)
    const anna = after.body.rows.find((row) => row.rowNumber === 1)
    expect(anna?.mapped['organization']).toBe('Northstar Capital')
  })

  it('rejects an edit to a column this import does not have', async () => {
    const response = await api.patch(`/api/v1/import-batches/${batchId}/rows/1`, {
      values: { sternzeichen: 'Waage' },
    })
    expect(response.status).toBe(400)
  })
})

describe('step 3 — changing the mapping', () => {
  it('re-derives every row when a column is pointed somewhere else', async () => {
    const batchId = (await uploadLinkedIn()).batch.id

    // Unmap the email column entirely: the invalid address stops being an error, because there is
    // no longer a field for it to be invalid in.
    const response = await api.patch<Detail>(`/api/v1/import-batches/${batchId}`, {
      columns: { '3': null },
    })
    expect(response.status).toBe(200)
    expect(response.body.batch.counts.withErrors).toBe(0)
    expect(response.body.rows[0]?.mapped['email']).toBeUndefined()

    // And the Anna Berger pair, which was certain *because* of the shared email, is now only a
    // name match — the same evidence a person would have without the column.
    const anna = response.body.rows.find((row) => row.rowNumber === 2)
    expect(anna?.duplicate?.band).toBe('probable')
  })

  it('says plainly that changing the worksheet needs the file again', async () => {
    const batchId = (await uploadLinkedIn()).batch.id
    const response = await api.patch<{ detail: string }>(`/api/v1/import-batches/${batchId}`, {
      sheetName: 'Team',
    })
    expect(response.status).toBe(409)
    expect(response.body.detail).toContain('Upload it once more')
  })
})

describe('step 5 — commit', () => {
  it('imports 24 contacts when every flagged row is left undecided', async () => {
    const before = await contactCount()
    const batchId = (await uploadLinkedIn()).batch.id

    const commit = await api.post<{ status: string; jobId: string | null }>(
      `/api/v1/import-batches/${batchId}/commit`,
      {},
    )
    expect(commit.status).toBe(200)
    expect(commit.body.jobId).not.toBeNull()

    const after = await api.get<Detail>(`/api/v1/import-batches/${batchId}`)
    expect(after.body.batch.status).toBe('completed')
    expect(after.body.batch.createdCount).toBe(24)
    expect(after.body.batch.skippedCount).toBe(7)
    expect(await contactCount()).toBe(before + 24)
  })

  it('creates each organization once, however many rows name it', async () => {
    const batchId = (await uploadLinkedIn()).batch.id
    await api.post(`/api/v1/import-batches/${batchId}/commit`, {})

    const northstar = await testDb()
      .selectFrom('record')
      .select('id')
      .where('object_type', '=', 'organization')
      .where('display_label', '=', 'Northstar Ventures')
      .execute()
    expect(northstar).toHaveLength(1)
  })

  it('links a contact to its organization with the job title and the date on the link', async () => {
    const batchId = (await uploadLinkedIn()).batch.id
    await api.post(`/api/v1/import-batches/${batchId}/commit`, {})

    const link = await testDb()
      .selectFrom('record_link as l')
      .innerJoin('record as person', 'person.id', 'l.from_record_id')
      .innerJoin('record as company', 'company.id', 'l.to_record_id')
      .select(['l.title', 'l.valid_from', 'company.display_label as company'])
      .where('person.display_label', '=', 'Aisha Rahman')
      .executeTakeFirst()

    expect(link).toMatchObject({
      title: 'Head of Product',
      company: 'Nimbus Health',
    })
    expect(String(link?.valid_from)).toContain('2024-03-03')
  })

  /** §4.4: every record says which file it came from, so the result screen can link to them. */
  it('attributes every record it created to the batch', async () => {
    const batchId = (await uploadLinkedIn()).batch.id
    await api.post(`/api/v1/import-batches/${batchId}/commit`, {})

    const rows = await testDb()
      .selectFrom('record')
      .select(['created_via'])
      .where('import_batch_id', '=', batchId)
      .execute()
    expect(rows.length).toBeGreaterThanOrEqual(24)
    for (const row of rows) expect(row.created_via).toBe('import')
  })

  /** §6.8's idempotency requirement, and the reason Q4 defaults to not importing. */
  it('creates nothing the second time the same file is imported and skipped', async () => {
    const first = (await uploadLinkedIn()).batch.id
    await api.post(`/api/v1/import-batches/${first}/commit`, {})
    const afterFirst = await contactCount()

    const second = (await uploadLinkedIn()).batch.id
    const detail = await api.get<Detail>(`/api/v1/import-batches/${second}`)
    // Now every row matches a *record*, not another row of the file.
    const kinds = new Set(
      detail.body.rows.filter((row) => row.duplicate !== null).map((row) => row.duplicate?.kind),
    )
    expect(kinds).toEqual(new Set(['record']))

    await api.post(`/api/v1/import-batches/${second}/commit`, { bulkDecision: 'skip' })
    expect(await contactCount()).toBe(afterFirst)
  })

  it('refuses to run an import twice', async () => {
    const batchId = (await uploadLinkedIn()).batch.id
    await api.post(`/api/v1/import-batches/${batchId}/commit`, {})

    const again = await api.post<{ detail: string }>(`/api/v1/import-batches/${batchId}/commit`, {})
    expect(again.status).toBe(409)
    expect(again.body.detail).toContain('already run')
  })

  it('applies a bulk decision to every flagged row before starting', async () => {
    const batchId = (await uploadLinkedIn()).batch.id
    await api.post(`/api/v1/import-batches/${batchId}/commit`, { bulkDecision: 'create' })

    const after = await api.get<Detail>(`/api/v1/import-batches/${batchId}`)
    // Every duplicate now lands, so only the invalid-email row is skipped.
    expect(after.body.batch.createdCount).toBe(30)
    expect(after.body.batch.skippedCount).toBe(1)
  })
})

describe('the error report', () => {
  it('lists the rows that did not land, and why, in two different words', async () => {
    const batchId = (await uploadLinkedIn()).batch.id
    await api.post(`/api/v1/import-batches/${batchId}/commit`, {})

    const report = await api.get<{ csv: string; rowCount: number; fileName: string }>(
      `/api/v1/import-batches/${batchId}/errors`,
    )
    expect(report.status).toBe(200)
    expect(report.body.rowCount).toBe(7)
    expect(report.body.fileName).toBe('linkedin_connections_sample-not-imported.csv')
    expect(report.body.csv).toContain('Why it was not imported')
    expect(report.body.csv).toContain('lists this person more than once')
    expect(report.body.csv).toContain('is not an email')
  })

  it('exports the staged rows as the file they came from', async () => {
    const batchId = (await uploadLinkedIn()).batch.id
    const response = await api.get<{ csv: string; rowCount: number }>(
      `/api/v1/import-batches/${batchId}/export`,
    )
    expect(response.status).toBe(200)
    expect(response.body.rowCount).toBe(31)
    // The source headers, so the file re-imports through this same wizard.
    expect(response.body.csv.split('\r\n')[0]).toBe(
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
    )
  })
})

describe('a batch that is not there', () => {
  const missing = '00000000-0000-4000-8000-00000000dead'

  it('answers 404 rather than 500', async () => {
    expect((await api.get(`/api/v1/import-batches/${missing}`)).status).toBe(404)
    expect((await api.post(`/api/v1/import-batches/${missing}/commit`, {})).status).toBe(404)
    expect(
      (
        await api.post(`/api/v1/import-batches/${missing}/replace`, {
          targetId: 'city',
          find: 'a',
          replace: 'b',
        })
      ).status,
    ).toBe(404)
  })
})
