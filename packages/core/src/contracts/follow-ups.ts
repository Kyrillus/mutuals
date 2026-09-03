/**
 * Follow-ups on the wire (§4.1, §6.4).
 *
 * `state` is derived and read-only: it is `followUpState()` evaluated against the profile's today,
 * so the red due date in the table, the dashboard's attention list and the `open_followups` metric
 * cannot disagree about what "overdue" means at midnight.
 */
import { z } from 'zod'

import { FOLLOW_UP_STATES, FOLLOW_UP_STATUSES } from '../followups/state.ts'
import { recurrenceSchema } from '../followups/recurrence.ts'
import { FOLLOW_UP_ORIGINS } from './shared.ts'
import { CivilDateSchema, IsoDateTimeSchema, RecordRefSchema, UuidSchema } from './primitives.ts'

export const FollowUpStatusSchema = z.enum(FOLLOW_UP_STATUSES)
export const FollowUpStateSchema = z.enum(FOLLOW_UP_STATES)

export const FollowUpSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  contact: RecordRefSchema,
  dueAt: CivilDateSchema,
  status: FollowUpStatusSchema,
  state: FollowUpStateSchema,
  /** `null` is "does not repeat" — one spelling, matching the nullable column (ADR-043). */
  recurrence: recurrenceSchema.nullable(),
  origin: z.enum(FOLLOW_UP_ORIGINS),
  notes: z.string().nullable(),
  completedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})

export type FollowUp = z.output<typeof FollowUpSchema>

export const CreateFollowUpSchema = z.object({
  title: z.string().trim().min(1).max(300),
  contactId: UuidSchema,
  dueAt: CivilDateSchema,
  status: FollowUpStatusSchema.optional(),
  recurrence: recurrenceSchema.nullish(),
  notes: z.string().max(10_000).nullish(),
})

export type CreateFollowUp = z.output<typeof CreateFollowUpSchema>

/**
 * Marking a recurring follow-up done creates the next occurrence (§4.1). That happens inside this
 * one operation, and the response says which one was created, so the client never has to sequence
 * "complete" and "create next" and never has to know the recurrence rules.
 */
export const UpdateFollowUpSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  contactId: UuidSchema.optional(),
  dueAt: CivilDateSchema.optional(),
  status: FollowUpStatusSchema.optional(),
  recurrence: recurrenceSchema.nullish(),
  notes: z.string().max(10_000).nullish(),
})

export const UpdateFollowUpResponseSchema = z.object({
  data: FollowUpSchema,
  /** The occurrence a recurring follow-up spawned when it was marked done; `null` otherwise. */
  next: FollowUpSchema.nullable(),
})

/** §6.4's quick filter tabs, plus the dashboard's "due this week" card. */
export const FollowUpListQuerySchema = z.object({
  status: FollowUpStatusSchema.optional(),
  state: FollowUpStateSchema.optional(),
  contactId: UuidSchema.optional(),
  dueBefore: CivilDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(512).optional(),
})

/** §6.4's bulk actions: mark done, reassign a due date, delete. */
export const BulkUpdateFollowUpsSchema = z.object({
  ids: z.array(UuidSchema).min(1).max(500),
  status: FollowUpStatusSchema.optional(),
  dueAt: CivilDateSchema.optional(),
})
