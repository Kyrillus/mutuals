/**
 * Live validation for the create/edit dialog, keyed exactly like the API's `errors` array.
 *
 * Same keys on purpose: `title`, `slug`, `options`, `options.<i>.label`, `config.decimals`. The
 * dialog merges this map with `fieldErrors(apiFailure)` and renders one message under one control,
 * so a rule that moves from the client to the server — or the other way — changes nothing on
 * screen. §7's per-field contract is the reason the API sends that array at all.
 *
 * The messages a person will actually hit are the ones `packages/core` already writes:
 * `validateSlug` says *which* rule a slug broke, and this file passes that sentence through
 * verbatim rather than degrading it to "invalid".
 */
import { validateSlug, type ObjectType } from '@mutuals/core'

import { hasOptions, type AttributeDraft } from './draft.ts'

/** The reference screenshot's wording, and ADR-038's, with no full stop. */
export const TITLE_REQUIRED = 'Title is required'
export const OPTIONS_REQUIRED = 'Add at least one option'

export const MAX_TITLE_LENGTH = 120
export const MAX_OPTION_LABEL_LENGTH = 120
export const MAX_UNIT_LENGTH = 16
export const MAX_DECIMALS = 10

export type Mode = 'create' | 'edit'

export interface ValidationContext {
  readonly mode: Mode
  /** Every slug already in use for this object type, so a clash is named before Save is pressed. */
  readonly takenSlugs: ReadonlySet<string>
  readonly objectType: ObjectType
  /** `decimals` as it is stored today; `PATCH` merges config, so it cannot be removed (see below). */
  readonly savedDecimals?: number | undefined
}

export function validateDraft(
  draft: AttributeDraft,
  ctx: ValidationContext,
): ReadonlyMap<string, string> {
  const issues = new Map<string, string>()

  const title = draft.title.trim()
  if (title === '') issues.set('title', TITLE_REQUIRED)
  else if (title.length > MAX_TITLE_LENGTH) {
    issues.set('title', `Use at most ${String(MAX_TITLE_LENGTH)} characters.`)
  }

  // On edit the field is locked, so validating it would report a problem nobody can fix.
  if (ctx.mode === 'create') {
    const slug = validateSlug(draft.slug, {
      objectType: ctx.objectType,
      taken: ctx.takenSlugs,
    })
    if (!slug.ok) {
      const first = slug.issues[0]
      if (first !== undefined) issues.set('slug', first.message)
    }
  }

  if (hasOptions(draft.type)) validateOptions(draft, issues)
  if (draft.type === 'number') validateNumber(draft, ctx, issues)

  return issues
}

function validateOptions(draft: AttributeDraft, issues: Map<string, string>): void {
  // ADR-038: `z.enum([])` builds fine and then rejects every value with a message that names
  // nothing, so the impossible state is refused instead of handled.
  if (draft.options.length === 0) {
    issues.set('options', OPTIONS_REQUIRED)
    return
  }

  const seen = new Map<string, number>()
  draft.options.forEach((option, index) => {
    const field = `options.${String(index)}.label`
    const label = option.label.trim()
    if (label === '') {
      issues.set(field, 'A label is required.')
      return
    }
    if (label.length > MAX_OPTION_LABEL_LENGTH) {
      issues.set(field, `Use at most ${String(MAX_OPTION_LABEL_LENGTH)} characters.`)
      return
    }
    // The API refuses two options with the same label; catching it here says so beside the second
    // one rather than after a round trip that names an index.
    const folded = label.toLocaleLowerCase()
    const first = seen.get(folded)
    if (first === undefined) seen.set(folded, index)
    else issues.set(field, `"${label}" is already an option.`)
  })
}

function validateNumber(
  draft: AttributeDraft,
  ctx: ValidationContext,
  issues: Map<string, string>,
): void {
  if (draft.number.unit.trim().length > MAX_UNIT_LENGTH) {
    issues.set('config.unit', `Use at most ${String(MAX_UNIT_LENGTH)} characters.`)
  }

  const raw = draft.number.decimals.trim()
  if (raw === '') {
    // `PATCH /attribute-definitions/:id` merges `config` into what is stored, so an absent key
    // means "leave it alone". There is no way to spell "remove `decimals`" on this API, and
    // silently discarding the change would be worse than saying so.
    if (ctx.mode === 'edit' && ctx.savedDecimals !== undefined) {
      issues.set(
        'config.decimals',
        `Decimal places cannot be cleared once saved — it stays at ${String(ctx.savedDecimals)}. ` +
          'Enter a number, or delete the field and create it again.',
      )
    }
    return
  }

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_DECIMALS) {
    issues.set(
      'config.decimals',
      `Enter a whole number between 0 and ${String(MAX_DECIMALS)}, or leave it empty.`,
    )
  }
}

/** Whether Save may be pressed at all. */
export function isValid(issues: ReadonlyMap<string, string>): boolean {
  return issues.size === 0
}

/**
 * The client's map merged with the server's, server last: once a request has come back with a
 * message about a field, that message is the truthful one.
 */
export function mergeIssues(
  local: ReadonlyMap<string, string>,
  remote: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  if (remote.size === 0) return local
  return new Map([...local, ...remote])
}
