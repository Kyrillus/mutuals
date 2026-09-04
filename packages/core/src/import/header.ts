/**
 * Header matching for the import auto-mapper (ADR-044).
 *
 * **This is not the text contract, and it does not break ADR-019.** That rule — one normalisation,
 * and it is SQL — governs values that get compared against a normalised *column*: anything that
 * ends up beside one has to be produced by `mutuals_norm()`, or the comparison is a lie.
 * Nothing here ever touches a column. These functions compare a spreadsheet's header row against
 * the labels and slugs of attribute definitions already in memory, and the result is a proposed
 * mapping a human then confirms. The cost of being slightly wrong is a mapping card that starts on
 * the wrong target, which the user can see and change.
 *
 * ADR-044 called the normaliser `normalizeText`. No such function was ever written — the only
 * casefold in `packages/core` is `casefoldForDisplay`, which deliberately does not fold accents and
 * so cannot match "E-Mail" against "Email". `normalizeHeader` is what the ADR described.
 */

/**
 * A header, reduced to what two spellings of the same word have in common.
 *
 * Accents are folded here, unlike in `casefoldForDisplay`, because a header is a machine-generated
 * label from an export and folding it is the entire point: `Prénom` and `Prenom` are one column.
 * Underscores, hyphens, dots and slashes become spaces — ADR-044's "pre-step", and the reason it is
 * needed is that a slug is `first_name` while a header is `First Name`.
 */
export function normalizeHeader(input: string): string {
  return (
    input
      .normalize('NFKD')
      // Combining marks, so é -> e. NFKD also expands ﬁ and ½, which is wanted here.
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/\s+/gu, ' ')
  )
}

/**
 * The trigram set Postgres's `pg_trgm` would produce.
 *
 * Reimplemented rather than called over SQL because auto-mapping runs in `packages/core`, which
 * ships to the browser and may not open a connection. ADR-044 makes the 0.72 threshold part of the
 * contract, so the algorithm has to be the documented one rather than something similar: each word
 * is padded with two leading spaces and one trailing space, and the trigrams are a *set*.
 * `header.test.ts` pins the output against values measured from Postgres 16 itself.
 */
export function trigrams(input: string): ReadonlySet<string> {
  const set = new Set<string>()
  for (const word of normalizeHeader(input).split(' ')) {
    if (word === '') continue
    const padded = `  ${word} `
    for (let i = 0; i + 3 <= padded.length; i++) set.add(padded.slice(i, i + 3))
  }
  return set
}

/** Jaccard overlap of two trigram sets — what `similarity(text, text)` returns. */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a)
  const right = trigrams(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared++
  return shared / (left.size + right.size - shared)
}
