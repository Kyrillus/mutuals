import { describe, expect, it } from 'vitest'

import { unwrap } from '../result.ts'
import {
  activeOptions,
  findOptionById,
  findOptionByKey,
  matchOption,
  type AttributeOption,
} from './option.ts'

const OPTIONS: readonly AttributeOption[] = [
  { id: 'b', key: 'founder', label: 'Founder', position: 2 },
  { id: 'a', key: 'investor', label: 'Investor', position: 1 },
  { id: 'c', key: 'angel', label: 'Angel', position: 3, archivedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'd', key: 'other', label: 'Other', position: 4, archivedAt: null },
]

describe('option lookup', () => {
  it('orders live options by position, which is §4.2 option order', () => {
    expect(activeOptions(OPTIONS).map((o) => o.key)).toEqual(['investor', 'founder', 'other'])
  })

  it('breaks a position tie deterministically', () => {
    const tied: AttributeOption[] = [
      { id: '1', key: 'b', label: 'B', position: 1 },
      { id: '2', key: 'a', label: 'A', position: 1 },
    ]
    expect(activeOptions(tied).map((o) => o.key)).toEqual(['a', 'b'])
  })

  it('finds archived options too, so an old value still renders', () => {
    expect(findOptionByKey(OPTIONS, 'angel')?.label).toBe('Angel')
    expect(findOptionById(OPTIONS, 'c')?.label).toBe('Angel')
    expect(findOptionByKey(OPTIONS, 'nobody')).toBeUndefined()
    expect(findOptionById(OPTIONS, 'z')).toBeUndefined()
  })
})

describe('matchOption', () => {
  it('prefers an exact key, then an exact label, then a case-insensitive one', () => {
    expect(unwrap(matchOption('investor', OPTIONS))).toBe('investor')
    expect(unwrap(matchOption('Founder', OPTIONS))).toBe('founder')
    expect(unwrap(matchOption('  FOUNDER  ', OPTIONS))).toBe('founder')
  })

  it('will not match an archived option', () => {
    expect(matchOption('Angel', OPTIONS).ok).toBe(false)
  })

  it('names the choices when nothing matches', () => {
    const result = matchOption('Operator', OPTIONS)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.issues[0]?.message).toMatch(/Investor, Founder, Other/)
    expect(result.ok ? undefined : result.issues[0]?.meta?.value).toBe('Operator')
  })

  it('refuses an empty cell and an attribute with nothing to choose from', () => {
    expect(matchOption('  ', OPTIONS).ok).toBe(false)
    expect(matchOption('investor', []).ok).toBe(false)
  })

  it('does not guess at a near miss — that is the wizard is value-mapping step', () => {
    expect(matchOption('Investors', OPTIONS).ok).toBe(false)
  })
})
