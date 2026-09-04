/**
 * The `tags` editor's rules, as pure functions.
 *
 * They are separate from the component because they are the interesting part — what counts as a
 * new tag, when two spellings are the same tag, what a pasted "Energy, Biotech" turns into — and
 * because a rule you can test without a DOM is a rule that stays true.
 *
 * Identity here is **display-only** casefolding, exactly as `tags.normalize` in `packages/core`
 * does it: whether `Café` and `Cafe` are one tag is decided by `mutuals_norm()` in SQL and by
 * nothing else (CLAUDE.md, ADR-019). This module only stops a list from containing the same
 * spelling twice.
 */
import { casefoldForDisplay, splitMultiValue } from '@mutuals/core'

/** One pasted or typed cell to the tags it contains. `;`, `,` and `|` all separate. */
export function parseTagInput(raw: string): string[] {
  return splitMultiValue(raw)
}

function key(tag: string): string {
  return casefoldForDisplay(tag.trim())
}

/** True when `tag` is already in the list, ignoring case and surrounding space. */
export function containsTag(tags: readonly string[], tag: string): boolean {
  const folded = key(tag)
  return tags.some((entry) => key(entry) === folded)
}

export interface TagAddition {
  readonly tags: readonly string[]
  /** The tags that were actually appended — empty when everything typed was already there. */
  readonly added: readonly string[]
  /** Of those, the ones that did not exist anywhere yet. §4.2's "created inline". */
  readonly created: readonly string[]
}

/**
 * Appends everything in `raw` that is not already present.
 *
 * `known` is the set of values seen on other records; a tag that is in neither list is a genuinely
 * new value, which is the case §4.2 asks for by name — a tag can be created here, without a trip
 * to Settings, because tags have no option table to add a row to.
 */
export function addTags(
  current: readonly string[],
  raw: string,
  known: readonly string[] = [],
): TagAddition {
  const tags = [...current]
  const added: string[] = []
  const created: string[] = []
  for (const candidate of parseTagInput(raw)) {
    if (containsTag(tags, candidate)) continue
    tags.push(candidate)
    added.push(candidate)
    if (!containsTag(known, candidate)) created.push(candidate)
  }
  return { tags, added, created }
}

export function removeTag(current: readonly string[], tag: string): readonly string[] {
  const folded = key(tag)
  return current.filter((entry) => key(entry) !== folded)
}

/**
 * Existing values worth offering: everything known, minus what is already on this record, that
 * contains the query. Ranked by where the match starts, so typing "en" offers "Energy" before
 * "Open source".
 */
export function suggestTags(
  known: readonly string[],
  current: readonly string[],
  query: string,
  limit = 8,
): readonly string[] {
  const folded = key(query)
  const candidates = known.filter((tag) => !containsTag(current, tag))
  const matched = folded === '' ? candidates : candidates.filter((tag) => key(tag).includes(folded))
  return matched
    .slice()
    .sort((a, b) => {
      const rank = key(a).indexOf(folded) - key(b).indexOf(folded)
      return rank !== 0 ? rank : a.localeCompare(b)
    })
    .slice(0, limit)
}

/** Whether the typed text would create a value nobody has used yet. */
export function isNewTag(
  known: readonly string[],
  current: readonly string[],
  query: string,
): boolean {
  const trimmed = query.trim()
  if (trimmed === '') return false
  return !containsTag(known, trimmed) && !containsTag(current, trimmed)
}
