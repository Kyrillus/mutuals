import { describe, expect, it } from 'vitest'

import {
  IMPORT_PRESETS,
  detectHeaderRow,
  importPreset,
  presetDateFormat,
  presetTarget,
  presetsFor,
} from './presets.ts'
import { HEADER_SYNONYMS } from './synonyms.ts'

describe('detectHeaderRow', () => {
  /**
   * LinkedIn writes three lines of prose above its header. The count is not counted: the preamble
   * lines have no delimiters and parse to one cell each, while the header and every data row parse
   * to seven. That difference is structural, so this keeps working if LinkedIn writes four lines.
   */
  it('finds the header under a preamble of any length', () => {
    const rows = [
      ['Notes:'],
      [
        'When exporting your connection data, you may notice that some of the addresses are missing',
      ],
      [''],
      ['First Name', 'Last Name', 'URL', 'Email Address', 'Company', 'Position', 'Connected On'],
      ['Anna', 'Berger', 'https://…', 'a@b.example', 'Northstar', 'Partner', '14 Mar 2023'],
    ]
    expect(detectHeaderRow(rows)).toBe(3)
    expect(detectHeaderRow([rows[0] as string[], ...rows])).toBe(4)
  })

  it('answers 0 for an ordinary CSV', () => {
    expect(
      detectHeaderRow([
        ['a', 'b'],
        ['1', '2'],
      ]),
    ).toBe(0)
  })

  /**
   * The bug the Google fixture found. Most of its rows end in an empty cell and its header does
   * not, so measuring content width made the header look like the odd row out and a data row was
   * chosen instead. Cell count does not care whether the last cell holds anything.
   */
  it('is not fooled by data rows whose trailing cells are empty', () => {
    const rows = [
      ['First Name', 'Last Name', 'Notes', 'Website'],
      ['Anna', 'Berger', 'met at a conference', ''],
      ['Jonas', 'Weber', '', ''],
      ['Marta', 'Nowak', '', ''],
    ]
    expect(detectHeaderRow(rows)).toBe(0)
  })

  it('answers 0 rather than failing on an empty or single-column sheet', () => {
    expect(detectHeaderRow([])).toBe(0)
    expect(detectHeaderRow([['only one column'], ['a value']])).toBe(0)
  })

  it('does not search past the limit', () => {
    const rows = [...Array.from({ length: 30 }, () => ['x']), ['a', 'b'], ['1', '2']]
    expect(detectHeaderRow(rows, 5)).toBe(0)
  })
})

describe('the presets', () => {
  it('reads a header through the same normalisation the mapper uses', () => {
    const linkedin = importPreset('linkedin')
    expect(presetTarget(linkedin, 'Email Address')).toBe('email')
    expect(presetTarget(linkedin, 'email address')).toBe('email')
    expect(presetTarget(linkedin, 'Sternzeichen')).toBeUndefined()
  })

  /**
   * A preset knows one export's exact column names and nothing more. `E-Mail-Address` normalises to
   * `e mail address`, which LinkedIn never writes — so the preset says nothing and the synonym
   * table catches it one step later. Kept as a test because the tempting fix is to make presets
   * fuzzy, which would let one export's vocabulary leak into every other file.
   */
  it('says nothing about a spelling its export does not use', () => {
    expect(presetTarget(importPreset('linkedin'), 'E-Mail-Address')).toBeUndefined()
    expect(HEADER_SYNONYMS['e mail address']).toBe('email')
  })

  it("knows Connected On's spelling, so no inference is needed for it", () => {
    expect(presetDateFormat(importPreset('linkedin'), 'Connected On')).toBe('d_mon_y')
    expect(presetDateFormat(importPreset('linkedin'), 'Company')).toBeUndefined()
  })

  it('offers a generic option for both object types and LinkedIn only for contacts', () => {
    expect(presetsFor('organization').map((preset) => preset.id)).toEqual(['generic'])
    expect(presetsFor('contact').map((preset) => preset.id)).toEqual([
      'generic',
      'linkedin',
      'google_contacts',
      'apple_vcard',
    ])
  })

  /** ADR-096: it stays in the list, disabled, so the menu does not change shape when it lands. */
  it('lists vCard as unavailable with a reason rather than hiding it', () => {
    const vcard = importPreset('apple_vcard')
    expect(vcard.available).toBe(false)
    expect(vcard.unavailableReason).toBeTruthy()
    expect(IMPORT_PRESETS.filter((preset) => preset.available).map((p) => p.id)).toEqual([
      'generic',
      'linkedin',
      'google_contacts',
    ])
  })

  it('throws for an id that is not a preset, because that is a programmer error', () => {
    // @ts-expect-error -- the point is the runtime guard
    expect(() => importPreset('myspace')).toThrow(/Unknown import source/)
  })
})
