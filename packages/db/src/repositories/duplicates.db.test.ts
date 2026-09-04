/**
 * The candidate pool, against a real database.
 *
 * `matchDuplicates` has been unit-tested in `packages/core` since Stage 1 with hand-built pools.
 * What was never tested is whether a pool can actually be *found* — which is two index probes and a
 * trigram scan, and is the half that can be wrong in ways a hand-built fixture cannot show: an
 * identifier written by the projector rather than by this code, a trigram threshold that differs
 * from the session default, a former employer counted as evidence.
 *
 * The scoring assertions here go through `matchDuplicates` on purpose, so the two halves are tested
 * as the one thing the wizard actually calls.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  NAME_CANDIDATE_THRESHOLD,
  matchDuplicates,
  normalizeEmail,
  normalizeLinkedIn,
  unwrap,
  type IdentifierRef,
  type Uuid,
} from '@mutuals/core'

import { attributeIdBySlug, testDb } from '../test-support/index.ts'
import { probeDuplicates, type CandidateProbe } from './duplicates.ts'
import { createContact, createOrganization } from '../write/records.ts'
import { writeIdentifiers } from '../write/identifiers.ts'
import type { ValueChange } from '../write/facts.ts'

let northstar: Uuid
let brightAngle: Uuid

/** Builds the identifier refs a probe carries, through core's own normalisers. */
function refs(input: { email?: string; linkedin?: string }): IdentifierRef[] {
  const out: IdentifierRef[] = []
  if (input.email !== undefined) {
    out.push({ kind: 'email', value: unwrap(normalizeEmail(input.email)).identifier })
  }
  if (input.linkedin !== undefined) {
    out.push({ kind: 'linkedin_url', value: unwrap(normalizeLinkedIn(input.linkedin)).identifier })
  }
  return out
}

function probe(overrides: Partial<CandidateProbe> & { displayName: string }): CandidateProbe {
  return {
    objectType: 'contact',
    identifiers: [],
    emailMatchKeys: [],
    organizationIds: [],
    ...overrides,
  }
}

/** A contact with the values the identifier write-through mirrors, then mirrored. */
async function contact(input: {
  firstName?: string
  lastName: string
  email?: string
  linkedin?: string
  organizationId?: Uuid
}): Promise<Uuid> {
  const values: ValueChange[] = []
  if (input.email !== undefined) {
    values.push({
      attributeId: await attributeIdBySlug('contact', 'email'),
      values: [{ kind: 'text' as const, text: input.email }],
    })
  }
  if (input.linkedin !== undefined) {
    values.push({
      attributeId: await attributeIdBySlug('contact', 'linkedin_url'),
      values: [{ kind: 'text' as const, text: input.linkedin }],
    })
  }
  if (input.organizationId !== undefined) {
    values.push({
      attributeId: await attributeIdBySlug('contact', 'organization'),
      values: [{ kind: 'relation' as const, targetRecordId: input.organizationId }],
    })
  }

  const id = await createContact(testDb(), {
    ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
    lastName: input.lastName,
    values,
  })
  await writeIdentifiers(testDb(), id)
  return id
}

beforeEach(async () => {
  northstar = await createOrganization(testDb(), { name: 'Northstar Ventures' })
  brightAngle = await createOrganization(testDb(), { name: 'Bright Angle' })
})

describe('probeDuplicates', () => {
  it('returns one pool per probe, in order, and none for no probes', async () => {
    await contact({ firstName: 'Anna', lastName: 'Berger' })
    const results = await probeDuplicates(testDb(), [
      probe({ displayName: 'Anna Berger' }),
      probe({ displayName: 'Nobody At All' }),
    ])
    expect(results).toHaveLength(2)
    expect(results[0]?.pool.nameCandidates).not.toHaveLength(0)
    expect(results[1]?.pool.nameCandidates).toHaveLength(0)
    expect(await probeDuplicates(testDb(), [])).toEqual([])
  })

  it('computes the name key in SQL, so it matches what the label column holds', async () => {
    const [result] = await probeDuplicates(testDb(), [probe({ displayName: 'Björn Håkansson' })])
    // `mutuals_norm` folds the diacritics; the exact spelling is SQL's business, not this test's.
    expect(result?.nameKey).toBe('bjorn hakansson')
  })

  it('finds a record by a shared email, however it was capitalised', async () => {
    const anna = await contact({
      firstName: 'Anna',
      lastName: 'Berger',
      email: 'anna.berger@northstar-ventures.com',
    })

    const [result] = await probeDuplicates(testDb(), [
      probe({
        displayName: 'A. Berger',
        identifiers: refs({ email: 'ANNA.BERGER@NORTHSTAR-VENTURES.COM' }),
      }),
    ])
    expect(result?.pool.identifierHits.map((hit) => hit.recordId)).toEqual([anna])
  })

  /**
   * The fixture's Håkansson pair. Two rows sharing a LinkedIn URL are the same person with
   * near-certainty per §4.6 — and the acceptance test's own comment gets this wrong, calling it a
   * fuzzy match because the email addresses differ.
   */
  it('finds a record by a shared LinkedIn profile and scores it certain', async () => {
    const bjorn = await contact({
      firstName: 'Björn',
      lastName: 'Håkansson',
      linkedin: 'https://www.linkedin.com/in/bjorn-hakansson',
      organizationId: brightAngle,
    })

    const incoming = probe({
      displayName: 'Bjoern Hakansson',
      identifiers: refs({
        linkedin: 'https://www.linkedin.com/in/bjorn-hakansson',
        email: 'bjorn@brightangle.se',
      }),
    })
    const [result] = await probeDuplicates(testDb(), [incoming])
    const verdict = matchDuplicates(
      { ...incoming, nameKey: result?.nameKey ?? '' },
      result?.pool ?? { identifierHits: [], nameCandidates: [] },
    )

    expect(verdict.best?.recordId).toBe(bjorn)
    expect(verdict.best?.band).toBe('certain')
    expect(verdict.best?.rules).toContain('identifier')
  })

  /**
   * §4.6: "name + organization similarity is the fallback, never the first check." Not an
   * optimisation — the pool has no name candidates at all when an identifier landed, so a
   * lower-confidence name rule cannot outrank a shared identifier by accident.
   */
  it('does not consult names at all when an identifier matched', async () => {
    await contact({
      firstName: 'Anna',
      lastName: 'Berger',
      email: 'anna.berger@northstar-ventures.com',
    })
    const [result] = await probeDuplicates(testDb(), [
      probe({
        displayName: 'Anna Berger',
        identifiers: refs({ email: 'anna.berger@northstar-ventures.com' }),
      }),
    ])
    expect(result?.pool.identifierHits).toHaveLength(1)
    expect(result?.pool.nameCandidates).toHaveLength(0)
  })

  it('falls back to a name candidate when nothing identifies the row', async () => {
    const lukas = await contact({
      firstName: 'Lukas',
      lastName: 'Müller',
      organizationId: brightAngle,
    })

    const incoming = probe({ displayName: 'Lukas Mueller', organizationIds: [brightAngle] })
    const [result] = await probeDuplicates(testDb(), [incoming])
    const candidate = result?.pool.nameCandidates.find((one) => one.recordId === lukas)

    expect(candidate).toBeDefined()
    expect(candidate?.displayName).toBe('Lukas Müller')
    expect(candidate?.organizationIds).toEqual([brightAngle])

    const verdict = matchDuplicates(
      { ...incoming, nameKey: result?.nameKey ?? '' },
      result?.pool ?? { identifierHits: [], nameCandidates: [] },
    )
    expect(verdict.best?.recordId).toBe(lukas)
    expect(verdict.usedFallback).toBe(true)
  })

  /**
   * The generation threshold, which is well above pg_trgm's session default of 0.3 and well below
   * every scoring rule's. If the query relied on the operator alone, two siblings would be
   * candidates for each other.
   */
  it('applies the candidate threshold rather than pg_trgms session default', async () => {
    await contact({ firstName: 'Anna', lastName: 'Berger' })
    const [result] = await probeDuplicates(testDb(), [probe({ displayName: 'Jonas Berger' })])
    for (const candidate of result?.pool.nameCandidates ?? []) {
      expect(candidate.nameSimilarity).toBeGreaterThanOrEqual(NAME_CANDIDATE_THRESHOLD)
    }
    // Two siblings score 0.3889, so the pool is empty rather than merely unconvinced.
    expect(result?.pool.nameCandidates).toHaveLength(0)
  })

  /**
   * The bug that splitting the thresholds fixed. `isInitialForm` exists for exactly this pair and
   * is unit-tested in core, but "J. Weber" scores 0.5385 against "Jonas Weber" — so while
   * generation used the scoring threshold the candidate never arrived and the rule was dead code.
   * Core's own tests could not catch it: they hand `matchDuplicates` a pool directly.
   */
  it('generates a candidate for an abbreviated first name, so the initial rule can fire', async () => {
    const jonas = await contact({
      firstName: 'Jonas',
      lastName: 'Weber',
      organizationId: northstar,
    })

    const incoming = probe({ displayName: 'J. Weber', organizationIds: [northstar] })
    const [result] = await probeDuplicates(testDb(), [incoming])
    expect(result?.pool.nameCandidates.map((one) => one.recordId)).toContain(jonas)

    const verdict = matchDuplicates(
      { ...incoming, nameKey: result?.nameKey ?? '' },
      result?.pool ?? { identifierHits: [], nameCandidates: [] },
    )
    expect(verdict.best?.recordId).toBe(jonas)
    expect(verdict.best?.rules).toEqual(['name_initial_org_same'])
  })

  /**
   * The two pairs 0.75 sat above. Both are deliberate collisions in the LinkedIn fixture, and
   * neither was findable before the threshold was measured.
   */
  it('finds a diacritic fold and a transliteration typo at the same organisation', async () => {
    const lukas = await contact({
      firstName: 'Lukas',
      lastName: 'Müller',
      organizationId: northstar,
    })
    const ekaterina = await contact({
      firstName: 'Ekaterina',
      lastName: 'Volkova',
      organizationId: brightAngle,
    })

    for (const [name, organizationId, expected] of [
      ['Lukas Mueller', northstar, lukas],
      ['Ekatarina Volkova', brightAngle, ekaterina],
    ] as const) {
      const incoming = probe({ displayName: name, organizationIds: [organizationId] })
      const [result] = await probeDuplicates(testDb(), [incoming])
      const verdict = matchDuplicates(
        { ...incoming, nameKey: result?.nameKey ?? '' },
        result?.pool ?? { identifierHits: [], nameCandidates: [] },
      )
      expect(verdict.best?.recordId, name).toBe(expected)
      expect(verdict.best?.band, name).toBe('possible')
      expect(verdict.best?.rules, name).toEqual(['name_fuzzy_org_same'])
    }
  })

  it('carries a candidates folded email keys, which are never stored folded', async () => {
    const marta = await contact({
      firstName: 'Marta',
      lastName: 'Nowak',
      email: 'marta.nowak@gmail.com',
    })
    const [result] = await probeDuplicates(testDb(), [probe({ displayName: 'Marta Nowak' })])
    const candidate = result?.pool.nameCandidates.find((one) => one.recordId === marta)
    // The dots are folded for matching only; the address itself keeps them.
    expect(candidate?.emailMatchKeys).toEqual(['martanowak@gmail.com'])
  })

  it('never offers a record of the wrong object type', async () => {
    // `Northstar Ventures` is an organization, and a contact of the same name must not match it.
    await createContact(testDb(), { firstName: 'Northstar', lastName: 'Ventures' })
    const [asOrganization] = await probeDuplicates(testDb(), [
      probe({ objectType: 'organization', displayName: 'Northstar Ventures' }),
    ])
    expect(asOrganization?.pool.nameCandidates.map((one) => one.recordId)).toEqual([northstar])
  })

  it('leaves out the records it is told to exclude', async () => {
    const anna = await contact({
      firstName: 'Anna',
      lastName: 'Berger',
      email: 'anna.berger@northstar-ventures.com',
    })
    const [result] = await probeDuplicates(
      testDb(),
      [
        probe({
          displayName: 'Anna Berger',
          identifiers: refs({ email: 'anna.berger@northstar-ventures.com' }),
        }),
      ],
      { excludeRecordIds: [anna] },
    )
    expect(result?.pool.identifierHits).toHaveLength(0)
    expect(result?.pool.nameCandidates.map((one) => one.recordId)).not.toContain(anna)
  })

  it('says nothing for a row with no name and no identifiers', async () => {
    await contact({ firstName: 'Anna', lastName: 'Berger' })
    const [result] = await probeDuplicates(testDb(), [probe({ displayName: '   ' })])
    expect(result?.nameKey).toBe('')
    expect(result?.pool.nameCandidates).toHaveLength(0)
    expect(result?.pool.identifierHits).toHaveLength(0)
  })

  /** ADR-042's reason for existing: one statement per batch, not one per identifier per row. */
  it('probes many rows in a fixed number of round trips', async () => {
    await contact({ firstName: 'Anna', lastName: 'Berger', email: 'anna@northstar.example' })
    await contact({ firstName: 'Jonas', lastName: 'Weber', organizationId: northstar })

    const probes = Array.from({ length: 40 }, (_unused, index) =>
      probe({
        displayName: index % 2 === 0 ? 'Anna Berger' : 'Jonas Weber',
        identifiers: index % 2 === 0 ? refs({ email: 'anna@northstar.example' }) : [],
      }),
    )
    const results = await probeDuplicates(testDb(), probes)
    expect(results).toHaveLength(40)
    expect(results[0]?.pool.identifierHits).toHaveLength(1)
    expect(results[1]?.pool.nameCandidates).not.toHaveLength(0)
  })
})
