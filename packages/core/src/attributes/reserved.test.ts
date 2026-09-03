import { describe, expect, it } from 'vitest'

import { allSystemSlugs } from '../fields/system.ts'
import { OBJECT_TYPES } from './kinds.ts'
import { HAZARD_SLUGS, isReservedSlug, reservationReason, reservedSlugs } from './reserved.ts'

describe('reserved slugs', () => {
  it('derives the first tier from the field registry, so it cannot drift', () => {
    for (const objectType of OBJECT_TYPES) {
      for (const slug of allSystemSlugs(objectType)) {
        expect(isReservedSlug(slug, objectType), `${objectType}.${slug}`).toBe(true)
        expect(reservationReason(slug, objectType)).toBe('system_field')
      }
    }
  })

  it('reserves the JavaScript hazards for every object type', () => {
    for (const objectType of OBJECT_TYPES) {
      for (const slug of HAZARD_SLUGS) {
        expect(isReservedSlug(slug, objectType)).toBe(true)
        expect(reservationReason(slug, objectType)).toBe('hazard')
      }
    }
  })

  it('is exactly two tiers', () => {
    expect([...HAZARD_SLUGS].sort()).toEqual(['__proto__', 'constructor', 'prototype'])
    expect(reservedSlugs('contact').size).toBe(
      allSystemSlugs('contact').length + HAZARD_SLUGS.length,
    )
  })

  it('reserves nothing else — no SQL key words, no query-string parameter names', () => {
    for (const slug of ['select', 'order', 'user', 'left', 'filter', 'sort', 'limit', 'q', 'id']) {
      expect(isReservedSlug(slug, 'contact'), slug).toBe(false)
      expect(reservationReason(slug, 'contact')).toBeUndefined()
    }
  })

  it('is scoped per object type', () => {
    expect(isReservedSlug('warmth', 'contact')).toBe(true)
    expect(isReservedSlug('warmth', 'organization')).toBe(false)
    expect(isReservedSlug('type', 'organization')).toBe(false)
    expect(isReservedSlug('type', 'interaction')).toBe(true)
  })

  it('returns the same set on a second call', () => {
    expect(reservedSlugs('contact')).toBe(reservedSlugs('contact'))
  })
})
