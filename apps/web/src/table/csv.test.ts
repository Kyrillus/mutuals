import { describe, expect, it } from 'vitest'

import { csvFileName, recordsToCsv } from './csv.ts'
import type { RecordRow } from './record-row.ts'
import { field } from './test-support.ts'

function row(overrides: Partial<RecordRow>): RecordRow {
  return {
    id: 'r1',
    objectType: 'contact',
    displayName: 'Anna Berger',
    createdAt: '2026-03-01T09:00:00.000Z',
    updatedAt: '2026-03-01T09:00:00.000Z',
    attributes: {},
    ...overrides,
  }
}

const NAME = field('display_name')
const CITY = field('city', { label: 'City' })
const WARMTH = field('warmth')

describe('recordsToCsv', () => {
  it('exports the columns on screen, in the order they are on screen', () => {
    const csv = recordsToCsv(
      [row({ attributes: { city: { type: 'short_text', value: 'Munich' } } })],
      [NAME, CITY],
    )
    expect(csv).toBe('Name,City\r\nAnna Berger,Munich')
  })

  it('writes an absent attribute as an empty cell, never as "undefined"', () => {
    expect(recordsToCsv([row({})], [CITY])).toBe('City\r\n')
  })

  it('renders a derived numeric column', () => {
    const csv = recordsToCsv([row({ warmth: 74 } as Partial<RecordRow>)], [WARMTH])
    expect(csv).toBe('Warmth\r\n74')
  })

  it('quotes a value containing the delimiter and doubles embedded quotes', () => {
    const csv = recordsToCsv(
      [row({ attributes: { city: { type: 'short_text', value: 'Berlin, "Mitte"' } } })],
      [CITY],
    )
    expect(csv).toBe('City\r\n"Berlin, ""Mitte"""')
  })

  it('defuses a value a spreadsheet would run as a formula', () => {
    const csv = recordsToCsv(
      [row({ attributes: { city: { type: 'short_text', value: '=1+1' } } })],
      [CITY],
    )
    expect(csv).toBe('City\r\n\t=1+1')
  })

  it('joins a multi-valued attribute with semicolons, since commas are the delimiter', () => {
    const tags = field('areas_of_interest', { type: 'tags', label: 'Areas of interest' })
    const csv = recordsToCsv(
      [row({ attributes: { areas_of_interest: { type: 'tags', value: ['AI', 'Climate'] } } })],
      [tags],
    )
    expect(csv).toBe('Areas of interest\r\nAI; Climate')
  })
})

describe('csvFileName', () => {
  it('names the file after the object type and the day', () => {
    expect(csvFileName('contact', new Date('2026-03-01T22:00:00Z'))).toBe('contacts-2026-03-01.csv')
  })
})
