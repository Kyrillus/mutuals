/**
 * A DISPLAY-ONLY casefold.
 *
 * This is **not** the filter contract. Text matching is defined by `mutuals_norm()` in SQL and by
 * nothing else (ADR-019): TypeScript never produces a value that is compared against a normalised
 * database column, and nothing anywhere asserts that this function and `mutuals_norm()` agree —
 * they do not, and they are not meant to. `'İstanbul'.toLowerCase()` is `i̇stanbul` where Postgres
 * `lower()` gives `istanbul`; `unaccent` maps `ß` to `ss` and expands `ﬁ`, `ĳ`, `Ⅷ`. Chasing that
 * agreement means hand-porting `unaccent.rules` and locale case-folding into TypeScript forever.
 *
 * What it is for: local UI conveniences where the only cost of being slightly wrong is a duplicate
 * suggestion in a dropdown — deduplicating tag suggestions as the user types, and case-insensitive
 * client-side matching inside an already-fetched list. Deliberately no accent folding: pretending
 * to fold accents is what would make this look like the filter contract.
 */

/** Lower-cases, collapses whitespace and trims. Idempotent. */
export function casefoldForDisplay(input: string): string {
  return input.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

/**
 * Drops values that differ only by case or surrounding whitespace, keeping the first spelling the
 * user saw. Blank values are dropped.
 */
export function dedupeByCasefold(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const value of values) {
    const key = casefoldForDisplay(value)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    kept.push(value)
  }
  return kept
}
