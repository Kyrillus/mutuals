import { describe, expect, it } from 'vitest'

import { decodeCursor, encodeCursor } from './cursor.ts'

describe('the opaque list cursor', () => {
  it('round-trips a keyset position', () => {
    const page = {
      mode: 'keyset',
      createdAt: '2026-06-15T09:00:00.000Z',
      id: '11111111-1111-4111-8111-111111111111',
    } as const
    expect(decodeCursor(encodeCursor(page))).toEqual({ ok: true, value: page })
  })

  it('round-trips an offset position', () => {
    const page = { mode: 'offset', offset: 150 } as const
    expect(decodeCursor(encodeCursor(page))).toEqual({ ok: true, value: page })
  })

  it('is base64url, so it survives a query string without escaping', () => {
    const token = encodeCursor({ mode: 'offset', offset: 999999 })
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(encodeURIComponent(token)).toBe(token)
  })

  it('says nothing about the mode to a reader', () => {
    // Opacity is the point (ADR-023): a client that parses this and depends on `offset` breaks the
    // day the offset variant becomes a keyset walk.
    expect(encodeCursor({ mode: 'offset', offset: 50 })).not.toContain('offset')
  })

  for (const [label, raw] of [
    ['not base64', '!!!!'],
    ['not JSON', Buffer.from('nonsense', 'utf8').toString('base64url')],
    ['not an object', Buffer.from('42', 'utf8').toString('base64url')],
    ['an unknown mode', Buffer.from('{"m":"x"}', 'utf8').toString('base64url')],
    ['a negative offset', Buffer.from('{"m":"o","o":-1}', 'utf8').toString('base64url')],
    ['a fractional offset', Buffer.from('{"m":"o","o":1.5}', 'utf8').toString('base64url')],
    [
      'a keyset with no id',
      Buffer.from('{"m":"k","t":"2026-01-01"}', 'utf8').toString('base64url'),
    ],
  ] as const) {
    it(`refuses ${label} with an issue rather than throwing`, () => {
      const result = decodeCursor(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.issues[0]?.path).toEqual(['cursor'])
        expect(result.issues[0]?.message).toContain('Start from the first page')
      }
    })
  }
})
