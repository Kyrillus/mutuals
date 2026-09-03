import { assertNever } from '../result.ts'
import { addDays, compareCivil, type CivilDate } from '../time/civil.ts'

/**
 * One definition of "overdue" (brief §6.1, §6.4).
 *
 * Three surfaces read this: the dashboard's "Needs your attention" list, the red due-date styling
 * in the follow-ups table, and the `open_followups` / `next_followup_at` metrics. With three
 * copies they disagree at midnight — and `today` is injected, so which midnight is the profile's,
 * not the server's.
 */

export const FOLLOW_UP_STATUSES = ['Open', 'Done', 'Snoozed'] as const

export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number]

export const FOLLOW_UP_STATES = ['done', 'snoozed', 'overdue', 'due_today', 'upcoming'] as const

export type FollowUpState = (typeof FOLLOW_UP_STATES)[number]

export interface FollowUpLike {
  readonly status: FollowUpStatus
  readonly dueAt: CivilDate
}

/** The stored status wins over the date: a done follow-up is done, however overdue it once was. */
export function followUpState(followUp: FollowUpLike, today: CivilDate): FollowUpState {
  switch (followUp.status) {
    case 'Done':
      return 'done'
    case 'Snoozed':
      return 'snoozed'
    case 'Open': {
      const order = compareCivil(followUp.dueAt, today)
      return order < 0 ? 'overdue' : order === 0 ? 'due_today' : 'upcoming'
    }
    default:
      return assertNever(followUp.status, 'follow-up status')
  }
}

/** Whether the row gets the red due date §6.4 asks for. */
export function isOverdue(followUp: FollowUpLike, today: CivilDate): boolean {
  return followUpState(followUp, today) === 'overdue'
}

/** Counts towards `open_followups` and the dashboard's attention list. */
export function isOpen(followUp: FollowUpLike): boolean {
  return followUp.status === 'Open'
}

/** What the dashboard's "Needs your attention" list shows: overdue plus the next seven days. */
export function needsAttention(followUp: FollowUpLike, today: CivilDate, withinDays = 7): boolean {
  const state = followUpState(followUp, today)
  if (state === 'overdue' || state === 'due_today') return true
  if (state !== 'upcoming') return false
  return compareCivil(followUp.dueAt, addDays(today, withinDays)) <= 0
}
