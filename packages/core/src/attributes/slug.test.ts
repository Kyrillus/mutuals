import { describe, expect, it } from 'vitest'

import { SYSTEM_FIELDS } from '../fields/system.ts'
import { OBJECT_TYPES } from './kinds.ts'
import { HAZARD_SLUGS } from './reserved.ts'
import {
  MAX_SLUG_LENGTH,
  SLUG_PATTERN,
  isSlug,
  suggestSlug,
  transliterateForSlug,
  validateSlug,
} from './slug.ts'

const CONTACT = { objectType: 'contact', taken: new Set<string>() } as const

function withTaken(...slugs: string[]) {
  return { objectType: 'contact', taken: new Set(slugs) } as const
}

/** A seeded generator, so a failure is reproducible instead of a rumour. */
function makeRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296
    return state / 4_294_967_296
  }
}

describe('suggestSlug', () => {
  it('turns a title into the name a person would have typed', () => {
    expect(suggestSlug('Check size', CONTACT)).toBe('check_size')
    expect(suggestSlug('E-Mail Adresse', CONTACT)).toBe('e_mail_adresse')
    expect(suggestSlug('  Areas of interest  ', CONTACT)).toBe('areas_of_interest')
  })

  it('transliterates rather than dropping characters', () => {
    expect(suggestSlug('Größe', CONTACT)).toBe('groesse')
    expect(suggestSlug('Café ☕', CONTACT)).toBe('cafe')
    expect(suggestSlug('Łódź', CONTACT)).toBe('lodz')
    expect(suggestSlug('Ærø', CONTACT)).toBe('aero')
  })

  it('guarantees a leading letter', () => {
    expect(suggestSlug('2nd degree', CONTACT)).toBe('f_2nd_degree')
    expect(suggestSlug('_leading', CONTACT)).toBe('leading')
  })

  it('never returns an empty slug', () => {
    expect(suggestSlug('☕☕', CONTACT)).toBe('f_1')
    expect(suggestSlug('', CONTACT)).toBe('f_1')
  })

  it('walks past names that are taken', () => {
    expect(suggestSlug('City', withTaken('city', 'city_2'))).toBe('city_3')
  })

  it('walks past names that are reserved', () => {
    // `warmth` is a derived column, so it is reserved for contacts by construction.
    expect(suggestSlug('Warmth', CONTACT)).toBe('warmth_2')
  })

  it('is deterministic', () => {
    const context = withTaken('city')
    const first = suggestSlug('City', context)
    for (let i = 0; i < 1000; i += 1) expect(suggestSlug('City', context)).toBe(first)
  })

  it('stays inside the database limit, even when deduplicating at the cap', () => {
    const long = suggestSlug('Very long attribute title '.repeat(20), CONTACT)
    expect(long.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH)
    expect(SLUG_PATTERN.test(long)).toBe(true)

    const atCap = 'a'.repeat(MAX_SLUG_LENGTH)
    const deduped = suggestSlug(atCap, withTaken(atCap))
    expect(deduped.length).toBe(MAX_SLUG_LENGTH)
    expect(deduped.endsWith('_2')).toBe(true)
    expect(SLUG_PATTERN.test(deduped)).toBe(true)
  })

  it('cuts at an underscore when that still leaves a readable name', () => {
    const title = `${'word '.repeat(12)}tail`
    const slug = suggestSlug(title, CONTACT)
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH)
    expect(slug.endsWith('_')).toBe(false)
  })

  it('produces something the database CHECK accepts, for any title', () => {
    const random = makeRandom(20_260_903)
    const alphabet = [...'abcXYZ019 -_.äöüßéłÆ☕👩‍🚀/\\<>|,;:@#$%^&*()[]{}']
    for (let i = 0; i < 10_000; i += 1) {
      const length = Math.floor(random() * 40)
      let title = ''
      for (let c = 0; c < length; c += 1) {
        title += alphabet[Math.floor(random() * alphabet.length)] ?? ''
      }
      const slug = suggestSlug(title, CONTACT)
      expect(SLUG_PATTERN.test(slug), `${JSON.stringify(title)} -> ${slug}`).toBe(true)
    }
  })
})

describe('validateSlug', () => {
  it('accepts a well-formed, free, unreserved slug', () => {
    const result = validateSlug('check_size', CONTACT)
    expect(result.ok).toBe(true)
    expect(isSlug('check_size')).toBe(true)
  })

  it('rejects a shape the database CHECK would reject', () => {
    for (const raw of ['Cities', 'city name', 'city-name', '2city', '', '   ', 'a'.repeat(64)]) {
      const result = validateSlug(raw, CONTACT)
      expect(result.ok, raw).toBe(false)
    }
    expect(isSlug('Cities')).toBe(false)
  })

  it('rejects a system field name, and says which rule was hit', () => {
    for (const slug of ['display_name', 'warmth', 'open_followups', 'created_at']) {
      const result = validateSlug(slug, CONTACT)
      expect(result.ok, slug).toBe(false)
      expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(['reserved_slug'])
      expect(result.ok ? '' : result.issues[0]?.message).toMatch(/built-in field/)
    }
  })

  it('rejects the JavaScript hazards', () => {
    for (const slug of HAZARD_SLUGS) {
      expect(validateSlug(slug, CONTACT).ok, slug).toBe(false)
    }
    // `__proto__` cannot pass the shape check at all, so it is refused one step earlier and
    // reported as a shape problem. The two that *are* well-formed slugs hit the reserved list.
    for (const slug of ['constructor', 'prototype']) {
      const result = validateSlug(slug, CONTACT)
      expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(['reserved_slug'])
      expect(result.ok ? '' : result.issues[0]?.message).toMatch(/JavaScript/)
    }
  })

  it('rejects a name another attribute already uses', () => {
    const result = validateSlug('city', withTaken('city'))
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(['duplicate_slug'])
  })

  it('reserves every system slug of every object type, by construction', () => {
    for (const objectType of OBJECT_TYPES) {
      for (const field of SYSTEM_FIELDS[objectType]) {
        const result = validateSlug(field.slug, { objectType, taken: new Set() })
        expect(result.ok, `${objectType}.${field.slug}`).toBe(false)
      }
    }
  })

  it('does not reserve a name only another object type uses', () => {
    // §4.1 seeds `type` as a default custom attribute on Organization; ADR-041 removed it from the
    // hazard list for exactly this reason, and the seed would fail on first run otherwise.
    expect(validateSlug('type', { objectType: 'organization', taken: new Set() }).ok).toBe(true)
    expect(validateSlug('type', { objectType: 'interaction', taken: new Set() }).ok).toBe(false)
    expect(validateSlug('description', { objectType: 'organization', taken: new Set() }).ok).toBe(
      true,
    )
  })

  it('accepts every attribute slug the brief seeds', () => {
    const contactSeeds = [
      'email',
      'phone',
      'job_role',
      'organization',
      'city',
      'country',
      'birthday',
      'areas_of_interest',
      'asks',
      'offers',
      'linkedin_url',
      'website',
      'how_we_met',
      'notes',
    ]
    for (const slug of contactSeeds) {
      expect(validateSlug(slug, CONTACT).ok, slug).toBe(true)
    }
    const organizationSeeds = [
      'type',
      'industry',
      'city',
      'country',
      'website',
      'linkedin_url',
      'description',
      'stage',
    ]
    for (const slug of organizationSeeds) {
      expect(validateSlug(slug, { objectType: 'organization', taken: new Set() }).ok, slug).toBe(
        true,
      )
    }
  })
})

describe('transliterateForSlug', () => {
  it('is the slug transliteration and nothing else', () => {
    expect(transliterateForSlug('Größe')).toBe('groesse')
    expect(transliterateForSlug('MÜNCHEN')).toBe('muenchen')
    expect(transliterateForSlug('naïve')).toBe('naive')
    expect(transliterateForSlug('Мюнхен')).toBe('мюнхен')
  })
})
