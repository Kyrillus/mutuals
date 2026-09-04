/**
 * ADR-044's cascade, step by step, plus the two bugs the real fixtures found.
 *
 * The header rows below are verbatim from `fixtures/linkedin_connections_sample.csv` and
 * `fixtures/google_contacts_sample.csv`. They are literals rather than a file read because
 * `packages/core` may not import `node:fs` — the ESLint rule covers tests too — and the
 * end-to-end assertion over the actual files lives in the API's import test, where files arrive.
 */
import { describe, expect, it } from 'vitest'

import { FUZZY_THRESHOLD, autoMapColumns, fuzzyConfidence, type SourceColumn } from './automap.ts'
import { importPreset, type ImportSource } from './presets.ts'
import { importTargets } from './targets.ts'
import { seededContactResolver } from './test-support.ts'

const TARGETS = importTargets(seededContactResolver())

function columns(headers: readonly string[], cells: Readonly<Record<string, string[]>> = {}) {
  return headers.map<SourceColumn>((header, index) => ({
    index,
    header,
    cells: cells[header] ?? [],
  }))
}

function mapOf(
  headers: readonly string[],
  source: ImportSource = 'generic',
  cells: Readonly<Record<string, string[]>> = {},
) {
  const result = autoMapColumns(columns(headers, cells), TARGETS, importPreset(source))
  return new Map(result.map((mapping) => [mapping.header, mapping]))
}

const LINKEDIN_HEADERS = [
  'First Name',
  'Last Name',
  'URL',
  'Email Address',
  'Company',
  'Position',
  'Connected On',
] as const

const GOOGLE_HEADERS = [
  'First Name',
  'Middle Name',
  'Last Name',
  'Name Suffix',
  'Name Prefix',
  'Nickname',
  'File As',
  'Organization Name',
  'Organization Title',
  'Organization Department',
  'Birthday',
  'Notes',
  'Labels',
  'E-mail 1 - Label',
  'E-mail 1 - Value',
  'E-mail 2 - Label',
  'E-mail 2 - Value',
  'Phone 1 - Label',
  'Phone 1 - Value',
  'Phone 2 - Label',
  'Phone 2 - Value',
  'Address 1 - Label',
  'Address 1 - Formatted',
  'Address 1 - City',
  'Address 1 - Country',
  'Website 1 - Label',
  'Website 1 - Value',
] as const

describe('the cascade, one step at a time', () => {
  it('1. matches a header that is literally the slug or the label', () => {
    expect(mapOf(['email']).get('email')).toMatchObject({ targetId: 'email', step: 'exact' })
    expect(mapOf(['Job role']).get('Job role')).toMatchObject({
      targetId: 'job_role',
      step: 'exact',
    })
  })

  it('2. matches once both sides are normalised — the underscore pre-step', () => {
    expect(mapOf(['First Name']).get('First Name')).toMatchObject({
      targetId: 'first_name',
      step: 'normalized',
    })
    expect(mapOf(['areas of interest']).get('areas of interest')?.step).toBe('normalized')
  })

  it('3. uses what the export is known to call things', () => {
    const linkedin = mapOf(['URL'], 'linkedin')
    expect(linkedin.get('URL')).toMatchObject({ targetId: 'linkedin_url', step: 'preset' })
    // The same header means something else with no preset selected.
    expect(mapOf(['URL']).get('URL')?.targetId).not.toBe('linkedin_url')
  })

  it('4. uses the synonym table for the pairs no string rule can reach', () => {
    expect(mapOf(['Company']).get('Company')).toMatchObject({
      targetId: 'organization',
      step: 'synonym',
    })
    expect(mapOf(['Telefonnummer']).get('Telefonnummer')?.targetId).toBe('phone')
    expect(mapOf(['Nachname']).get('Nachname')?.targetId).toBe('last_name')
  })

  it('5. matches a prefix at a word boundary, and only there', () => {
    expect(mapOf(['Phone (work)']).get('Phone (work)')).toMatchObject({
      targetId: 'phone',
      step: 'prefix',
    })
    // `Countryside` is not `Country` with a suffix; it is a different word.
    expect(mapOf(['Countryside']).get('Countryside')?.targetId).not.toBe('country')
  })

  it('6. proposes a trigram match but never confirms it', () => {
    const mapping = mapOf(['Birthdays']).get('Birthdays')
    expect(mapping).toMatchObject({ targetId: 'birthday', step: 'trigram', confirmed: false })
    expect(mapping?.confidence).toBeGreaterThan(0.6)
    expect(mapping?.confidence).toBeLessThan(0.85)
  })

  /**
   * 0.72 is tighter than it looks, and this is the case that shows it: `Websites` scores 0.700
   * against `website` — an English plural is not enough to clear the bar. Recorded because the
   * temptation on meeting an unmapped column is to lower the threshold, and what that actually buys
   * is `Countryside` matching `Country`. The pairs that matter are handled by the synonym table,
   * which is exact.
   */
  it('rejects a near-miss rather than stretching to reach it', () => {
    expect(mapOf(['Websites']).get('Websites')).toMatchObject({ targetId: null, step: 'none' })
  })

  it('7. leaves a header it cannot place alone, rather than guessing', () => {
    expect(mapOf(['Sternzeichen']).get('Sternzeichen')).toMatchObject({
      targetId: null,
      step: 'none',
      confirmed: false,
      confidence: 0,
    })
  })

  it('confirms steps 1 to 5 and nothing else', () => {
    const confirmed = mapOf(['email', 'First Name', 'Company', 'Phone (work)', 'Websites'])
    for (const header of ['email', 'First Name', 'Company', 'Phone (work)']) {
      expect(confirmed.get(header)?.confirmed, header).toBe(true)
    }
    expect(confirmed.get('Websites')?.confirmed).toBe(false)
  })
})

describe('fuzzyConfidence', () => {
  it('is the line ADR-044 fixes through its two endpoints', () => {
    expect(fuzzyConfidence(FUZZY_THRESHOLD)).toBeCloseTo(0.6, 10)
    expect(fuzzyConfidence(1)).toBeCloseTo(0.85, 10)
    expect(fuzzyConfidence(0.86)).toBeCloseTo(0.725, 3)
  })
})

describe('the LinkedIn export', () => {
  it('maps all seven columns with no fuzzy guesses', () => {
    const mapping = mapOf(LINKEDIN_HEADERS, 'linkedin')
    expect([...mapping.values()].map((m) => m.targetId)).toEqual([
      'first_name',
      'last_name',
      'linkedin_url',
      'email',
      'organization',
      'organization.title',
      'organization.from',
    ])
    for (const one of mapping.values()) expect(one.confirmed, one.header).toBe(true)
  })

  it("reads Connected On in the export's own spelling, with no inference needed", () => {
    const mapping = mapOf(LINKEDIN_HEADERS, 'linkedin', {
      'Connected On': ['14 Mar 2023', '02 Apr 2023'],
    })
    expect(mapping.get('Connected On')?.dateFormat).toBe('d_mon_y')
    expect(mapping.get('Connected On')?.dateInference?.ambiguous).toBe(false)
  })
})

describe('the Google Contacts export', () => {
  const mapping = mapOf(GOOGLE_HEADERS, 'google_contacts')

  /**
   * ADR-044's one-target-one-column rule, and the data-loss bug it exists to prevent: without it
   * both value columns map to `email` and the second silently overwrites the first.
   */
  it('maps the first of each repeated group and leaves the second unmapped', () => {
    expect(mapping.get('E-mail 1 - Value')?.targetId).toBe('email')
    expect(mapping.get('E-mail 2 - Value')?.targetId).toBeNull()
    expect(mapping.get('Phone 1 - Value')?.targetId).toBe('phone')
    expect(mapping.get('Phone 2 - Value')?.targetId).toBeNull()
  })

  /**
   * Found by running the mapper over the real file. All four parts of a link share one slug, so a
   * prefix match against the slug proposed every part of it and greedy assignment handed this
   * column `organization.from`. Matching on the unique target id instead leaves it unmapped, which
   * is the honest answer — we have no field for a department.
   */
  it('does not mistake Organization Department for part of the organization link', () => {
    expect(mapping.get('Organization Department')?.targetId).toBeNull()
    expect(mapping.get('Organization Name')?.targetId).toBe('organization')
    expect(mapping.get('Organization Title')?.targetId).toBe('organization.title')
  })

  it('never maps two columns to one target', () => {
    const claimed = [...mapping.values()].map((one) => one.targetId).filter((id) => id !== null)
    expect(new Set(claimed).size).toBe(claimed.length)
  })

  it('reports the fill rate so step 3 can show "% of rows have a value"', () => {
    const withCells = mapOf(['Notes'], 'google_contacts', { Notes: ['a', '', '', 'b'] })
    expect(withCells.get('Notes')?.fillRate).toBe(0.5)
  })
})
