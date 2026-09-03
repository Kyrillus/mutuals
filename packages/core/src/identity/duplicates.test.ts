import { describe, expect, it } from 'vitest'
import {
  MAX_COMBINED_CONFIDENCE,
  NO_STRONG_IDENTIFIER_CAP,
  bandFor,
  describeBand,
  identifierConfidence,
  isInitialForm,
  matchDuplicates,
  scoreNameFallback,
  type MatchBand,
  type CandidatePool,
  type DuplicateInput,
  type NameCandidate,
} from './duplicates.ts'

const ANNA: DuplicateInput = {
  objectType: 'contact',
  nameKey: 'anna berger',
  identifiers: [{ kind: 'email', value: 'anna@northstar.vc' }],
  emailMatchKeys: ['anna@northstar.vc'],
  organizationIds: ['org-northstar'],
}

/**
 * Passed wherever the fallback must *not* run. If names were ever consulted ahead of identifiers,
 * this record would win, and the test would say so.
 */
const POISON: NameCandidate = {
  recordId: 'poison',
  nameKey: 'anna berger',
  displayName: 'Anna Berger (the other one)',
  nameSimilarity: 1,
  organizationIds: ['org-northstar'],
  emailMatchKeys: [],
}

function pool(overrides: Partial<CandidatePool> = {}): CandidatePool {
  return { identifierHits: [], nameCandidates: [], ...overrides }
}

describe('identifierConfidence', () => {
  it.each([
    ['google_contact_id', 0.99],
    ['linkedin_url', 0.99],
    ['email', 0.97],
    ['telegram', 0.95],
    ['whatsapp', 0.95],
    ['phone', 0.8],
    ['other', 0.8],
  ] as const)('scores a shared %s at %f', (kind, expected) => {
    expect(identifierConfidence(kind, 'contact')).toBe(expected)
  })

  /** Colleagues share a company website; treating that as identity merges whole teams. */
  it('scores a website at nothing on a contact and highly on an organisation', () => {
    expect(identifierConfidence('website', 'contact')).toBe(0)
    expect(identifierConfidence('website', 'organization')).toBe(0.95)
  })
})

describe('bands', () => {
  it('splits at the documented thresholds', () => {
    expect(bandFor(0.99)).toBe('certain')
    expect(bandFor(0.95)).toBe('certain')
    expect(bandFor(0.9499)).toBe('probable')
    expect(bandFor(0.8)).toBe('probable')
    expect(bandFor(0.79)).toBe('possible')
    expect(bandFor(0.6)).toBe('possible')
    expect(bandFor(0.59)).toBeNull()
  })

  it('has one wording per band', () => {
    expect(describeBand('certain')).toBe('Duplicate of')
    expect(describeBand('probable')).toBe('Probable duplicate of')
    expect(describeBand('possible')).toBe('Possible duplicate of')
  })
})

describe('identifiers come first, always', () => {
  it('does not consult name candidates when an identifier matches', () => {
    const verdict = matchDuplicates(
      ANNA,
      pool({
        identifierHits: [{ recordId: 'anna-1', kind: 'email', value: 'anna@northstar.vc' }],
        nameCandidates: [POISON],
      }),
    )
    expect(verdict.usedFallback).toBe(false)
    expect(verdict.best?.recordId).toBe('anna-1')
    expect(verdict.matches).toHaveLength(1)
  })

  it('reads a shared email as certain, and says why', () => {
    const verdict = matchDuplicates(
      ANNA,
      pool({ identifierHits: [{ recordId: 'a', kind: 'email', value: 'anna@northstar.vc' }] }),
    )
    expect(verdict.best).toMatchObject({
      confidence: 0.97,
      band: 'certain',
      rules: ['identifier'],
      evidence: 'Same email: anna@northstar.vc',
    })
  })

  it('combines distinct kinds with noisy-or', () => {
    const verdict = matchDuplicates(
      ANNA,
      pool({
        identifierHits: [
          { recordId: 'a', kind: 'email', value: 'anna@northstar.vc' },
          { recordId: 'a', kind: 'phone', value: '+49891234567' },
        ],
      }),
    )
    expect(verdict.best?.confidence).toBeCloseTo(1 - 0.03 * 0.2, 10)
    expect(verdict.best?.evidence).toBe(
      'Same email: anna@northstar.vc; Same phone number: +49891234567',
    )
  })

  it('takes the maximum within a kind, so two shared emails are still one piece of evidence', () => {
    const verdict = matchDuplicates(
      ANNA,
      pool({
        identifierHits: [
          { recordId: 'a', kind: 'email', value: 'anna@northstar.vc' },
          { recordId: 'a', kind: 'email', value: 'a.berger@northstar.vc' },
        ],
      }),
    )
    expect(verdict.best?.confidence).toBe(0.97)
  })

  it('never reaches certainty from a pile of weak evidence', () => {
    const verdict = matchDuplicates(
      ANNA,
      pool({
        identifierHits: [
          { recordId: 'a', kind: 'email', value: 'anna@northstar.vc' },
          { recordId: 'a', kind: 'phone', value: '+49891234567' },
          { recordId: 'a', kind: 'linkedin_url', value: 'in/anna-berger' },
          { recordId: 'a', kind: 'telegram', value: '@anna' },
        ],
      }),
    )
    expect(verdict.best?.confidence).toBeLessThanOrEqual(MAX_COMBINED_CONFIDENCE)
  })

  /**
   * Two colleagues on one switchboard. `max within a kind` alone keeps this at 0.80 — the second
   * shared landline is not a second piece of evidence.
   */
  it('does not stack two shared landlines', () => {
    const verdict = matchDuplicates(
      { ...ANNA, identifiers: [] },
      pool({
        identifierHits: [
          { recordId: 'colleague', kind: 'phone', value: '+498912345670' },
          { recordId: 'colleague', kind: 'phone', value: '+498912345671' },
        ],
      }),
    )
    expect(verdict.best?.confidence).toBe(0.8)
    expect(verdict.best?.band).toBe('probable')
  })

  /**
   * The certainty gate ADR-042 added, for the case `max within a kind` does not cover: two
   * *different* weak kinds noisy-or to 0.96, and `certain` is the band the import wizard offers a
   * bulk Merge for. Noisy-or assumes independent evidence, and a shared switchboard plus the
   * office's shared handle are the least independent evidence in the dataset.
   */
  it('caps a pile of weak evidence just below certainty', () => {
    const verdict = matchDuplicates(
      { ...ANNA, identifiers: [] },
      pool({
        identifierHits: [
          { recordId: 'colleague', kind: 'phone', value: '+498912345670' },
          { recordId: 'colleague', kind: 'other', value: 'pbx-12' },
        ],
      }),
    )
    expect(verdict.best?.confidence).toBe(NO_STRONG_IDENTIFIER_CAP)
    expect(verdict.best?.band).toBe('probable')
  })

  it('ignores a shared website on a contact and falls back to names', () => {
    const verdict = matchDuplicates(
      { ...ANNA, identifiers: [] },
      pool({
        identifierHits: [{ recordId: 'colleague', kind: 'website', value: 'northstar.vc' }],
        nameCandidates: [],
      }),
    )
    expect(verdict.matches).toEqual([])
    expect(verdict.usedFallback).toBe(true)
  })

  it('does use a shared website on an organisation', () => {
    const verdict = matchDuplicates(
      { ...ANNA, objectType: 'organization', nameKey: 'northstar ventures' },
      pool({ identifierHits: [{ recordId: 'org-2', kind: 'website', value: 'northstar.vc' }] }),
    )
    expect(verdict.best).toMatchObject({ confidence: 0.95, band: 'certain' })
  })

  it('sorts matches by confidence and caps the list at five', () => {
    const hits = Array.from({ length: 7 }, (_, i) => ({
      recordId: `r${i}`,
      kind: i === 0 ? ('email' as const) : ('phone' as const),
      value: `v${i}`,
    }))
    const verdict = matchDuplicates({ ...ANNA, identifiers: [] }, pool({ identifierHits: hits }))
    expect(verdict.matches).toHaveLength(5)
    expect(verdict.matches[0]?.recordId).toBe('r0')
    expect(verdict.matches.map((m) => m.confidence)).toEqual(
      [...verdict.matches].sort((a, b) => b.confidence - a.confidence).map((m) => m.confidence),
    )
  })
})

describe('the name fallback', () => {
  const base: NameCandidate = {
    recordId: 'existing',
    nameKey: 'anna berger',
    displayName: 'Anna Berger',
    nameSimilarity: 1,
    organizationIds: [],
    emailMatchKeys: [],
  }

  it('scores an exact name at a shared organisation highest', () => {
    const verdict = matchDuplicates(
      { ...ANNA, identifiers: [] },
      pool({ nameCandidates: [{ ...base, organizationIds: ['org-northstar'] }] }),
    )
    expect(verdict.usedFallback).toBe(true)
    expect(verdict.best).toMatchObject({
      confidence: 0.88,
      band: 'probable',
      rules: ['name_exact_org_same'],
      evidence: 'Same name as Anna Berger, same organisation',
    })
  })

  it('recognises a plus-tag or gmail-dot variant of the same address', () => {
    const verdict = matchDuplicates(
      {
        ...ANNA,
        identifiers: [],
        nameKey: 'anna b',
        emailMatchKeys: ['annaberger@gmail.com'],
        organizationIds: [],
      },
      pool({
        nameCandidates: [{ ...base, emailMatchKeys: ['annaberger@gmail.com'] }],
      }),
    )
    expect(verdict.best).toMatchObject({ confidence: 0.85, rules: ['email_local_match'] })
    expect(verdict.best?.evidence).toContain('annaberger@gmail.com')
  })

  it('scores a near-miss name at a shared organisation', () => {
    const verdict = matchDuplicates(
      { ...ANNA, identifiers: [], nameKey: 'ana berger' },
      pool({
        nameCandidates: [{ ...base, nameSimilarity: 0.8, organizationIds: ['org-northstar'] }],
      }),
    )
    expect(verdict.best).toMatchObject({ confidence: 0.74, rules: ['name_fuzzy_org_same'] })
  })

  it('does not fire the fuzzy rule below the threshold', () => {
    const verdict = matchDuplicates(
      { ...ANNA, identifiers: [], nameKey: 'andreas berger' },
      pool({
        nameCandidates: [{ ...base, nameSimilarity: 0.74, organizationIds: ['org-northstar'] }],
      }),
    )
    expect(verdict.best).toBeNull()
  })

  it('recognises an abbreviated first name at the same organisation', () => {
    const verdict = matchDuplicates(
      { ...ANNA, identifiers: [], nameKey: 'a. berger' },
      pool({
        nameCandidates: [{ ...base, nameSimilarity: 0.5, organizationIds: ['org-northstar'] }],
      }),
    )
    expect(verdict.best).toMatchObject({ confidence: 0.7, rules: ['name_initial_org_same'] })
  })

  it('accepts the same name in the same city when neither has an organisation', () => {
    const verdict = matchDuplicates(
      { ...ANNA, identifiers: [], organizationIds: [], cityKey: 'munchen' },
      pool({ nameCandidates: [{ ...base, cityKey: 'munchen' }] }),
    )
    expect(verdict.best).toMatchObject({ confidence: 0.66, rules: ['name_exact_city_same'] })
    expect(verdict.best?.evidence).toContain('munchen')
  })

  it('accepts the same name when neither side knows an organisation', () => {
    const verdict = matchDuplicates(
      { ...ANNA, identifiers: [], organizationIds: [] },
      pool({ nameCandidates: [base] }),
    )
    expect(verdict.best).toMatchObject({ confidence: 0.62, rules: ['name_exact_org_unknown'] })
  })

  it('does not surface two different people who share a name', () => {
    const verdict = matchDuplicates(
      { ...ANNA, identifiers: [] },
      pool({ nameCandidates: [{ ...base, organizationIds: ['org-other'] }] }),
    )
    expect(verdict.best).toBeNull()
    expect(verdict.matches).toEqual([])
  })

  it('never reaches certainty on a name alone', () => {
    const verdict = matchDuplicates(
      { ...ANNA, identifiers: [] },
      pool({ nameCandidates: [{ ...base, organizationIds: ['org-northstar'] }] }),
    )
    expect(verdict.best?.band).not.toBe('certain')
  })

  it('ignores an empty name key rather than matching every unnamed record', () => {
    const verdict = matchDuplicates(
      { ...ANNA, identifiers: [], nameKey: '', organizationIds: [] },
      pool({ nameCandidates: [{ ...base, nameKey: '', nameSimilarity: 0 }] }),
    )
    expect(verdict.best).toBeNull()
  })

  it('returns nothing when there is nothing to compare', () => {
    const verdict = matchDuplicates({ ...ANNA, identifiers: [] }, pool())
    expect(verdict).toEqual({ best: null, matches: [], usedFallback: true })
  })
})

describe('isInitialForm', () => {
  it('accepts an abbreviated first name, with or without the dot', () => {
    expect(isInitialForm('a berger', 'anna berger')).toBe(true)
    expect(isInitialForm('a. berger', 'anna berger')).toBe(true)
    expect(isInitialForm('anna berger', 'a berger')).toBe(true)
  })

  it('rejects a different initial or a different surname', () => {
    expect(isInitialForm('b berger', 'anna berger')).toBe(false)
    expect(isInitialForm('a berger', 'anna schmidt')).toBe(false)
  })

  it('rejects identical and single-token names', () => {
    expect(isInitialForm('anna berger', 'anna berger')).toBe(false)
    expect(isInitialForm('berger', 'anna berger')).toBe(false)
    expect(isInitialForm('', '')).toBe(false)
  })
})

describe('re-importing the same export', () => {
  /**
   * §6.8's idempotency requirement, expressed as a pure test: every row of an export matched
   * against records created from that same export comes back `certain`, so `Skip` and `Merge`
   * create no duplicates.
   */
  it('recognises every row of an export it has already imported', () => {
    const rows = [
      { id: 'c1', email: 'anna@northstar.vc' },
      { id: 'c2', email: 'ben@example.com' },
      { id: 'c3', email: 'cara@example.org' },
    ]
    for (const row of rows) {
      const verdict = matchDuplicates(
        {
          objectType: 'contact',
          nameKey: 'ignored',
          identifiers: [{ kind: 'email', value: row.email }],
          emailMatchKeys: [row.email],
          organizationIds: [],
        },
        pool({ identifierHits: [{ recordId: row.id, kind: 'email', value: row.email }] }),
      )
      expect(verdict.best?.band).toBe('certain')
      expect(verdict.best?.recordId).toBe(row.id)
    }
  })
})

describe('scoreNameFallback', () => {
  const candidate: NameCandidate = {
    recordId: 'existing',
    nameKey: 'anna berger',
    displayName: 'Anna Berger',
    nameSimilarity: 1,
    organizationIds: ['org-other'],
    emailMatchKeys: [],
  }

  /** Scored so it is visible here, and below the surfacing floor so it never reaches the user. */
  it('scores two different people who share a name at 0.30', () => {
    expect(scoreNameFallback({ ...ANNA, identifiers: [] }, candidate)).toEqual({
      rule: 'name_exact_org_diff',
      confidence: 0.3,
      evidence: 'Same name as Anna Berger, different organisation',
    })
    expect(bandFor(0.3)).toBeNull()
  })

  it('returns nothing when no rule applies', () => {
    expect(
      scoreNameFallback({ ...ANNA, identifiers: [] }, { ...candidate, nameKey: 'ben schmidt' }),
    ).toBeNull()
  })
})

describe('the exhaustiveness guard', () => {
  it('throws on a band that does not exist', () => {
    expect(() => describeBand('lukewarm' as MatchBand)).toThrow(/match band/)
  })
})
