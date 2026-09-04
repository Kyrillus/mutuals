import { describe, expect, it } from 'vitest'

import { cycleTriState, TRI_STATE_ORDER, triStateLabel } from './tri-state-model.ts'

describe('the tri-state switch', () => {
  it('has three states, and "empty" is one of them', () => {
    expect(TRI_STATE_ORDER).toEqual([true, false, undefined])
  })

  it('cycles forwards and wraps', () => {
    expect(cycleTriState(true)).toBe(false)
    expect(cycleTriState(false)).toBeUndefined()
    expect(cycleTriState(undefined)).toBe(true)
  })

  it('cycles backwards and wraps', () => {
    expect(cycleTriState(true, -1)).toBeUndefined()
    expect(cycleTriState(undefined, -1)).toBe(false)
    expect(cycleTriState(false, -1)).toBe(true)
  })

  it('returns to where it started after three steps', () => {
    for (const start of TRI_STATE_ORDER) {
      expect(cycleTriState(cycleTriState(cycleTriState(start)))).toBe(start)
    }
  })

  it('names every state', () => {
    expect(TRI_STATE_ORDER.map(triStateLabel)).toEqual(['Yes', 'No', 'Empty'])
  })
})
