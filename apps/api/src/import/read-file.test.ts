/**
 * The upload reader, against the real fixtures.
 *
 * This is where the fixture-driven assertions live rather than in `packages/core`: core may not
 * import `node:fs` — the ESLint rule covers its tests too — and a file arriving is an `apps/api`
 * concern anyway.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { readImportFile } from './read-file.ts'
import { ApiError } from '../errors.ts'

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url)))
}

describe('a CSV upload', () => {
  it('reads the LinkedIn export, preamble and all', async () => {
    const result = await readImportFile(
      'linkedin_connections_sample.csv',
      fixture('linkedin_connections_sample.csv'),
    )
    expect(result.kind).toBe('csv')
    expect(result.delimiter).toBe(',')
    expect(result.sheets).toHaveLength(1)

    const rows = result.sheets[0]?.rows ?? []
    // Three preamble lines, a header, and 31 data rows — the numbers ADR-098 measured.
    expect(rows[0]).toEqual(['Notes:'])
    expect(rows[3]?.[0]).toBe('First Name')
    expect(rows).toHaveLength(35)
  })

  /** The row whose `Position` contains a newline inside a quoted field. */
  it('keeps a quoted newline inside its cell rather than splitting the row', async () => {
    const result = await readImportFile(
      'linkedin_connections_sample.csv',
      fixture('linkedin_connections_sample.csv'),
    )
    const tomas = result.sheets[0]?.rows.find((row) => row[1] === 'Ferreira')
    expect(tomas?.[5]).toBe('Co-Founder & CEO\nAutonomous survey vessels')
    expect(tomas).toHaveLength(7)
  })

  it('reads the Google Contacts export', async () => {
    const result = await readImportFile(
      'google_contacts_sample.csv',
      fixture('google_contacts_sample.csv'),
    )
    expect(result.sheets[0]?.rows[0]).toHaveLength(27)
    expect(result.sheets[0]?.rows[0]?.[0]).toBe('First Name')
  })
})

describe('an XLSX upload', () => {
  it('reads every worksheet, with its name', async () => {
    const result = await readImportFile(
      'contacts_multi_sheet.xlsx',
      fixture('contacts_multi_sheet.xlsx'),
    )
    expect(result.kind).toBe('xlsx')
    expect(result.sheets.map((sheet) => sheet.name)).toEqual(['Notes', 'Team', 'Archive 2019'])
  })

  it('produces the same shape a CSV does, so nothing downstream can tell them apart', async () => {
    const result = await readImportFile(
      'contacts_multi_sheet.xlsx',
      fixture('contacts_multi_sheet.xlsx'),
    )
    const team = result.sheets.find((sheet) => sheet.name === 'Team')
    expect(team?.rows[0]).toEqual([
      'First Name',
      'Last Name',
      'Email Address',
      'Company',
      'Position',
      'Started',
    ])
    for (const row of team?.rows ?? []) {
      for (const cell of row) expect(typeof cell).toBe('string')
    }
  })

  it('keeps a diacritic and an empty first name', async () => {
    const result = await readImportFile(
      'contacts_multi_sheet.xlsx',
      fixture('contacts_multi_sheet.xlsx'),
    )
    const team = result.sheets.find((sheet) => sheet.name === 'Team')
    expect(team?.rows.some((row) => row[0] === 'Tomás')).toBe(true)
    const nakamura = team?.rows.find((row) => row[1] === 'Nakamura')
    expect(nakamura?.[0]).toBe('')
  })
})

describe('a file it cannot read', () => {
  it('answers 415 and says what it does read', async () => {
    await expect(readImportFile('contacts.vcf', Buffer.from('BEGIN:VCARD'))).rejects.toBeInstanceOf(
      ApiError,
    )
    const error = await readImportFile('contacts.vcf', Buffer.from('x')).catch(
      (caught: unknown) => caught,
    )
    expect(error).toMatchObject({ status: 415, code: 'unsupported_media_type' })
    expect((error as ApiError).detail).toContain('.xlsx')
  })

  /** The extension decides, not the browser's Content-Type, which varies by machine. */
  it('reads a .csv whatever the browser called it', async () => {
    const result = await readImportFile('export.CSV', Buffer.from('a,b\n1,2\n'))
    expect(result.kind).toBe('csv')
  })
})
