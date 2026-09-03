import { fail, ok, type Result } from '../result.ts'

/**
 * Canonical LinkedIn identity (brief §4.6).
 *
 * A LinkedIn profile URL arrives in a dozen shapes — a bare slug typed by hand, `in/slug`, a
 * regional host (`de.linkedin.com`), the mobile-lite path, the legacy `/pub/<slug>/1a/2b/3c` form,
 * a tracking query string, percent-encoded unicode. All of them name one profile, and the whole
 * value of the `identifier` table is that one profile is one row.
 */

export const LINKEDIN_KINDS = ['person', 'company', 'school'] as const

export type LinkedInKind = (typeof LINKEDIN_KINDS)[number]

export interface NormalizedLinkedIn {
  /** `in/anna-berger`, `company/northstar-ventures`, `school/tum` — what goes into `identifier`. */
  readonly identifier: string
  readonly url: string
  readonly kind: LinkedInKind
}

const PREFIX_KINDS: Readonly<Record<string, LinkedInKind>> = {
  in: 'person',
  pub: 'person',
  profile: 'person',
  company: 'company',
  school: 'school',
}

const KIND_PREFIX: Readonly<Record<LinkedInKind, string>> = {
  person: 'in',
  company: 'company',
  school: 'school',
}

const HOST_HEAD = /^([a-z0-9.-]+\.[a-z]{2,})(?=[/?#]|$)/i
const SLUG_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N}_-]*[\p{L}\p{N}])?$/u

function decodeSlug(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

/** Normalises any LinkedIn reference. Returns `Result` — this arrives from CSVs and forms. */
export function normalizeLinkedIn(raw: string): Result<NormalizedLinkedIn> {
  const invalid = (): Result<never> =>
    fail('invalid_linkedin_url', `"${raw}" is not a LinkedIn profile.`)

  let text = raw.trim()
  if (text === '') return fail('required', 'Enter a LinkedIn profile.')

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)
  if (scheme !== null) {
    const protocol = scheme[1]?.toLowerCase()
    if (protocol !== 'http' && protocol !== 'https') return invalid()
    text = text.slice(scheme[0].length)
  } else if (text.startsWith('//')) {
    text = text.slice(2)
  }

  const host = HOST_HEAD.exec(text)
  if (host !== null) {
    const hostname = (host[1] ?? '').toLowerCase().replace(/\.$/, '')
    if (hostname !== 'linkedin.com' && !hostname.endsWith('.linkedin.com')) return invalid()
    text = text.slice(host[0].length)
  }

  const path = text.split('#')[0]?.split('?')[0] ?? ''
  const rawParts = path.split('/').filter((part) => part !== '')
  if (rawParts.length === 0) return invalid()

  const decoded: string[] = []
  for (const part of rawParts) {
    const value = decodeSlug(part)
    if (value === null) return invalid()
    decoded.push(value.toLowerCase())
  }

  // `/mwlite/in/anna-berger` and `/m/in/anna-berger` are the same profile as `/in/anna-berger`.
  while (decoded.length > 1 && (decoded[0] === 'mwlite' || decoded[0] === 'm')) decoded.shift()

  const head = decoded[0] ?? ''
  const prefixKind = PREFIX_KINDS[head]

  // A bare slug with no prefix is a person: it is what somebody pastes out of a business card.
  const kind: LinkedInKind = prefixKind ?? 'person'
  const slug = prefixKind === undefined ? head : (decoded[1] ?? '')

  // The legacy /pub/<slug>/1a/2b/3c form carries three id fragments after the slug; everything
  // after the slug is discarded for every shape, which is also what drops /in/<slug>/details/...
  if (slug === '' || !SLUG_PATTERN.test(slug)) return invalid()

  const identifier = `${KIND_PREFIX[kind]}/${slug}`
  return ok({ identifier, url: `https://www.linkedin.com/${identifier}`, kind })
}
