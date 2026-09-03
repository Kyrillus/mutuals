/**
 * The list query against a real Postgres (ADR-077 (b)).
 *
 * `compile.test.ts` proves the SQL is the string it is meant to be; this file proves the string
 * returns the right people. They are different failures: an `EXISTS` correlated on the wrong
 * column compiles to perfectly well-formed SQL that quietly returns everybody.
 *
 * The fixture is written through the **real write path** — `createContact`, `applyValues` — so
 * every row here has been through the fact log and the SQL projector (ADR-076). Raw inserts would
 * let these tests pass while the projector is broken, which is the one thing they most need to
 * catch. `resetDatabase` in `setup.ts` truncates before each test, so the fixture is built fresh
 * and owns everything in the database while its test runs.
 *
 * Three contacts, chosen so every operator has a row it must match and a row it must not:
 *
 * | | name        | home town | role     | check size | mentor | sectors         | metrics |
 * |-|-------------|-----------|----------|------------|--------|-----------------|---------|
 * |A| Anna Berger | München   | investor | 600000.50  | yes    | climate, health | warm    |
 * |B| Bob Klein   | Munich    | founder  | 100        | no     | climate         | cool    |
 * |C| Carla Ohne  | —         | —        | —          | —      | —               | none    |
 *
 * `München` and `Munich` are the pair that make ADR-019 visible: they fold to `munchen` and
 * `munich`, so `contains MÜNCH` must find exactly one of them — and, byte-ordered, the accented
 * one sorts first.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import {
  civil,
  decimal,
  makeFieldResolver,
  type AttributeDefinition,
  type FieldResolver,
  type Filter,
  type ListQuery,
  type SortRequest,
  type Uuid,
} from '@mutuals/core'

import { compileList, type ListPage, type ListPlan } from './list.ts'
import { createAttributeDefinition, listAttributeDefinitions } from '../repositories/attributes.ts'
import { applyValues } from '../write/facts.ts'
import { createContact, createOrganization } from '../write/records.ts'
import { TEST_WORKSPACE_ID, testDb } from '../test-support/index.ts'

// ---------------------------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------------------------

/** Slugs this file owns. None collides with a system field or with migration 0002's own seed. */
type FixtureSlug =
  | 'home_town'
  | 'date_of_birth'
  | 'bio'
  | 'interests'
  | 'employer'
  | 'role'
  | 'check_size'
  | 'is_mentor'
  | 'sectors'

interface Fixture {
  readonly resolver: FieldResolver
  /** Record id → the letter the table above calls it, so a failure message reads as A,B,C. */
  readonly names: Readonly<Record<string, string>>
  readonly a: Uuid
  readonly b: Uuid
  readonly c: Uuid
  readonly acme: Uuid
  readonly attributes: readonly AttributeDefinition[]
}

let fixture: Fixture

function optionId(definition: AttributeDefinition, key: string): Uuid {
  const found = (definition.options ?? []).find((one) => one.key === key)
  if (found === undefined) throw new Error(`"${definition.slug}" has no option "${key}"`)
  return found.id
}

function attribute(slug: FixtureSlug): AttributeDefinition {
  const found = fixture.attributes.find((one) => one.slug === slug)
  if (found === undefined) throw new Error(`the fixture lost "${slug}"`)
  return found
}

async function seedFixture(): Promise<Fixture> {
  const define = (
    slug: FixtureSlug,
    title: string,
    type: string,
    extra: Record<string, unknown> = {},
  ) =>
    createAttributeDefinition(testDb(), {
      objectType: 'contact',
      title,
      slug,
      type: type as never,
      ...extra,
    })

  const homeTown = await define('home_town', 'Home town', 'short_text')
  const dateOfBirth = await define('date_of_birth', 'Date of birth', 'date')
  const bio = await define('bio', 'Bio', 'long_text')
  const interests = await define('interests', 'Interests', 'tags')
  const employer = await define('employer', 'Employer', 'relation', {
    config: { targetObjectType: 'organization', cardinality: 'many', hasLinkMetadata: true },
  })
  const role = await define('role', 'Role', 'single_select', {
    options: [
      { key: 'founder', label: 'Founder' },
      { key: 'investor', label: 'Investor' },
    ],
  })
  const checkSize = await define('check_size', 'Check size', 'number')
  const isMentor = await define('is_mentor', 'Mentor', 'yes_no')
  const sectors = await define('sectors', 'Sectors', 'multi_select', {
    options: [
      { key: 'climate', label: 'Climate' },
      { key: 'health', label: 'Health' },
    ],
  })

  const acme = await createOrganization(testDb(), { name: 'Acme' })

  const a = await createContact(testDb(), {
    firstName: 'Anna',
    lastName: 'Berger',
    values: [
      { attributeId: homeTown.id, values: [{ kind: 'text', text: 'München' }] },
      { attributeId: dateOfBirth.id, values: [{ kind: 'date', date: civil('1988-03-12') }] },
      { attributeId: bio.id, values: [{ kind: 'text', text: 'Raising a climate fund' }] },
      {
        attributeId: interests.id,
        values: [
          { kind: 'text', text: 'AI' },
          { kind: 'text', text: 'Climate' },
        ],
      },
      {
        attributeId: role.id,
        values: [{ kind: 'option', optionId: optionId(role, 'investor'), optionKey: 'investor' }],
      },
      { attributeId: checkSize.id, values: [{ kind: 'number', num: decimal('600000.50') }] },
      { attributeId: isMentor.id, values: [{ kind: 'bool', bool: true }] },
      {
        attributeId: sectors.id,
        values: [
          { kind: 'option', optionId: optionId(sectors, 'climate'), optionKey: 'climate' },
          { kind: 'option', optionId: optionId(sectors, 'health'), optionKey: 'health' },
        ],
      },
    ],
  })

  const b = await createContact(testDb(), {
    firstName: 'Bob',
    lastName: 'Klein',
    values: [
      { attributeId: homeTown.id, values: [{ kind: 'text', text: 'Munich' }] },
      { attributeId: dateOfBirth.id, values: [{ kind: 'date', date: civil('1995-06-30') }] },
      { attributeId: interests.id, values: [{ kind: 'text', text: 'Health' }] },
      {
        attributeId: role.id,
        values: [{ kind: 'option', optionId: optionId(role, 'founder'), optionKey: 'founder' }],
      },
      { attributeId: checkSize.id, values: [{ kind: 'number', num: decimal('100') }] },
      { attributeId: isMentor.id, values: [{ kind: 'bool', bool: false }] },
      {
        attributeId: sectors.id,
        values: [{ kind: 'option', optionId: optionId(sectors, 'climate'), optionKey: 'climate' }],
      },
    ],
  })

  // Carla has nothing at all, which is what every `is empty` case is checked against.
  const c = await createContact(testDb(), { firstName: 'Carla', lastName: 'Ohne' })

  await applyValues(testDb(), {
    recordId: a,
    changes: [{ attributeId: employer.id, values: [{ kind: 'relation', targetRecordId: acme }] }],
    provenance: { source: 'manual' },
  })

  // `created_at` is a column default, and both the default ordering and the keyset walk are on it,
  // so the three rows are given distinct, known instants rather than three values microseconds
  // apart.
  await sql`update record set created_at = '2026-01-01T10:00:00Z' where id = ${a}`.execute(testDb())
  await sql`update record set created_at = '2026-02-01T10:00:00Z' where id = ${b}`.execute(testDb())
  await sql`update record set created_at = '2026-03-01T10:00:00Z' where id = ${c}`.execute(testDb())

  // The nightly sweep that computes these belongs to a later stage, so the derived columns are
  // filled in here. Carla keeps the zero row `createContact` writes: the never-computed case.
  await sql`
    update contact_metrics
       set last_interaction_at = '2026-01-01T09:00:00Z', interaction_count_12m = 3,
           open_followups = 1, next_followup_at = '2026-10-01', warmth = 70
     where contact_id = ${a}
  `.execute(testDb())
  await sql`
    update contact_metrics
       set last_interaction_at = '2026-09-01T09:00:00Z', interaction_count_12m = 1, warmth = 20
     where contact_id = ${b}
  `.execute(testDb())

  const attributes = await listAttributeDefinitions(testDb(), 'contact')
  return {
    resolver: makeFieldResolver('contact', attributes),
    names: { [a]: 'A', [b]: 'B', [c]: 'C' },
    a,
    b,
    c,
    acme,
    attributes,
  }
}

beforeEach(async () => {
  fixture = await seedFixture()
})

// ---------------------------------------------------------------------------------------------
// Running a query
// ---------------------------------------------------------------------------------------------

const TODAY = civil('2026-09-03')
const ALL = ['A', 'B', 'C']

function planFor(query: Partial<ListQuery>, page?: ListPage, limit = 50) {
  return compileList({
    objectType: 'contact',
    resolver: fixture.resolver,
    workspaceId: TEST_WORKSPACE_ID,
    query: {
      filter: [],
      sort: null,
      columns: null,
      q: null,
      view: null,
      limit: null,
      cursor: null,
      ...query,
    },
    today: TODAY,
    timeZone: 'Europe/Berlin',
    limit,
    ...(page === undefined ? {} : { page }),
  })
}

function compiledPlan(query: Partial<ListQuery>, page?: ListPage, limit = 50): ListPlan {
  const plan = planFor(query, page, limit)
  if (!plan.ok) throw new Error(`compileList failed: ${JSON.stringify(plan.issues)}`)
  return plan.value
}

/** The matching rows in the order the query returns them, plus the footer count over the same set. */
async function run(
  query: Partial<ListQuery>,
  page?: ListPage,
  limit = 50,
): Promise<{ ids: string[]; total: number }> {
  const plan = compiledPlan(query, page, limit)
  const rows = await plan.rows.execute(testDb())
  const count = await plan.total.execute(testDb())
  return {
    ids: rows.rows.map((row) => fixture.names[row.id] ?? row.id),
    total: Number(count.rows[0]?.total ?? -1),
  }
}

/** Set semantics: the ids sorted, with the footer asserted to agree with them. */
async function matches(...filter: Filter[]): Promise<string[]> {
  const { ids, total } = await run({ filter })
  expect(total).toBe(ids.length)
  return [...ids].sort()
}

async function ordered(sort: SortRequest): Promise<string[]> {
  return (await run({ sort })).ids
}

function refusal(query: Partial<ListQuery>): readonly string[] {
  const plan = planFor(query)
  if (plan.ok) throw new Error('expected the request to be refused')
  return plan.issues.map((one) => one.code)
}

// ---------------------------------------------------------------------------------------------

describe('text, normalised in SQL and only in SQL (ADR-019)', () => {
  it('finds München from MÜNCH and does not find Munich', async () => {
    // The needle is bound verbatim and folded by `mutuals_norm` on the way in, so an accent, a
    // case difference and a stray space all stop mattering — without a TypeScript twin that would
    // have to agree with `unaccent` forever.
    await expect(matches({ field: 'home_town', op: 'contains', value: 'MÜNCH' })).resolves.toEqual([
      'A',
    ])
    await expect(
      matches({ field: 'home_town', op: 'contains', value: '  münch  ' }),
    ).resolves.toEqual(['A'])
  })

  it('finds Munich from munich and does not find München', async () => {
    await expect(matches({ field: 'home_town', op: 'contains', value: 'munich' })).resolves.toEqual(
      ['B'],
    )
  })

  it('matches equals on the folded value, not the verbatim one', async () => {
    await expect(matches({ field: 'home_town', op: 'equals', value: 'münchen' })).resolves.toEqual([
      'A',
    ])
    await expect(matches({ field: 'home_town', op: 'equals', value: 'MUNCHEN' })).resolves.toEqual([
      'A',
    ])
    // `unaccent` folds ü to u; it does not expand it to ue, and nothing here pretends otherwise.
    await expect(matches({ field: 'home_town', op: 'equals', value: 'muenchen' })).resolves.toEqual(
      [],
    )
  })

  it('searches the record label and the text attributes in one predicate', async () => {
    await expect(run({ q: 'berg' })).resolves.toEqual({ ids: ['A'], total: 1 })
    await expect(run({ q: 'MUNICH' })).resolves.toEqual({ ids: ['B'], total: 1 })
    // Reached through the attribute branch, not the label: "münch" is in nobody's name.
    await expect(run({ q: 'münch' })).resolves.toEqual({ ids: ['A'], total: 1 })
  })

  it('searches a long_text attribute too', async () => {
    await expect(matches({ field: 'bio', op: 'contains', value: 'climate' })).resolves.toEqual([
      'A',
    ])
  })
})

describe('ADR-017: `is empty` is "no live value row exists"', () => {
  it('finds the contact with no value, for every kind of attribute', async () => {
    await expect(matches({ field: 'home_town', op: 'is_empty' })).resolves.toEqual(['C'])
    await expect(matches({ field: 'date_of_birth', op: 'is_empty' })).resolves.toEqual(['C'])
    await expect(matches({ field: 'check_size', op: 'is_empty' })).resolves.toEqual(['C'])
    await expect(matches({ field: 'is_mentor', op: 'is_empty' })).resolves.toEqual(['C'])
    await expect(matches({ field: 'role', op: 'is_empty' })).resolves.toEqual(['C'])
    await expect(matches({ field: 'sectors', op: 'is_empty' })).resolves.toEqual(['C'])
    await expect(matches({ field: 'interests', op: 'is_empty' })).resolves.toEqual(['C'])
    await expect(matches({ field: 'bio', op: 'is_empty' })).resolves.toEqual(['B', 'C'])
    await expect(matches({ field: 'employer', op: 'is_empty' })).resolves.toEqual(['B', 'C'])
  })

  it('is the exact complement of `is not empty`', async () => {
    await expect(matches({ field: 'home_town', op: 'is_not_empty' })).resolves.toEqual(['A', 'B'])
    await expect(matches({ field: 'employer', op: 'is_not_empty' })).resolves.toEqual(['A'])
  })

  it('cannot disagree with an empty string, because an empty string is unwritable', async () => {
    // `CHECK (text_value <> '')` on both `fact` and `attribute_value` is what makes "" and "no
    // value" incapable of diverging at any write site — so `is empty` needs exactly one meaning.
    await expect(
      applyValues(testDb(), {
        recordId: fixture.c,
        changes: [{ attributeId: attribute('home_town').id, values: [{ kind: 'text', text: '' }] }],
        provenance: { source: 'manual' },
      }),
    ).rejects.toThrow()

    await expect(matches({ field: 'home_town', op: 'is_empty' })).resolves.toEqual(['C'])
  })

  it('counts a cleared attribute as empty again, tombstone and all', async () => {
    await applyValues(testDb(), {
      recordId: fixture.b,
      changes: [{ attributeId: attribute('home_town').id, values: null }],
      provenance: { source: 'manual' },
    })
    // Removal is a tombstone in the append-only log, never a delete; the projection is what the
    // query reads, and it says "no live value row" — the only thing `is empty` asks about.
    await expect(matches({ field: 'home_town', op: 'is_empty' })).resolves.toEqual(['B', 'C'])
    await expect(matches({ field: 'home_town', op: 'contains', value: 'munich' })).resolves.toEqual(
      [],
    )
  })
})

describe('ADR-017: `number ≠ x` means "has a value, and it differs"', () => {
  it('leaves out the contact with no value', async () => {
    // Carla has no check size. She is not "a person whose check size is not 100"; she is the
    // person `is empty` is for.
    await expect(matches({ field: 'check_size', op: 'neq', value: '100' })).resolves.toEqual(['A'])
    await expect(matches({ field: 'check_size', op: 'eq', value: '100' })).resolves.toEqual(['B'])
    await expect(matches({ field: 'check_size', op: 'is_empty' })).resolves.toEqual(['C'])
  })

  it('compares numerically, and a trailing zero does not change the number', async () => {
    await expect(matches({ field: 'check_size', op: 'gt', value: '1000' })).resolves.toEqual(['A'])
    await expect(matches({ field: 'check_size', op: 'lt', value: '1000' })).resolves.toEqual(['B'])
    await expect(
      matches({ field: 'check_size', op: 'between', from: '50', to: '200' }),
    ).resolves.toEqual(['B'])
    // 600000.50 and 600000.5 are different scales in `numeric` and the same number.
    await expect(matches({ field: 'check_size', op: 'eq', value: '600000.50' })).resolves.toEqual([
      'A',
    ])
    await expect(matches({ field: 'check_size', op: 'eq', value: '600000.5' })).resolves.toEqual([
      'A',
    ])
  })
})

describe('ADR-017: `single_select is not one of` is NOT (is one of)', () => {
  it('includes the contact with no value, which is how a person reads it', async () => {
    await expect(
      matches({ field: 'role', op: 'is_one_of', values: ['investor'] }),
    ).resolves.toEqual(['A'])
    // "Everyone who is not an Investor" includes the people with no role recorded at all.
    await expect(
      matches({ field: 'role', op: 'is_not_one_of', values: ['investor'] }),
    ).resolves.toEqual(['B', 'C'])
  })

  it('resolves option keys, so a filter survives a label rename', async () => {
    await expect(
      matches({ field: 'role', op: 'is_one_of', values: ['founder', 'investor'] }),
    ).resolves.toEqual(['A', 'B'])

    await testDb()
      .updateTable('attribute_option')
      .set({ label: 'Angel investor' })
      .where('id', '=', optionId(attribute('role'), 'investor'))
      .execute()

    await expect(
      matches({ field: 'role', op: 'is_one_of', values: ['investor'] }),
    ).resolves.toEqual(['A'])
  })
})

describe('multi-valued attributes', () => {
  it('matches a tag by its normalised key, whatever case it was typed in', async () => {
    await expect(
      matches({ field: 'interests', op: 'contains_any_of', values: ['Climate'] }),
    ).resolves.toEqual(['A'])
    await expect(
      matches({ field: 'interests', op: 'contains_any_of', values: ['ai', 'HEALTH'] }),
    ).resolves.toEqual(['A', 'B'])
  })

  it('returns one row per contact, not one per matching element', async () => {
    // The reason a chip is an EXISTS and not a JOIN: Anna has two interests, both of them match,
    // and the footer count still has to say 1.
    await expect(
      run({ filter: [{ field: 'interests', op: 'contains_any_of', values: ['ai', 'climate'] }] }),
    ).resolves.toEqual({ ids: ['A'], total: 1 })
  })

  it('distinguishes "any of" from "all of" on a multi_select', async () => {
    await expect(
      matches({ field: 'sectors', op: 'contains_any_of', values: ['climate'] }),
    ).resolves.toEqual(['A', 'B'])
    await expect(
      matches({ field: 'sectors', op: 'contains_all_of', values: ['climate', 'health'] }),
    ).resolves.toEqual(['A'])
  })

  it('follows a relation through record_link', async () => {
    await expect(
      matches({ field: 'employer', op: 'has_any_of', values: [fixture.acme] }),
    ).resolves.toEqual(['A'])
    await expect(
      matches({ field: 'employer', op: 'has_any_of', values: [fixture.b] }),
    ).resolves.toEqual([])
  })
})

describe('dates', () => {
  it('compares a date attribute as a calendar day', async () => {
    await expect(
      matches({ field: 'date_of_birth', op: 'before', value: '1990-01-01' }),
    ).resolves.toEqual(['A'])
    await expect(
      matches({ field: 'date_of_birth', op: 'after', value: '1990-01-01' }),
    ).resolves.toEqual(['B'])
    await expect(
      matches({ field: 'date_of_birth', op: 'between', from: '1995-01-01', to: '1996-01-01' }),
    ).resolves.toEqual(['B'])
  })

  it('converts a civil day to the profile time zone for a timestamptz column', async () => {
    await expect(
      matches({ field: 'created_at', op: 'between', from: '2026-01-01', to: '2026-02-01' }),
    ).resolves.toEqual(['A', 'B'])
    await expect(
      matches({ field: 'created_at', op: 'after', value: '2026-02-01' }),
    ).resolves.toEqual(['C'])
  })
})

describe('derived columns (§5.2)', () => {
  it('filters on warmth and the interaction count', async () => {
    await expect(matches({ field: 'warmth', op: 'gt', value: '50' })).resolves.toEqual(['A'])
    await expect(
      matches({ field: 'warmth', op: 'between', from: '10', to: '30' }),
    ).resolves.toEqual(['B'])
    await expect(
      matches({ field: 'interaction_count_12m', op: 'between', from: '1', to: '2' }),
    ).resolves.toEqual(['B'])
  })

  it('expresses "Last interaction is more than 90 days ago" against the injected today', async () => {
    await expect(
      matches({ field: 'last_interaction_at', op: 'older_than', n: 90, unit: 'day' }),
    ).resolves.toEqual(['A'])
    await expect(
      matches({ field: 'last_interaction_at', op: 'newer_than', n: 90, unit: 'day' }),
    ).resolves.toEqual(['B'])
    // Somebody you have never spoken to matches neither bound: "more than 90 days ago" is not
    // true of a person you have never interacted with (ADR-040).
    await expect(matches({ field: 'last_interaction_at', op: 'is_empty' })).resolves.toEqual(['C'])
  })

  it('finds the follow-ups still ahead of today', async () => {
    await expect(
      matches({ field: 'next_followup_at', op: 'newer_than', n: 0, unit: 'day' }),
    ).resolves.toEqual(['A'])
    await expect(matches({ field: 'next_followup_at', op: 'is_empty' })).resolves.toEqual([
      'B',
      'C',
    ])
  })
})

describe('system columns', () => {
  it('matches the generated display name case-insensitively', async () => {
    await expect(
      matches({ field: 'display_name', op: 'contains', value: 'ANNA' }),
    ).resolves.toEqual(['A'])
    await expect(
      matches({ field: 'display_name', op: 'equals', value: 'Bob Klein' }),
    ).resolves.toEqual(['B'])
  })

  it('filters the provenance enum and the import batch', async () => {
    await expect(
      matches({ field: 'created_via', op: 'is_one_of', values: ['manual'] }),
    ).resolves.toEqual(ALL)
    await expect(
      matches({ field: 'created_via', op: 'is_not_one_of', values: ['manual'] }),
    ).resolves.toEqual([])
    await expect(matches({ field: 'import_batch_id', op: 'is_empty' })).resolves.toEqual(ALL)
  })
})

describe('several chips', () => {
  it('combines with AND, across an attribute and a select', async () => {
    await expect(
      matches(
        { field: 'home_town', op: 'is_not_empty' },
        { field: 'role', op: 'is_one_of', values: ['founder'] },
      ),
    ).resolves.toEqual(['B'])
  })

  it('combines an attribute, a derived column and the search box', async () => {
    await expect(
      run({
        filter: [
          { field: 'sectors', op: 'contains_any_of', values: ['climate'] },
          { field: 'warmth', op: 'gt', value: '50' },
        ],
        q: 'berg',
      }),
    ).resolves.toEqual({ ids: ['A'], total: 1 })
  })

  it('returns nothing, and counts nothing, when the chips cannot both hold', async () => {
    await expect(
      matches(
        { field: 'role', op: 'is_one_of', values: ['founder'] },
        { field: 'is_mentor', op: 'is_yes' },
      ),
    ).resolves.toEqual([])
  })
})

describe('typed sorting', () => {
  it('sorts a custom number attribute numerically, with the empty one last', async () => {
    await expect(ordered({ field: 'check_size', direction: 'desc' })).resolves.toEqual(ALL)
    await expect(ordered({ field: 'check_size', direction: 'asc' })).resolves.toEqual([
      'B',
      'A',
      'C',
    ])
  })

  it('sorts text by the byte-ordered folded value', async () => {
    // `munchen` < `munich` under COLLATE "C" — the comparison is a memcmp, so the answer does not
    // change when the machine this runs on upgrades glibc.
    await expect(ordered({ field: 'home_town', direction: 'asc' })).resolves.toEqual(ALL)
    await expect(ordered({ field: 'home_town', direction: 'desc' })).resolves.toEqual([
      'B',
      'A',
      'C',
    ])
  })

  it('sorts a single_select by the option’s position, not by its label', async () => {
    // Founder is position 0 and Investor position 1, so Bob leads. Alphabetically he would too —
    // until the rename below, which is why the rename is part of the test.
    await testDb()
      .updateTable('attribute_option')
      .set({ label: 'Angel' })
      .where('id', '=', optionId(attribute('role'), 'investor'))
      .execute()
    await expect(ordered({ field: 'role', direction: 'asc' })).resolves.toEqual(['B', 'A', 'C'])
  })

  it('sorts yes before no when ascending', async () => {
    await expect(ordered({ field: 'is_mentor', direction: 'asc' })).resolves.toEqual(ALL)
    await expect(ordered({ field: 'is_mentor', direction: 'desc' })).resolves.toEqual([
      'B',
      'A',
      'C',
    ])
  })

  it('sorts dates chronologically, and derived values with the empty ones last', async () => {
    await expect(ordered({ field: 'date_of_birth', direction: 'asc' })).resolves.toEqual(ALL)
    await expect(ordered({ field: 'warmth', direction: 'desc' })).resolves.toEqual(ALL)
    await expect(ordered({ field: 'display_name', direction: 'asc' })).resolves.toEqual(ALL)
  })

  it('falls back to created_at descending', async () => {
    await expect(run({})).resolves.toEqual({ ids: ['C', 'B', 'A'], total: 3 })
  })
})

describe('paging', () => {
  it('walks the default ordering by keyset without repeating or skipping a row', async () => {
    const page1 = await compiledPlan({}, undefined, 2).rows.execute(testDb())
    const last = page1.rows.at(-1)
    if (last === undefined) throw new Error('the first page was empty')

    const page2 = await compiledPlan(
      {},
      {
        mode: 'keyset',
        createdAt: new Date(last.sort_key as string).toISOString(),
        id: last.id,
      },
    ).rows.execute(testDb())

    expect([...page1.rows, ...page2.rows].map((row) => fixture.names[row.id] ?? row.id)).toEqual([
      'C',
      'B',
      'A',
    ])
  })

  it('pages an ordering that reads its key from a join by offset', async () => {
    await expect(
      run({ sort: { field: 'check_size', direction: 'asc' } }, { mode: 'offset', offset: 1 }),
    ).resolves.toEqual({ ids: ['A', 'C'], total: 3 })
  })

  it('counts every match, not just the page', async () => {
    // §5.2's "Rows: 2,236" footer is over the predicate, not over the page.
    await expect(run({}, undefined, 2)).resolves.toEqual({ ids: ['C', 'B'], total: 3 })
  })
})

describe('refusals reach the caller before any SQL runs', () => {
  it('refuses a sort on a type §4.2 marks "—"', () => {
    expect(refusal({ sort: { field: 'bio', direction: 'asc' } })).toEqual(['not_sortable'])
    expect(refusal({ sort: { field: 'interests', direction: 'asc' } })).toEqual(['not_sortable'])
    expect(refusal({ sort: { field: 'employer', direction: 'asc' } })).toEqual(['not_sortable'])
    expect(refusal({ sort: { field: 'sectors', direction: 'asc' } })).toEqual(['not_sortable'])
  })

  it('refuses a bad chip', () => {
    expect(refusal({ filter: [{ field: 'nope', op: 'is_empty' }] })).toEqual(['unknown_field'])
    expect(refusal({ filter: [{ field: 'home_town', op: 'is_yes' }] })).toEqual([
      'operator_not_allowed',
    ])
    expect(refusal({ filter: [{ field: 'check_size', op: 'eq', value: 'lots' }] })).toEqual([
      'not_a_number',
    ])
    expect(
      refusal({ filter: [{ field: 'date_of_birth', op: 'before', value: '31/12/1990' }] }),
    ).toEqual(['bad_date'])
    expect(refusal({ filter: [{ field: 'role', op: 'is_one_of', values: ['wizard'] }] })).toEqual([
      'unknown_option',
    ])
    expect(
      refusal({ filter: [{ field: 'check_size', op: 'between', from: '9', to: '1' }] }),
    ).toEqual(['out_of_range'])
  })
})
