import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALL_ERROR_CODES } from '@mutuals/core'

/**
 * Every error response carries a `type` URI pointing at an anchor in docs/ERRORS.md. A `type` that
 * resolves to nothing is worse than no link at all — it promises an explanation and then wastes the
 * reader's time — so the document is checked rather than trusted.
 *
 * This also catches the other direction: a documented code that no longer exists is a paragraph
 * describing something that can never happen, which is how documentation starts lying.
 */
const ERRORS_MD = fileURLToPath(new URL('../../../../docs/ERRORS.md', import.meta.url))

function documentedCodes(): string[] {
  const markdown = readFileSync(ERRORS_MD, 'utf8')
  return [...markdown.matchAll(/^### ([a-z_]+)$/gm)].map((match) => match[1] as string)
}

describe('docs/ERRORS.md', () => {
  it('documents every error code the API can emit', () => {
    const documented = new Set(documentedCodes())
    const missing = ALL_ERROR_CODES.filter((code) => !documented.has(code))
    expect(missing).toEqual([])
  })

  it('documents no code that does not exist', () => {
    const known = new Set<string>(ALL_ERROR_CODES)
    const orphaned = documentedCodes().filter((code) => !known.has(code))
    expect(orphaned).toEqual([])
  })
})
