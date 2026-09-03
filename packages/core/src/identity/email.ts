import { z } from 'zod'
import { fail, ok, type Result } from '../result.ts'

/**
 * Email normalisation for the `identifier` table (brief §4.6).
 *
 * `identifier` is `UNIQUE (workspace_id, kind, value)`, which is what makes duplicate detection a
 * single index probe instead of a similarity search.
 */

export const MAX_EMAIL_LENGTH = 320

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

// Zero-width and bidi marks arrive from copy-pasted signatures and vCards, and they are invisible
// in every UI that would show the user why their address does not match.
const INVISIBLE = /[\u200B-\u200F\u2060\uFEFF]/gu

export interface NormalizedEmail {
  /** What goes into `identifier.value`: lower-cased, domain punycoded. */
  readonly identifier: string
  /** What the attribute stores and the UI shows: the user's own spelling. */
  readonly display: string
  /**
   * A looser key used **only** as a duplicate signal, never stored as an identifier: `+tag`
   * dropped on every domain, and dots dropped for Gmail, which treats them as noise. Folding this
   * into `identifier.value` instead would make `anna+crm@x.com` and `anna@x.com` collide
   * permanently, so a user who deliberately keeps two addresses could never store the second one.
   */
  readonly matchKey: string
}

const emailSchema = z.email()

/** Normalises one email address. Returns `Result` — this arrives from CSVs and forms. */
export function normalizeEmail(raw: string): Result<NormalizedEmail> {
  let text = raw.normalize('NFKC').replace(INVISIBLE, '').trim()
  text = text.replace(/^mailto:/i, '').trim()
  if (text.startsWith('<') && text.endsWith('>')) text = text.slice(1, -1).trim()

  if (text === '') return fail('required', 'Enter an email address.')
  if (text.length > MAX_EMAIL_LENGTH) {
    return fail('too_long', `An email address can be at most ${MAX_EMAIL_LENGTH} characters.`)
  }

  const at = text.indexOf('@')
  if (at < 1 || at !== text.lastIndexOf('@') || at === text.length - 1) {
    return fail('invalid_email', `"${raw}" is not an email address.`)
  }

  const local = text.slice(0, at)
  const rawDomain = text.slice(at + 1)

  // Round-tripping through URL is the punycode encoder Node already ships; an IDN dependency
  // would buy nothing here.
  let domain: string
  try {
    domain = new URL(`http://${rawDomain}`).hostname
  } catch {
    return fail('invalid_email', `"${raw}" is not an email address.`)
  }
  domain = domain.replace(/\.$/, '')

  const identifier = `${local.toLowerCase()}@${domain.toLowerCase()}`
  if (!emailSchema.safeParse(identifier).success) {
    return fail('invalid_email', `"${raw}" is not an email address.`)
  }

  return ok({ identifier, display: text, matchKey: emailMatchKey(identifier) })
}

/**
 * The duplicate-detection key for an already-normalised address. Exported because the importer
 * computes it for both sides of a comparison.
 */
export function emailMatchKey(identifier: string): string {
  const at = identifier.lastIndexOf('@')
  if (at < 1) return identifier
  const domain = identifier.slice(at + 1)
  let local = identifier.slice(0, at)
  const plus = local.indexOf('+')
  if (plus >= 0) local = local.slice(0, plus)
  if (GMAIL_DOMAINS.has(domain)) {
    return `${local.replaceAll('.', '')}@gmail.com`
  }
  return `${local}@${domain}`
}
