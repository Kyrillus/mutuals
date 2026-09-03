import { describe, expect, it } from 'vitest'
import { unwrap } from '../result.ts'
import { normalizeLinkedIn } from './linkedin.ts'

function idOf(raw: string): string {
  return unwrap(normalizeLinkedIn(raw)).identifier
}

describe('normalizeLinkedIn', () => {
  /** All of these name one profile, and the identifier table's whole value is one row per profile. */
  it.each([
    'anna-berger',
    'in/anna-berger',
    '/in/anna-berger',
    'linkedin.com/in/anna-berger',
    'www.linkedin.com/in/anna-berger',
    'https://www.linkedin.com/in/anna-berger',
    'https://www.linkedin.com/in/anna-berger/',
    'http://linkedin.com/in/anna-berger',
    'https://de.linkedin.com/in/anna-berger?originalSubdomain=de',
    'https://m.linkedin.com/in/anna-berger',
    'https://www.linkedin.com/mwlite/in/anna-berger',
    'https://www.linkedin.com/in/Anna-Berger#experience',
    'https://www.linkedin.com/in/anna-berger/details/experience/',
    'https://www.linkedin.com/pub/anna-berger/1a/2b/3c',
    '//www.linkedin.com/in/anna-berger',
  ])('canonicalises %s', (raw) => {
    expect(idOf(raw)).toBe('in/anna-berger')
  })

  it('builds a canonical url', () => {
    expect(unwrap(normalizeLinkedIn('de.linkedin.com/in/anna-berger'))).toEqual({
      identifier: 'in/anna-berger',
      url: 'https://www.linkedin.com/in/anna-berger',
      kind: 'person',
    })
  })

  it('decodes a percent-encoded unicode slug', () => {
    expect(idOf('https://www.linkedin.com/in/anna-b%C3%B6hm')).toBe('in/anna-böhm')
  })

  it('recognises companies and schools', () => {
    expect(
      unwrap(normalizeLinkedIn('https://www.linkedin.com/company/northstar-ventures/')),
    ).toEqual({
      identifier: 'company/northstar-ventures',
      url: 'https://www.linkedin.com/company/northstar-ventures',
      kind: 'company',
    })
    expect(unwrap(normalizeLinkedIn('linkedin.com/school/tum')).kind).toBe('school')
  })

  it.each([
    ['a non-LinkedIn host', 'https://example.com/in/anna-berger'],
    ['a lookalike host', 'https://linkedin.com.evil.example/in/anna'],
    ['a non-http scheme', 'ftp://linkedin.com/in/anna'],
    ['a host with no path', 'https://www.linkedin.com/'],
    ['a bare prefix', 'in/'],
    ['broken percent-encoding', 'https://www.linkedin.com/in/anna%E0%A4'],
    ['a slug that is only punctuation', 'https://www.linkedin.com/in/---'],
    ['nothing', '   '],
  ])('refuses %s', (_label, raw) => {
    expect(normalizeLinkedIn(raw).ok).toBe(false)
  })

  it('reports a blank input as missing rather than malformed', () => {
    const result = normalizeLinkedIn('')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe('required')
  })

  it('reports a wrong host as an invalid LinkedIn url', () => {
    const result = normalizeLinkedIn('https://xing.com/profile/anna')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe('invalid_linkedin_url')
  })

  it('is idempotent, so re-importing an export cannot produce a second row', () => {
    const once = unwrap(normalizeLinkedIn('https://de.linkedin.com/in/Anna-Berger/'))
    const twice = unwrap(normalizeLinkedIn(once.url))
    expect(twice).toEqual(once)
  })
})
