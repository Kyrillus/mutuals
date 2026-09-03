import { fail, ok, type Result } from '../result.ts'

/**
 * Canonical website identity (brief §4.6).
 *
 * Identity is the **host**, so `northstar.vc/about` and `https://www.northstar.vc/` are the same
 * organisation. Deliberately no public-suffix list: it is a dependency carrying a data file with
 * an expiry date, and it would fold `blog.example.com` into `example.com`, which is not obviously
 * right. Host-level identity is predictable and explainable; the only thing lost is that two
 * records pointing at different subdomains of one company are not auto-linked.
 */

// Punycode TLDs (xn--…) carry digits and dashes, so the last label cannot simply be [a-z]{2,}.
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+)$/

export interface NormalizedWebsite {
  /** The host — what goes into `identifier.value`. */
  readonly identifier: string
  /** A canonical URL for the link the UI renders: scheme, host, path. No query, no fragment. */
  readonly url: string
  readonly host: string
}

/** Normalises a website reference. Returns `Result` — `new URL` throws on malformed input. */
export function normalizeWebsite(raw: string): Result<NormalizedWebsite> {
  const invalid = (): Result<never> => fail('invalid_website', `"${raw}" is not a website address.`)

  const text = raw.trim()
  if (text === '') return fail('required', 'Enter a website address.')

  // The scheme test excludes `.` so that `northstar.vc:8080` is read as a host and a port, not as
  // a scheme. Without it `mailto:anna@example.com` would be prefixed with `https://`, parse as
  // userinfo plus `example.com`, and quietly become that company's website.
  const scheme = /^[a-z][a-z0-9+-]*:/i.exec(text)
  if (scheme !== null && !/^https?:\/\//i.test(text)) return invalid()

  let url: URL
  try {
    url = new URL(scheme === null ? `https://${text}` : text)
  } catch {
    return invalid()
  }

  // The scheme gate above already refused everything that is not http(s), so only credentials
  // are left to reject -- `https://user:pass@example.com` is a login link, not a homepage.
  if (url.username !== '' || url.password !== '') return invalid()

  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '')
  if (!HOST_PATTERN.test(host)) return invalid()

  // URL already drops :443 for https and :80 for http; a non-default port is part of the address.
  const port = url.port === '' ? '' : `:${url.port}`
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')

  // Query and fragment are dropped: utm parameters are the common case, and a load-bearing query
  // string on a company homepage is not.
  return ok({ identifier: host, url: `${url.protocol}//${host}${port}${path}`, host })
}
