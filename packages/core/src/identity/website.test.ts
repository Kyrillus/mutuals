import { describe, expect, it } from 'vitest'
import { unwrap } from '../result.ts'
import { normalizeWebsite } from './website.ts'

describe('normalizeWebsite', () => {
  it('adds a scheme and lower-cases the host', () => {
    expect(unwrap(normalizeWebsite('Northstar.VC'))).toEqual({
      identifier: 'northstar.vc',
      url: 'https://northstar.vc',
      host: 'northstar.vc',
    })
  })

  it('strips www., the default port and a trailing slash', () => {
    expect(unwrap(normalizeWebsite('https://www.northstar.vc:443/'))).toEqual({
      identifier: 'northstar.vc',
      url: 'https://northstar.vc',
      host: 'northstar.vc',
    })
  })

  it('keeps a non-default port', () => {
    expect(unwrap(normalizeWebsite('http://northstar.vc:8080/team')).url).toBe(
      'http://northstar.vc:8080/team',
    )
  })

  /** utm parameters are the common case; a load-bearing query on a homepage is not. */
  it('drops the query and the fragment', () => {
    expect(unwrap(normalizeWebsite('https://northstar.vc/about?utm_source=x#team')).url).toBe(
      'https://northstar.vc/about',
    )
  })

  it('makes a path and its host the same organisation', () => {
    expect(unwrap(normalizeWebsite('northstar.vc/about')).identifier).toBe(
      unwrap(normalizeWebsite('https://www.northstar.vc')).identifier,
    )
  })

  /**
   * Deliberate: no public-suffix list, so a subdomain is its own identity. The cost is that two
   * records pointing at different subdomains of one company are not auto-linked; the benefit is
   * no data file with an expiry date and no surprise merge of `blog.example.com`.
   */
  it('treats a subdomain as its own identity', () => {
    expect(unwrap(normalizeWebsite('blog.example.com')).identifier).toBe('blog.example.com')
  })

  it('punycodes an internationalised host', () => {
    expect(unwrap(normalizeWebsite('münchen.de')).host).toBe('xn--mnchen-3ya.de')
  })

  it('drops a trailing dot', () => {
    expect(unwrap(normalizeWebsite('https://example.com.')).host).toBe('example.com')
  })

  it.each([
    ['a blank string', '   ', 'required'],
    ['a space in the host', 'a b.com', 'invalid_website'],
    ['an empty label', 'https://a..b', 'invalid_website'],
    ['a bare hostname with no dot', 'localhost', 'invalid_website'],
    ['a non-http scheme', 'ftp://example.com', 'invalid_website'],
    ['a mailto', 'mailto:anna@example.com', 'invalid_website'],
    ['an embedded credential', 'https://user:pass@example.com', 'invalid_website'],
    ['a javascript uri', 'javascript:alert(1)', 'invalid_website'],
    ['a scheme with no host', 'https://', 'invalid_website'],
  ])('refuses %s', (_label, raw, code) => {
    const result = normalizeWebsite(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe(code)
  })

  it('is idempotent', () => {
    const once = unwrap(normalizeWebsite('WWW.Northstar.VC/about/?utm_source=x'))
    expect(unwrap(normalizeWebsite(once.url))).toEqual(once)
  })
})
