import { describe, expect, it } from 'vitest'
import { civil } from '../time/civil.ts'
import {
  FOLLOW_UP_STATUSES,
  followUpState,
  isOpen,
  isOverdue,
  needsAttention,
  type FollowUpStatus,
} from './state.ts'

const TODAY = civil('2026-09-03')

describe('followUpState', () => {
  it('splits an open follow-up on the day boundary', () => {
    expect(followUpState({ status: 'Open', dueAt: civil('2026-09-02') }, TODAY)).toBe('overdue')
    expect(followUpState({ status: 'Open', dueAt: TODAY }, TODAY)).toBe('due_today')
    expect(followUpState({ status: 'Open', dueAt: civil('2026-09-04') }, TODAY)).toBe('upcoming')
  })

  it('lets the stored status win over the date', () => {
    expect(followUpState({ status: 'Done', dueAt: civil('2020-01-01') }, TODAY)).toBe('done')
    expect(followUpState({ status: 'Snoozed', dueAt: civil('2020-01-01') }, TODAY)).toBe('snoozed')
  })

  it('answers for every status the database allows', () => {
    for (const status of FOLLOW_UP_STATUSES) {
      expect(followUpState({ status, dueAt: TODAY }, TODAY)).toBeTruthy()
    }
  })
})

describe('isOverdue', () => {
  it('is what paints a due date red', () => {
    expect(isOverdue({ status: 'Open', dueAt: civil('2026-09-02') }, TODAY)).toBe(true)
    expect(isOverdue({ status: 'Open', dueAt: TODAY }, TODAY)).toBe(false)
    expect(isOverdue({ status: 'Done', dueAt: civil('2020-01-01') }, TODAY)).toBe(false)
  })
})

describe('isOpen', () => {
  it('counts only Open towards open_followups', () => {
    expect(isOpen({ status: 'Open', dueAt: TODAY })).toBe(true)
    expect(isOpen({ status: 'Snoozed', dueAt: TODAY })).toBe(false)
    expect(isOpen({ status: 'Done', dueAt: TODAY })).toBe(false)
  })
})

describe('needsAttention', () => {
  it('covers overdue, today, and the next seven days inclusive', () => {
    expect(needsAttention({ status: 'Open', dueAt: civil('2026-08-01') }, TODAY)).toBe(true)
    expect(needsAttention({ status: 'Open', dueAt: TODAY }, TODAY)).toBe(true)
    expect(needsAttention({ status: 'Open', dueAt: civil('2026-09-10') }, TODAY)).toBe(true)
    expect(needsAttention({ status: 'Open', dueAt: civil('2026-09-11') }, TODAY)).toBe(false)
  })

  it('takes a different horizon', () => {
    expect(needsAttention({ status: 'Open', dueAt: civil('2026-09-11') }, TODAY, 30)).toBe(true)
  })

  it('never nags about something already done or snoozed', () => {
    expect(needsAttention({ status: 'Done', dueAt: civil('2020-01-01') }, TODAY)).toBe(false)
    expect(needsAttention({ status: 'Snoozed', dueAt: civil('2020-01-01') }, TODAY)).toBe(false)
  })
})

describe('the exhaustiveness guard', () => {
  it('throws on a status the database CHECK does not allow', () => {
    expect(() =>
      followUpState({ status: 'Abandoned' as FollowUpStatus, dueAt: TODAY }, TODAY),
    ).toThrow(/follow-up status/)
  })
})
