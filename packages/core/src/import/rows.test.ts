import { describe, expect, it } from 'vitest'

import type { AttributeDefinition } from '../attributes/definition.ts'
import { autoMapColumns, type SourceColumn } from './automap.ts'
import { importPreset } from './presets.ts'
import { mapRow, type ValueMap } from './rows.ts'
import { importTargets } from './targets.ts'
import { seededContactDefinitions, seededContactResolver } from './test-support.ts'

const TARGETS = importTargets(seededContactResolver())
const DEFINITIONS = new Map(seededContactDefinitions().map((one) => [one.slug, one]))

function typeContext(definition: AttributeDefinition) {
  return { options: definition.options ?? [], phoneRegion: 'DE' }
}

/** Builds the mapping the wizard would have, then maps one row through it. */
function run(
  headers: readonly string[],
  cells: readonly string[],
  extra: { readonly source?: 'linkedin' | 'generic'; readonly valueMap?: ValueMap } = {},
) {
  const columns = headers.map<SourceColumn>((header, index) => ({
    index,
    header,
    cells: [cells[index] ?? ''],
  }))
  const mappings = autoMapColumns(columns, TARGETS, importPreset(extra.source ?? 'generic'))
  return mapRow(cells, {
    objectType: 'contact',
    mappings,
    targets: TARGETS,
    definitions: DEFINITIONS,
    typeContext,
    ...(extra.valueMap === undefined ? {} : { valueMap: extra.valueMap }),
  })
}

const LINKEDIN = [
  'First Name',
  'Last Name',
  'URL',
  'Email Address',
  'Company',
  'Position',
  'Connected On',
] as const

describe('mapRow', () => {
  it('maps a clean LinkedIn row, dates included', () => {
    const row = run(
      LINKEDIN,
      [
        'Anna',
        'Berger',
        'https://www.linkedin.com/in/anna-berger',
        'ANNA.BERGER@NORTHSTAR-VENTURES.COM',
        'Northstar Ventures',
        'Partner',
        '14 Mar 2023',
      ],
      { source: 'linkedin' },
    )
    expect(row.errors).toEqual([])
    expect(row.values).toMatchObject({
      first_name: 'Anna',
      last_name: 'Berger',
      email: 'anna.berger@northstar-ventures.com',
      organization: 'Northstar Ventures',
      'organization.title': 'Partner',
      'organization.from': '2023-03-14',
    })
  })

  it('leaves an empty cell out of the values rather than writing a blank', () => {
    const row = run(
      LINKEDIN,
      ['Björn', 'Håkansson', 'https://x.example', '', 'Bright Angle', 'GP', '19 Jan 2022'],
      {
        source: 'linkedin',
      },
    )
    expect(row.errors).toEqual([])
    expect('email' in row.values).toBe(false)
  })

  /** §6.8 step 4 lists "invalid email" as one of the four things `Find errors` highlights. */
  it('reports a bad email against the cell that holds it, and keeps the rest of the row', () => {
    const row = run(
      LINKEDIN,
      ['Ana', 'Silva', 'https://x.example', 'not-an-email', 'Orchard', 'Recruiter', '07 Sep 2022'],
      {
        source: 'linkedin',
      },
    )
    expect(row.errors).toHaveLength(1)
    expect(row.errors[0]).toMatchObject({ code: 'invalid_email', path: ['email'] })
    expect(row.values['first_name']).toBe('Ana')
  })

  /** Every problem at once, because the grid lights up every bad cell rather than one per pass. */
  it('reports several bad cells in one go', () => {
    const row = run(
      LINKEDIN,
      ['Ana', 'Silva', 'x', 'not-an-email', 'Orchard', 'Recruiter', 'the third of never'],
      {
        source: 'linkedin',
      },
    )
    expect(row.errors.map((one) => one.path[0]).sort()).toEqual(['email', 'organization.from'])
  })

  /**
   * The requirement is not a `required` flag — §4.2 has none. It is that the subtype's label is a
   * generated column, so a row with neither name produces a record that is invisible in every
   * list, search and picker in the product.
   */
  it('refuses a row that cannot be named', () => {
    const row = run(
      LINKEDIN,
      ['', '', 'https://x.example', 'a@b.example', 'Acme', 'CTO', '01 Jan 2020'],
      {
        source: 'linkedin',
      },
    )
    expect(row.errors).toHaveLength(1)
    expect(row.errors[0]).toMatchObject({ code: 'required', path: ['first_name'] })
  })

  it('accepts a row with only a last name, which a real export contains', () => {
    const row = run(
      LINKEDIN,
      ['', 'Nakamura', 'https://x.example', '', 'Sirocco', 'Head of Partnerships', '14 Jul 2022'],
      {
        source: 'linkedin',
      },
    )
    expect(row.errors).toEqual([])
    expect(row.values['last_name']).toBe('Nakamura')
  })

  /** §6.8 step 3's per-value mapping, keyed on the source text so it survives a re-parse. */
  it('applies the value map before the type sees the cell', () => {
    const withMap = run(['First Name', 'Job role'], ['Anna', 'GP'], {
      valueMap: { job_role: { GP: 'investor' } },
    })
    expect(withMap.errors).toEqual([])
    expect(withMap.values['job_role']).toBeTruthy()

    const without = run(['First Name', 'Job role'], ['Anna', 'GP'])
    expect(without.errors[0]).toMatchObject({ code: 'unknown_option', path: ['job_role'] })
  })

  it('reads the spreadsheet spellings of a boolean, in both languages', () => {
    for (const yes of ['yes', 'Y', 'TRUE', 'ja', '1', 'x']) {
      expect(
        run(['First Name', 'pinned_important'], ['Anna', yes]).values['pinned_important'],
      ).toBe(true)
    }
    for (const no of ['no', 'N', 'false', 'nein', '0']) {
      expect(run(['First Name', 'pinned_important'], ['Anna', no]).values['pinned_important']).toBe(
        false,
      )
    }
    expect(run(['First Name', 'pinned_important'], ['Anna', 'perhaps']).errors[0]).toMatchObject({
      code: 'invalid_input',
      path: ['pinned_important'],
    })
  })

  it('ignores a column the user left unmapped', () => {
    const row = run(['First Name', 'Sternzeichen'], ['Anna', 'Waage'])
    expect(row.errors).toEqual([])
    expect(Object.keys(row.values)).toEqual(['first_name'])
  })

  it('splits a tags cell into elements, because the type says it may', () => {
    const row = run(['First Name', 'Asks'], ['Anna', 'intros, hiring, seed capital'])
    expect(row.errors).toEqual([])
    expect(row.values['asks']).toEqual(['intros', 'hiring', 'seed capital'])
  })
})
