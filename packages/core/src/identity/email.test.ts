import { describe, expect, it } from 'vitest'
import { unwrap } from '../result.ts'
import { emailMatchKey, normalizeEmail } from './email.ts'

function identifierOf(raw: string): string {
  return unwrap(normalizeEmail(raw)).identifier
}

describe('normalizeEmail', () => {
  it('lower-cases and trims', () => {
    expect(identifierOf('  Anna.Berger@Example.COM ')).toBe('anna.berger@example.com')
  })

  it('keeps the user’s own spelling for display', () => {
    expect(unwrap(normalizeEmail(' Anna.Berger@Example.COM ')).display).toBe(
      'Anna.Berger@Example.COM',
    )
  })

  it('strips the shapes a mail client pastes', () => {
    expect(identifierOf('mailto:anna@example.com')).toBe('anna@example.com')
    expect(identifierOf('MAILTO:Anna@Example.com')).toBe('anna@example.com')
    expect(identifierOf('<anna@example.com>')).toBe('anna@example.com')
  })

  it('strips zero-width characters copied out of a signature', () => {
    expect(identifierOf('anna​@example.com')).toBe('anna@example.com')
  })

  it('punycodes an internationalised domain', () => {
    expect(identifierOf('anna@münchen.de')).toBe('anna@xn--mnchen-3ya.de')
  })

  it('drops a trailing dot on the domain', () => {
    expect(identifierOf('anna@example.com.')).toBe('anna@example.com')
  })

  it('keeps a plus tag in the stored identifier', () => {
    expect(identifierOf('anna+crm@example.com')).toBe('anna+crm@example.com')
  })

  it.each([
    ['blank', '   ', 'required'],
    ['no at sign', 'anna.example.com', 'invalid_email'],
    ['two at signs', 'anna@@example.com', 'invalid_email'],
    ['nothing before the at', '@example.com', 'invalid_email'],
    ['nothing after the at', 'anna@', 'invalid_email'],
    ['a space in the domain', 'anna@exa mple.com', 'invalid_email'],
    ['no dot in the domain', 'anna@localhost', 'invalid_email'],
  ])('refuses %s', (_label, raw, code) => {
    const result = normalizeEmail(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe(code)
  })

  it('refuses an address longer than the RFC allows', () => {
    const result = normalizeEmail(`${'a'.repeat(320)}@example.com`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe('too_long')
  })
})

describe('emailMatchKey', () => {
  it('drops a plus tag on every domain', () => {
    expect(emailMatchKey('anna+crm@example.com')).toBe('anna@example.com')
    expect(emailMatchKey('anna+crm@gmail.com')).toBe('anna@gmail.com')
  })

  it('drops dots for Gmail, which treats them as noise', () => {
    expect(emailMatchKey('anna.berger@gmail.com')).toBe('annaberger@gmail.com')
    expect(emailMatchKey('anna.berger@googlemail.com')).toBe('annaberger@gmail.com')
  })

  it('keeps dots everywhere else, because elsewhere they are part of the address', () => {
    expect(emailMatchKey('anna.berger@example.com')).toBe('anna.berger@example.com')
  })

  it('is a duplicate signal only — it never replaces the stored identifier', () => {
    const tagged = unwrap(normalizeEmail('anna+crm@example.com'))
    expect(tagged.identifier).toBe('anna+crm@example.com')
    expect(tagged.matchKey).toBe('anna@example.com')
    // Folding the match key into the identifier would make these two collide permanently, so a
    // user who deliberately keeps both addresses could never store the second.
    expect(tagged.identifier).not.toBe(unwrap(normalizeEmail('anna@example.com')).identifier)
    expect(tagged.matchKey).toBe(unwrap(normalizeEmail('anna@example.com')).matchKey)
  })

  it('leaves a string with no at sign alone', () => {
    expect(emailMatchKey('not-an-address')).toBe('not-an-address')
  })
})
