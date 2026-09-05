/**
 * §6.9's merge, as a contract.
 *
 * Three operations, all three reserved in `PLANNED_OPERATIONS` since Stage 1 — the last three, and
 * the only ones left after Session A.
 *
 * The preview is a separate operation rather than a flag on the merge, because §6.9 requires a
 * side-by-side *before* anything happens and the merge itself cannot be undone. Two calls also mean
 * the confirmation dialog is showing what the server will actually do rather than what the client
 * believes it will do.
 */
import { z } from 'zod'

import { ObjectTypeSchema, UuidSchema } from './primitives.ts'

/**
 * One row of the side-by-side.
 *
 * `slug` and `label` come from the attribute definitions, so a field invented in Settings appears
 * here with no code change — the one rule, applied to a screen that is all about fields.
 */
export const MergeFieldSchema = z.object({
  /** Absent for a system column, which has no attribute behind it. */
  attributeId: UuidSchema.nullable(),
  slug: z.string(),
  label: z.string(),
  /** How the survivor's value reads. `null` means it has none. */
  survivor: z.string().nullable(),
  loser: z.string().nullable(),
  /**
   * Both have a value and they differ, so §6.9's radio per field has a real choice to make.
   *
   * A field only one of them has is not a conflict: the merge takes it, and offering a radio would
   * ask the user to choose between a value and nothing.
   */
  conflicting: z.boolean(),
  /** A set rather than a single value — tags, multi-select, organizations. Merged as a union. */
  isMulti: z.boolean(),
})

export const MergePreviewSchema = z.object({
  objectType: ObjectTypeSchema,
  survivor: z.object({ id: UuidSchema, label: z.string() }),
  loser: z.object({ id: UuidSchema, label: z.string() }),
  fields: z.array(MergeFieldSchema),
  /** What §6.9 promises moves. Shown in the confirmation, because it is the irreversible part. */
  moves: z.object({
    interactions: z.int(),
    followUps: z.int(),
    /** Records that link to the loser and will be repointed at the survivor. */
    incomingLinks: z.int(),
  }),
  /** Fields where a choice is genuinely open. The dialog can say "3 fields need a decision". */
  conflictCount: z.int(),
})

export type MergePreview = z.output<typeof MergePreviewSchema>
export type MergeField = z.output<typeof MergeFieldSchema>

export const MergePreviewQuerySchema = z.object({
  /** The record being absorbed. The survivor is the one in the path. */
  loserId: UuidSchema,
})

export const MergeRecordsSchema = z.object({
  loserId: UuidSchema,
  /**
   * Attribute id to which side wins. Anything unnamed keeps the survivor's value.
   *
   * Keyed by attribute id rather than slug because a slug is unique per object type and the merge
   * already knows the type — but the id is what the write path takes, and translating in the client
   * would put a lookup between the radio the user clicked and the field it names.
   */
  choices: z.record(UuidSchema, z.enum(['survivor', 'loser'])).default({}),
})

export const MergeResultSchema = z.object({
  survivorId: UuidSchema,
  /** Counts, so the toast can say what happened rather than "done". */
  factsMoved: z.int(),
  followUpsMoved: z.int(),
  interactionsMoved: z.int(),
  linksRepointed: z.int(),
  conflictsResolved: z.int(),
})

export type MergeResultDto = z.output<typeof MergeResultSchema>
