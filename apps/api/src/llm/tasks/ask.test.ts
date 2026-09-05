/**
 * §4.8's rule, tested where it lives: everything the model proposes is checked against the
 * workspace's own fields, and nothing that fails reaches the query compiler.
 *
 * These are unit tests with no database and no model, which is the point of `buildFilterSet` being
 * pure — the interesting cases (a slug that does not exist, an operator the field does not offer,
 * an option label where a key was asked for) cannot be produced reliably against a live model and
 * are one line each here.
 */
import { completeDefinition, makeFieldResolver, type AttributeDefinition } from '@mutuals/core'
import { describe, expect, it } from 'vitest'

import type { ProposedFilter } from '../prompts/ask-filter.ts'
import { buildFilterSet, composeAnswer, promptFieldsFor } from './ask.ts'

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

function attribute(
  overrides: Partial<Parameters<typeof completeDefinition>[0]>,
): AttributeDefinition {
  return completeDefinition(
    {
      id: `attr-${String(overrides.slug ?? 'x')}`,
      objectType: 'contact',
      title: 'Untitled',
      slug: 'untitled',
      type: 'short_text',
      config: {},
      isSystem: false,
      position: 10,
      showByDefault: true,
      ...overrides,
    },
    TIMESTAMPS,
  )
}

const CITY = attribute({ slug: 'city', title: 'City', type: 'short_text', position: 1 })
const ROLE = attribute({
  slug: 'job_role',
  title: 'Job role',
  type: 'single_select',
  position: 2,
  options: [
    { id: 'opt-1', key: 'investor', label: 'Investor', position: 0 },
    { id: 'opt-2', key: 'founder', label: 'Founder', position: 1 },
    { id: 'opt-3', key: 'retired', label: 'Retired', position: 2, archivedAt: '2026-02-01' },
  ],
})
const ORG = attribute({
  slug: 'organization',
  title: 'Organization',
  type: 'relation',
  position: 3,
  // `packages/core`'s spelling, which is what `repositories/attributes.ts` normalises the seeded
  // snake_case row into. Reading the stored spelling here returns null for every relation field
  // and fails silently, so the test names it.
  config: { targetObjectType: 'organization', cardinality: 'many', hasLinkMetadata: true },
})
const TAGS = attribute({ slug: 'asks', title: 'Asks', type: 'tags', position: 4 })

const resolver = makeFieldResolver('contact', [CITY, ROLE, ORG, TAGS])

function proposal(overrides: Partial<ProposedFilter> & Pick<ProposedFilter, 'field' | 'op'>) {
  return {
    value: null,
    values: null,
    from: null,
    to: null,
    preset: null,
    n: null,
    unit: null,
    ...overrides,
  }
}

describe('the field list the model is given', () => {
  it('is built from the resolver, so a field created five minutes ago is in it', () => {
    const slugs = promptFieldsFor(resolver).map((field) => field.slug)
    expect(slugs).toContain('city')
    expect(slugs).toContain('job_role')
    expect(slugs).toContain('display_name')
  })

  it('offers option keys with their labels, and hides an archived option', () => {
    const role = promptFieldsFor(resolver).find((field) => field.slug === 'job_role')
    expect(role?.options).toEqual([
      { key: 'investor', label: 'Investor' },
      { key: 'founder', label: 'Founder' },
    ])
  })

  it('says what a relation points at, so a name means something', () => {
    const org = promptFieldsFor(resolver).find((field) => field.slug === 'organization')
    expect(org?.relationTarget).toBe('organization')
    expect(promptFieldsFor(resolver).find((f) => f.slug === 'city')?.relationTarget).toBeNull()
  })
})

describe('buildFilterSet', () => {
  it('builds a one-operand filter', () => {
    const built = buildFilterSet(resolver, [
      proposal({ field: 'city', op: 'equals', value: 'Munich' }),
    ])
    expect(built).toEqual({ ok: true, filter: [{ field: 'city', op: 'equals', value: 'Munich' }] })
  })

  it('builds a set filter, a duration and a nullary operator', () => {
    const built = buildFilterSet(resolver, [
      proposal({ field: 'job_role', op: 'is_one_of', values: ['investor'] }),
      proposal({ field: 'last_interaction_at', op: 'older_than', n: 6, unit: 'month' }),
      proposal({ field: 'city', op: 'is_empty' }),
    ])
    expect(built.ok).toBe(true)
    expect(built.ok && built.filter).toEqual([
      { field: 'job_role', op: 'is_one_of', values: ['investor'] },
      { field: 'last_interaction_at', op: 'older_than', n: 6, unit: 'month' },
      { field: 'city', op: 'is_empty' },
    ])
  })

  /** The one rule: a slug the workspace does not have is refused before any SQL exists. */
  it('refuses a field that does not exist, and says what to do instead', () => {
    const built = buildFilterSet(resolver, [
      proposal({ field: 'favourite_colour', op: 'equals', value: 'blue' }),
    ])
    expect(built.ok).toBe(false)
    expect(built.ok === false && built.problems[0]).toContain('"favourite_colour" is not a field')
  })

  it('refuses an operator the field does not offer, and lists the ones it does', () => {
    const built = buildFilterSet(resolver, [proposal({ field: 'city', op: 'is_yes' })])
    expect(built.ok).toBe(false)
    expect(built.ok === false && built.problems[0]).toContain('does not offer "is_yes"')
    expect(built.ok === false && built.problems[0]).toContain('contains')
  })

  it('refuses an operator that is not an operator at all', () => {
    const built = buildFilterSet(resolver, [
      proposal({ field: 'city', op: 'sounds_like', value: 'Munich' }),
    ])
    expect(built.ok === false && built.problems[0]).toContain('"sounds_like" is not an operator')
  })

  /**
   * The model is shown `investor=Investor` and will sometimes write the half a person would. One
   * lookup is cheaper than a repair round-trip, and the user's question is not wrong.
   */
  it('accepts an option label where a key was asked for, and corrects it', () => {
    const built = buildFilterSet(resolver, [
      proposal({ field: 'job_role', op: 'is_one_of', values: ['Investor'] }),
    ])
    expect(built.ok && built.filter).toEqual([
      { field: 'job_role', op: 'is_one_of', values: ['investor'] },
    ])
  })

  it('refuses an option that is neither a key nor a label, and suggests only live options', () => {
    const built = buildFilterSet(resolver, [
      proposal({ field: 'job_role', op: 'is_one_of', values: ['astronaut'] }),
    ])
    expect(built.ok === false && built.problems[0]).toContain('not an option of "job_role"')
    expect(built.ok === false && built.problems[0]).toContain('keys: investor, founder.')
  })

  /**
   * The other direction: an option archived last month is still a legitimate thing to filter for,
   * exactly as a saved view holding one still renders. Only the *suggestion* hides it.
   */
  it('accepts an archived option key', () => {
    const built = buildFilterSet(resolver, [
      proposal({ field: 'job_role', op: 'is_one_of', values: ['retired'] }),
    ])
    expect(built.ok && built.filter).toEqual([
      { field: 'job_role', op: 'is_one_of', values: ['retired'] },
    ])
  })

  it('turns a relation name into the ids it resolved to', () => {
    const built = buildFilterSet(
      resolver,
      [proposal({ field: 'organization', op: 'has_any_of', values: ['Northstar Ventures'] })],
      new Map([['Northstar Ventures', ['org-1', 'org-2']]]),
    )
    // Two ids for one name: two records genuinely share a label, which §6.9's merge fixes and this
    // function must not silently pick between.
    expect(built.ok && built.filter).toEqual([
      { field: 'organization', op: 'has_any_of', values: ['org-1', 'org-2'] },
    ])
  })

  it('refuses a relation name that matches no record', () => {
    const built = buildFilterSet(resolver, [
      proposal({ field: 'organization', op: 'has_any_of', values: ['Nowhere GmbH'] }),
    ])
    expect(built.ok === false && built.problems[0]).toContain('no record called "Nowhere GmbH"')
  })

  it('refuses a between that is missing an end', () => {
    const built = buildFilterSet(resolver, [
      proposal({ field: 'created_at', op: 'between', from: '2026-01-01' }),
    ])
    expect(built.ok === false && built.problems[0]).toContain('needs both from and to')
  })

  it('refuses an unknown relative preset and an unknown unit', () => {
    expect(
      buildFilterSet(resolver, [
        proposal({ field: 'created_at', op: 'in_relative', preset: 'last_fortnight' }),
      ]),
    ).toMatchObject({ ok: false })
    expect(
      buildFilterSet(resolver, [
        proposal({ field: 'created_at', op: 'older_than', n: 2, unit: 'fortnight' }),
      ]).ok,
    ).toBe(false)
  })

  it('refuses a set operator with no values', () => {
    const built = buildFilterSet(resolver, [
      proposal({ field: 'asks', op: 'contains_any_of', values: [] }),
    ])
    expect(built.ok === false && built.problems[0]).toContain('at least one value')
  })

  it('collects every complaint at once, so one repair round-trip can fix them all', () => {
    const built = buildFilterSet(resolver, [
      proposal({ field: 'nonesuch', op: 'equals', value: 'x' }),
      proposal({ field: 'city', op: 'is_yes' }),
    ])
    expect(built.ok === false && built.problems).toHaveLength(2)
  })

  /** Core's parser has the last word: arity, value length and the filter count are its rules. */
  it('lets `parseFilterSet` refuse what it alone knows about', () => {
    const many = Array.from({ length: 21 }, () =>
      proposal({ field: 'city', op: 'contains', value: 'a' }),
    )
    const built = buildFilterSet(resolver, many)
    expect(built.ok).toBe(false)
    expect(built.ok === false && built.problems.join(' ')).toContain('20 filters')
  })

  it('accepts an empty proposal list as "everything", which is a real answer to "who do I know"', () => {
    expect(buildFilterSet(resolver, [])).toEqual({ ok: true, filter: [] })
  })
})

describe('composeAnswer', () => {
  /**
   * ADR-103: the model is never asked for a number, so the number cannot be wrong. It gives a noun
   * phrase; the count is the real row count.
   */
  it('writes the count itself, around the subject the model gave', () => {
    const query = {
      objectType: 'contact' as const,
      filter: [],
      subject: 'investors in Munich',
      declineReason: null,
    }
    expect(composeAnswer(query, 12)).toBe('Found 12 contacts matching investors in Munich.')
    expect(composeAnswer(query, 1)).toBe('Found 1 contact matching investors in Munich.')
    expect(composeAnswer(query, 0)).toBe('No contacts matching investors in Munich.')
  })

  it('groups thousands, because 2236 contacts is a number a person reads', () => {
    expect(
      composeAnswer(
        { objectType: 'contact', filter: [], subject: 'everyone', declineReason: null },
        2236,
      ),
    ).toBe('Found 2,236 contacts matching everyone.')
  })

  it('says organizations when the question was about organizations', () => {
    expect(
      composeAnswer(
        { objectType: 'organization', filter: [], subject: 'funds in Berlin', declineReason: null },
        3,
      ),
    ).toBe('Found 3 organizations matching funds in Berlin.')
  })

  it('shows the decline reason verbatim, because it is already a sentence for the user', () => {
    expect(
      composeAnswer(
        {
          objectType: 'contact',
          filter: null,
          subject: '',
          declineReason: 'I have no field for shoe size.',
        },
        0,
      ),
    ).toBe('I have no field for shoe size.')
  })

  it('reads correctly when the model gives no subject at all', () => {
    expect(
      composeAnswer({ objectType: 'contact', filter: [], subject: '  ', declineReason: null }, 5),
    ).toBe('Found 5 contacts.')
  })
})
