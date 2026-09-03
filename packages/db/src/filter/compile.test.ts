/**
 * Golden SQL for the filter compiler (ADR-077 (a) and (c)).
 *
 * Kysely's `.compile()` is pure — the reason it was chosen over Drizzle (ADR-033) — so every case
 * below asserts the **exact** SQL string and the **exact** parameter array with no database in
 * sight. The strings were written from §4.2's operator table and the storage decision, not pasted
 * from actual output: a golden test updated by pasting is a snapshot with extra steps.
 *
 * Three properties get their own named tests because ADR-017 settles them against two products
 * that disagree with each other: `is empty` for all twelve types, `number ≠ x`, and
 * `single_select is not one of`.
 *
 * {@link GOLDEN} is also the input to the completeness test at the bottom: every `(type, operator)`
 * pair in `OPERATORS_BY_TYPE` must have a case here, so adding a thirteenth type fails the suite
 * until its SQL is written down.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type Expression,
  type RawBuilder,
  type SqlBool,
} from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTE_TYPE_NAMES,
  OBJECT_TYPES,
  OPERATORS_BY_TYPE,
  civil,
  completeDefinition,
  makeFieldResolver,
  systemFields,
  type AttributeDefinition,
  type AttributeTypeName,
  type Filter,
  type ObjectType,
  type OperatorId,
} from '@mutuals/core'

import {
  SYSTEM_COLUMNS,
  compileFilter,
  compileFilterSet,
  compileSearch,
  conjoin,
  metricTableOf,
  type CompileContext,
} from './compile.ts'

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const dialect = {
  createAdapter: () => new PostgresAdapter(),
  createDriver: () => new DummyDriver(),
  createIntrospector: (db: Kysely<never>) => new PostgresIntrospector(db),
  createQueryCompiler: () => new PostgresQueryCompiler(),
}

/** No driver, no connection: `compile()` walks the operation tree and stops. */
const db = new Kysely<Record<string, never>>({ dialect })

interface Rendered {
  readonly sql: string
  readonly parameters: readonly unknown[]
}

/**
 * Every expression the compiler returns is built with the `sql` tag, so it is a `RawBuilder` and
 * carries `compile()`. The guard turns a future change of that into a readable failure rather than
 * an "is not a function" in a stack trace.
 */
function render(expression: Expression<SqlBool>): Rendered {
  const raw = expression as RawBuilder<SqlBool>
  if (raw.isRawBuilder !== true) throw new Error('the compiler returned a non-raw expression')
  const compiled = raw.compile(db)
  return { sql: compiled.sql, parameters: compiled.parameters }
}

// ---------------------------------------------------------------------------------------------
// One attribute per type, plus the fields §5.2 calls derived.
// ---------------------------------------------------------------------------------------------

const ATTRIBUTE_ID = {
  short_text: 'a0000000-0000-4000-8000-000000000001',
  long_text: 'a0000000-0000-4000-8000-000000000002',
  number: 'a0000000-0000-4000-8000-000000000003',
  date: 'a0000000-0000-4000-8000-000000000004',
  yes_no: 'a0000000-0000-4000-8000-000000000005',
  single_select: 'a0000000-0000-4000-8000-000000000006',
  multi_select: 'a0000000-0000-4000-8000-000000000007',
  tags: 'a0000000-0000-4000-8000-000000000008',
  url: 'a0000000-0000-4000-8000-000000000009',
  email: 'a0000000-0000-4000-8000-00000000000a',
  phone: 'a0000000-0000-4000-8000-00000000000b',
  relation: 'a0000000-0000-4000-8000-00000000000c',
} as const satisfies Record<AttributeTypeName, string>

const OPTION_ID = {
  founder: 'b0000000-0000-4000-8000-000000000001',
  investor: 'b0000000-0000-4000-8000-000000000002',
  climate: 'b0000000-0000-4000-8000-000000000011',
  health: 'b0000000-0000-4000-8000-000000000012',
} as const

const ORGANIZATION_ID = 'c0000000-0000-4000-8000-000000000001'
const BATCH_ID = 'd0000000-0000-4000-8000-000000000001'

/** The slug each type is reached by, so a golden case names a field the way a URL does. */
const SLUG = {
  short_text: 'city',
  long_text: 'notes',
  number: 'check_size',
  date: 'birthday',
  yes_no: 'is_mentor',
  single_select: 'job_role',
  multi_select: 'sectors',
  tags: 'areas_of_interest',
  url: 'website',
  email: 'email',
  phone: 'phone',
  relation: 'organization',
} as const satisfies Record<AttributeTypeName, string>

const STAMPS = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }

function define(type: AttributeTypeName, extra: Record<string, unknown> = {}): AttributeDefinition {
  return completeDefinition(
    {
      id: ATTRIBUTE_ID[type],
      objectType: 'contact',
      title: SLUG[type],
      slug: SLUG[type],
      type,
      config: {},
      isSystem: false,
      position: ATTRIBUTE_TYPE_NAMES.indexOf(type),
      showByDefault: true,
      ...extra,
    } as never,
    STAMPS,
  )
}

const option = (id: string, key: string, position: number) => ({
  id,
  key,
  label: key,
  position,
})

const ATTRIBUTES: readonly AttributeDefinition[] = [
  define('short_text'),
  define('long_text'),
  define('number'),
  define('date'),
  define('yes_no'),
  define('single_select', {
    options: [option(OPTION_ID.founder, 'founder', 0), option(OPTION_ID.investor, 'investor', 1)],
  }),
  define('multi_select', {
    options: [option(OPTION_ID.climate, 'climate', 0), option(OPTION_ID.health, 'health', 1)],
  }),
  define('tags'),
  define('url'),
  define('email'),
  define('phone'),
  define('relation', {
    config: { targetObjectType: 'organization', cardinality: 'many', hasLinkMetadata: true },
  }),
]

const ctx: CompileContext = {
  objectType: 'contact',
  resolver: makeFieldResolver('contact', ATTRIBUTES),
  today: civil('2026-09-03'),
  timeZone: 'Europe/Berlin',
}

function compiled(filter: Filter): Rendered {
  const result = compileFilter(filter, ctx)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.issues)}`)
  return render(result.value.expression)
}

function issuesOf(filter: Filter, context: CompileContext = ctx): readonly string[] {
  const result = compileFilter(filter, context)
  if (result.ok) throw new Error(`expected "${filter.op}" on "${filter.field}" to be refused`)
  return result.issues.map((one) => one.code)
}

// ---------------------------------------------------------------------------------------------
// The two shells every attribute predicate is wrapped in. Asserted once, in full, then reused so
// the per-operator goldens below are the predicate and nothing but the predicate.
// ---------------------------------------------------------------------------------------------

const VALUE_SHELL =
  'select 1 from "attribute_value" as "v" where "v"."record_id" = "r"."id" and "v"."attribute_id" = $1'
const LINK_SHELL =
  'select 1 from "record_link" as "l" where "l"."from_record_id" = "r"."id" and "l"."attribute_id" = $1'

const inValues = (predicate: string) => `exists (${VALUE_SHELL} and ${predicate})`
const noValues = `not exists (${VALUE_SHELL})`
const anyValues = `exists (${VALUE_SHELL})`
const inLinks = (predicate: string) => `exists (${LINK_SHELL} and ${predicate})`

describe('the shape every attribute chip is wrapped in', () => {
  it('is one correlated EXISTS over attribute_value, never a join', () => {
    // A JOIN per predicate multiplies rows for a multi-valued attribute — five tags, five copies
    // of the contact, and a footer count that lies (storage-DECISION §5.2).
    const { sql } = compiled({ field: 'city', op: 'is_not_empty' })
    expect(sql).toBe(
      'exists (select 1 from "attribute_value" as "v" where "v"."record_id" = "r"."id" and "v"."attribute_id" = $1)',
    )
  })

  it('is one correlated EXISTS over record_link for a relation', () => {
    const { sql } = compiled({ field: 'organization', op: 'is_not_empty' })
    expect(sql).toBe(
      'exists (select 1 from "record_link" as "l" where "l"."from_record_id" = "r"."id" and "l"."attribute_id" = $1)',
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Golden SQL, one entry per (type, operator) pair of §4.2's table.
// ---------------------------------------------------------------------------------------------

interface GoldenCase {
  readonly name: string
  readonly type: AttributeTypeName
  readonly filter: Filter
  readonly sql: string
  readonly parameters: readonly unknown[]
}

const golden = (
  type: AttributeTypeName,
  filter: Filter,
  sql: string,
  parameters: readonly unknown[],
  name?: string,
): GoldenCase => ({ name: name ?? `${type} ${filter.op}`, type, filter, sql, parameters })

const emptyPair = (type: AttributeTypeName, relation = false): readonly GoldenCase[] => {
  const field = SLUG[type]
  const present = relation ? `exists (${LINK_SHELL})` : anyValues
  const absent = relation ? `not exists (${LINK_SHELL})` : noValues
  return [
    golden(type, { field, op: 'is_empty' }, absent, [ATTRIBUTE_ID[type]]),
    golden(type, { field, op: 'is_not_empty' }, present, [ATTRIBUTE_ID[type]]),
  ]
}

const containsCase = (type: AttributeTypeName, needle: string): GoldenCase =>
  golden(
    type,
    { field: SLUG[type], op: 'contains', value: needle },
    inValues(`"v"."text_norm" like '%' || mutuals_esc(mutuals_norm($2)) || '%'`),
    [ATTRIBUTE_ID[type], needle],
  )

const GOLDEN: readonly GoldenCase[] = [
  // ---------------------------------------------------------------------- short_text
  containsCase('short_text', 'münch'),
  golden(
    'short_text',
    { field: 'city', op: 'equals', value: 'München' },
    // The truncated, COLLATE "C" sort column narrows through `av_attr_text_idx`; the full
    // normalised column then rechecks, so two values sharing a 256-character prefix stay apart.
    inValues(
      `"v"."text_sort" = left(mutuals_norm($2), 256) and "v"."text_norm" = mutuals_norm($3)`,
    ),
    [ATTRIBUTE_ID.short_text, 'München', 'München'],
  ),
  ...emptyPair('short_text'),

  // ---------------------------------------------------------------------- long_text
  containsCase('long_text', 'raising'),
  ...emptyPair('long_text'),

  // ---------------------------------------------------------------------- number
  golden(
    'number',
    { field: 'check_size', op: 'eq', value: '600000.50' },
    inValues(`"v"."num_value" = $2::numeric`),
    [ATTRIBUTE_ID.number, '600000.50'],
  ),
  golden(
    'number',
    { field: 'check_size', op: 'neq', value: '100' },
    inValues(`"v"."num_value" <> $2::numeric`),
    [ATTRIBUTE_ID.number, '100'],
  ),
  golden(
    'number',
    { field: 'check_size', op: 'lt', value: '100' },
    inValues(`"v"."num_value" < $2::numeric`),
    [ATTRIBUTE_ID.number, '100'],
  ),
  golden(
    'number',
    { field: 'check_size', op: 'gt', value: '1000' },
    inValues(`"v"."num_value" > $2::numeric`),
    [ATTRIBUTE_ID.number, '1000'],
  ),
  golden(
    'number',
    { field: 'check_size', op: 'between', from: '50', to: '200' },
    inValues(`"v"."num_value" between $2::numeric and $3::numeric`),
    [ATTRIBUTE_ID.number, '50', '200'],
  ),
  ...emptyPair('number'),

  // ---------------------------------------------------------------------- date
  golden(
    'date',
    { field: 'birthday', op: 'before', value: '1990-01-01' },
    inValues(`"v"."date_value" < $2::date`),
    [ATTRIBUTE_ID.date, '1990-01-01'],
  ),
  golden(
    'date',
    { field: 'birthday', op: 'after', value: '1990-01-01' },
    inValues(`"v"."date_value" > $2::date`),
    [ATTRIBUTE_ID.date, '1990-01-01'],
  ),
  golden(
    'date',
    { field: 'birthday', op: 'between', from: '1990-01-01', to: '1991-01-01' },
    inValues(`"v"."date_value" between $2::date and $3::date`),
    [ATTRIBUTE_ID.date, '1990-01-01', '1991-01-01'],
  ),
  golden(
    'date',
    { field: 'birthday', op: 'in_relative', preset: 'this_year' },
    // Resolved in packages/core against the injected `today` (ADR-040), so no `now()` and no
    // interval arithmetic ever reaches the emitted SQL.
    inValues(`"v"."date_value" between $2::date and $3::date`),
    [ATTRIBUTE_ID.date, '2026-01-01', '2026-12-31'],
    'date in_relative this_year',
  ),
  golden(
    'date',
    { field: 'birthday', op: 'in_relative', preset: 'last_30_days' },
    inValues(`"v"."date_value" between $2::date and $3::date`),
    [ATTRIBUTE_ID.date, '2026-08-04', '2026-09-03'],
    'date in_relative last_30_days',
  ),
  golden(
    'date',
    { field: 'birthday', op: 'older_than', n: 90, unit: 'day' },
    inValues(`"v"."date_value" < $2::date`),
    [ATTRIBUTE_ID.date, '2026-06-05'],
  ),
  golden(
    'date',
    { field: 'birthday', op: 'newer_than', n: 90, unit: 'day' },
    inValues(`"v"."date_value" > $2::date`),
    [ATTRIBUTE_ID.date, '2026-06-05'],
  ),
  ...emptyPair('date'),

  // ---------------------------------------------------------------------- yes_no
  golden('yes_no', { field: 'is_mentor', op: 'is_yes' }, inValues(`"v"."bool_value"`), [
    ATTRIBUTE_ID.yes_no,
  ]),
  golden('yes_no', { field: 'is_mentor', op: 'is_no' }, inValues(`not "v"."bool_value"`), [
    ATTRIBUTE_ID.yes_no,
  ]),
  ...emptyPair('yes_no'),

  // ---------------------------------------------------------------------- single_select
  golden(
    'single_select',
    { field: 'job_role', op: 'is_one_of', values: ['investor'] },
    // The wire carries option *keys*; they are resolved to ids here, so a rename is free and no
    // uuid ever appears in a shareable URL.
    inValues(`"v"."option_id" = any($2::uuid[])`),
    [ATTRIBUTE_ID.single_select, [OPTION_ID.investor]],
  ),
  golden(
    'single_select',
    { field: 'job_role', op: 'is_not_one_of', values: ['investor'] },
    `not ${inValues(`"v"."option_id" = any($2::uuid[])`)}`,
    [ATTRIBUTE_ID.single_select, [OPTION_ID.investor]],
  ),
  ...emptyPair('single_select'),

  // ---------------------------------------------------------------------- multi_select
  golden(
    'multi_select',
    { field: 'sectors', op: 'contains_any_of', values: ['climate', 'health'] },
    inValues(`"v"."option_id" = any($2::uuid[])`),
    [ATTRIBUTE_ID.multi_select, [OPTION_ID.climate, OPTION_ID.health]],
  ),
  golden(
    'multi_select',
    { field: 'sectors', op: 'contains_all_of', values: ['climate', 'health'] },
    // Not an EXISTS: "has all of these" is a count, and counting DISTINCT tolerates the same
    // option arriving twice from two facts without inflating the total.
    `(select count(distinct "v2"."option_id") from "attribute_value" as "v2" where "v2"."record_id" = "r"."id" and "v2"."attribute_id" = $1 and "v2"."option_id" = any($2::uuid[])) = cardinality($3::uuid[])`,
    [
      ATTRIBUTE_ID.multi_select,
      [OPTION_ID.climate, OPTION_ID.health],
      [OPTION_ID.climate, OPTION_ID.health],
    ],
  ),
  ...emptyPair('multi_select'),

  // ---------------------------------------------------------------------- tags
  golden(
    'tags',
    { field: 'areas_of_interest', op: 'contains_any_of', values: ['AI', 'Climate'] },
    // ADR-018: an element's identity is `left(mutuals_norm(text), 512)`, and ADR-019 says the fold
    // is SQL's — so the needles are normalised by the database, not before it.
    inValues(
      `"v"."value_key" = any(array(select left(mutuals_norm(k), 512) from unnest($2::text[]) as k))`,
    ),
    [ATTRIBUTE_ID.tags, ['AI', 'Climate']],
  ),
  ...emptyPair('tags'),

  // ---------------------------------------------------------------------- url / email / phone
  containsCase('url', 'linkedin'),
  ...emptyPair('url'),
  containsCase('email', 'example.com'),
  ...emptyPair('email'),
  containsCase('phone', '+4930'),
  ...emptyPair('phone'),

  // ---------------------------------------------------------------------- relation
  golden(
    'relation',
    { field: 'organization', op: 'has_any_of', values: [ORGANIZATION_ID] },
    inLinks(`"l"."to_record_id" = any($2::uuid[])`),
    [ATTRIBUTE_ID.relation, [ORGANIZATION_ID]],
  ),
  ...emptyPair('relation', true),
]

describe('golden SQL, one case per (type, operator) pair of §4.2', () => {
  for (const entry of GOLDEN) {
    it(entry.name, () => {
      const actual = compiled(entry.filter)
      expect(actual.sql).toBe(entry.sql)
      expect(actual.parameters).toEqual(entry.parameters)
    })
  }

  it('covers every pair in OPERATORS_BY_TYPE', () => {
    // (c) of ADR-077: the test that keeps the suite honest as types are added.
    const covered = new Set(GOLDEN.map((entry) => `${entry.type}:${entry.filter.op}`))
    const missing = ATTRIBUTE_TYPE_NAMES.flatMap((type) =>
      (OPERATORS_BY_TYPE[type] as readonly OperatorId[])
        .filter((op) => !covered.has(`${type}:${op}`))
        .map((op) => `${type}:${op}`),
    )
    expect(missing).toEqual([])
  })

  it('has no golden case for a pair §4.2 does not offer', () => {
    const stray = GOLDEN.filter(
      (entry) =>
        !(OPERATORS_BY_TYPE[entry.type] as readonly OperatorId[]).includes(entry.filter.op),
    ).map((entry) => entry.name)
    expect(stray).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// ADR-017 — the three semantics the brief does not specify, one named test each.
// ---------------------------------------------------------------------------------------------

describe('ADR-017: `is empty` is "no live value row exists", for all twelve types', () => {
  it('compiles to one NOT EXISTS for every type, with no per-type branch', () => {
    const shapes = ATTRIBUTE_TYPE_NAMES.map((type) => {
      const { sql, parameters } = compiled({ field: SLUG[type], op: 'is_empty' })
      return { type, sql, parameters }
    })

    for (const shape of shapes) {
      expect(shape.parameters).toEqual([ATTRIBUTE_ID[shape.type]])
      // Relations live in record_link, so they are the one type with a different table — the
      // *shape*, one negated correlated semi-join, is identical.
      expect(shape.sql).toBe(shape.type === 'relation' ? `not exists (${LINK_SHELL})` : noValues)
    }

    // Eleven of twelve produce byte-identical SQL: proof there is no per-type definition of empty.
    const distinct = new Set(shapes.map((shape) => shape.sql))
    expect(distinct.size).toBe(2)
  })

  it('never mentions the empty string: a CHECK makes "" and "no value" incapable of diverging', () => {
    for (const type of ATTRIBUTE_TYPE_NAMES) {
      expect(compiled({ field: SLUG[type], op: 'is_empty' }).sql).not.toContain(`''`)
    }
  })

  it('is the exact negation of `is not empty`', () => {
    for (const type of ATTRIBUTE_TYPE_NAMES) {
      const empty = compiled({ field: SLUG[type], op: 'is_empty' })
      const notEmpty = compiled({ field: SLUG[type], op: 'is_not_empty' })
      expect(empty.sql).toBe(`not ${notEmpty.sql}`)
      expect(empty.parameters).toEqual(notEmpty.parameters)
    }
  })
})

describe('ADR-017: `number ≠ x` means "has a value, and it differs"', () => {
  it('puts the inequality inside the EXISTS, so a record with no value does not match', () => {
    const { sql, parameters } = compiled({ field: 'check_size', op: 'neq', value: '100' })
    expect(sql).toBe(inValues(`"v"."num_value" <> $2::numeric`))
    expect(parameters).toEqual([ATTRIBUTE_ID.number, '100'])
    // The other convention — `NOT EXISTS(… = …)` — silently returns every empty record, which
    // reads as a bug. `is empty` is the operator for that question.
    expect(sql.startsWith('not ')).toBe(false)
  })

  it('differs from `is empty` OR-ed with the inequality', () => {
    const neq = compiled({ field: 'check_size', op: 'neq', value: '100' })
    const empty = compiled({ field: 'check_size', op: 'is_empty' })
    expect(neq.sql).not.toContain(empty.sql)
  })
})

describe('ADR-017: `single_select is not one of` is NOT (is one of)', () => {
  it('negates the whole semi-join, so a record with no value matches', () => {
    const oneOf = compiled({ field: 'job_role', op: 'is_one_of', values: ['investor'] })
    const notOneOf = compiled({ field: 'job_role', op: 'is_not_one_of', values: ['investor'] })
    // Which is how a person reads "is not an Investor".
    expect(notOneOf.sql).toBe(`not ${oneOf.sql}`)
    expect(notOneOf.parameters).toEqual(oneOf.parameters)
  })

  it('reads the same way on the `created_via` enum column, where NULL is possible', () => {
    // A column has no semi-join to negate, so the NULL branch is written out; the reading is the
    // same one ADR-017 gives the attribute case.
    const { sql, parameters } = compiled({
      field: 'created_via',
      op: 'is_not_one_of',
      values: ['import'],
    })
    expect(sql).toBe(`("r"."created_via" is null or ("r"."created_via")::text <> all($1::text[]))`)
    expect(parameters).toEqual([['import']])
  })
})

// ---------------------------------------------------------------------------------------------
// System and derived columns (§5.2)
// ---------------------------------------------------------------------------------------------

describe('system columns', () => {
  it('matches a generated text column case-insensitively through mutuals_norm', () => {
    const { sql, parameters } = compiled({
      field: 'display_name',
      op: 'contains',
      value: 'anna',
    })
    expect(sql).toBe(
      `mutuals_norm("c"."display_name") like '%' || mutuals_esc(mutuals_norm($1)) || '%'`,
    )
    expect(parameters).toEqual(['anna'])
  })

  it('compares a generated text column for equality through mutuals_norm on both sides', () => {
    const { sql, parameters } = compiled({
      field: 'display_name',
      op: 'equals',
      value: 'Bob Klein',
    })
    expect(sql).toBe(`mutuals_norm("c"."display_name") = mutuals_norm($1)`)
    expect(parameters).toEqual(['Bob Klein'])
  })

  it('treats "" and NULL alike on a generated text column', () => {
    // `display_name` is `btrim(first || ' ' || last)`, so a contact with no names at all is `''`.
    // Without the second disjunct `is empty` would disagree with ADR-017 for attributes.
    const empty = compiled({ field: 'display_name', op: 'is_empty' })
    expect(empty.sql).toBe(`("c"."display_name" is null or "c"."display_name" = '')`)
    expect(empty.parameters).toEqual([])

    const notEmpty = compiled({ field: 'display_name', op: 'is_not_empty' })
    expect(notEmpty.sql).toBe(`not ("c"."display_name" is null or "c"."display_name" = '')`)
  })

  it('tests only NULL on a non-text column', () => {
    const { sql, parameters } = compiled({ field: 'import_batch_id', op: 'is_empty' })
    expect(sql).toBe(`("r"."import_batch_id" is null)`)
    expect(parameters).toEqual([])
  })

  it('casts a uuid column comparison rather than binding an untyped string', () => {
    const { sql, parameters } = compiled({
      field: 'import_batch_id',
      op: 'equals',
      value: BATCH_ID,
    })
    expect(sql).toBe(`"r"."import_batch_id" = $1::uuid`)
    expect(parameters).toEqual([BATCH_ID])
  })

  it('casts a real Postgres enum to text, so a bare parameter needs no enum type', () => {
    expect(compiled({ field: 'created_via', op: 'equals', value: 'manual' })).toEqual({
      sql: `("r"."created_via")::text = $1`,
      parameters: ['manual'],
    })
    expect(
      compiled({ field: 'created_via', op: 'is_one_of', values: ['import', 'manual'] }),
    ).toEqual({
      sql: `("r"."created_via")::text = any($1::text[])`,
      parameters: [['import', 'manual']],
    })
  })

  it('reads a boolean column directly', () => {
    expect(compiled({ field: 'pinned_important', op: 'is_yes' })).toEqual({
      sql: `"c"."pinned_important"`,
      parameters: [],
    })
    expect(compiled({ field: 'not_important', op: 'is_no' })).toEqual({
      sql: `not "c"."not_important"`,
      parameters: [],
    })
  })

  it('converts a civil day to the profile time zone for a timestamptz column', () => {
    // "On 3 March" is only a question you can answer in a time zone (ADR-045). The upper bound
    // becomes an exclusive limit on the *next* day, computed in TypeScript and bound — so the
    // emitted SQL contains no interval arithmetic.
    expect(
      compiled({ field: 'created_at', op: 'between', from: '2026-01-01', to: '2026-01-31' }),
    ).toEqual({
      sql: `("r"."created_at" >= ($1::date::timestamp at time zone $2) and "r"."created_at" < ($3::date::timestamp at time zone $4))`,
      parameters: ['2026-01-01', 'Europe/Berlin', '2026-02-01', 'Europe/Berlin'],
    })
  })

  it('makes "after 1 January" mean "at or after the start of 2 January" for an instant', () => {
    expect(compiled({ field: 'created_at', op: 'after', value: '2026-01-01' })).toEqual({
      sql: `"r"."created_at" >= ($1::date::timestamp at time zone $2)`,
      parameters: ['2026-01-02', 'Europe/Berlin'],
    })
    expect(compiled({ field: 'created_at', op: 'before', value: '2026-01-01' })).toEqual({
      sql: `"r"."created_at" < ($1::date::timestamp at time zone $2)`,
      parameters: ['2026-01-01', 'Europe/Berlin'],
    })
  })
})

describe('derived columns (§5.2)', () => {
  it('filters a numeric metric on the metrics alias', () => {
    expect(compiled({ field: 'warmth', op: 'gt', value: '50' })).toEqual({
      sql: `"m"."warmth" > $1::numeric`,
      parameters: ['50'],
    })
    expect(compiled({ field: 'interaction_count_12m', op: 'between', from: '1', to: '5' })).toEqual(
      {
        sql: `"m"."interaction_count_12m" between $1::numeric and $2::numeric`,
        parameters: ['1', '5'],
      },
    )
    expect(compiled({ field: 'open_followups', op: 'eq', value: '0' })).toEqual({
      sql: `"m"."open_followups" = $1::numeric`,
      parameters: ['0'],
    })
  })

  it('expresses §5.2\'s "Last interaction is more than 90 days ago" with no clock in the SQL', () => {
    expect(
      compiled({ field: 'last_interaction_at', op: 'older_than', n: 90, unit: 'day' }),
    ).toEqual({
      sql: `"m"."last_interaction_at" < ($1::date::timestamp at time zone $2)`,
      parameters: ['2026-06-05', 'Europe/Berlin'],
    })
  })

  it('compares a real date column without a time zone', () => {
    // `next_followup_at` is a `date`, not an instant, so there is nothing to convert.
    expect(compiled({ field: 'next_followup_at', op: 'newer_than', n: 0, unit: 'day' })).toEqual({
      sql: `"m"."next_followup_at" > $1::date`,
      parameters: ['2026-09-03'],
    })
    expect(
      compiled({ field: 'next_followup_at', op: 'between', from: '2026-01-01', to: '2026-01-31' }),
    ).toEqual({
      sql: `"m"."next_followup_at" between $1::date and $2::date`,
      parameters: ['2026-01-01', '2026-01-31'],
    })
  })

  it('offers is empty on the nullable derived dates and nothing else on the counts', () => {
    expect(compiled({ field: 'last_interaction_at', op: 'is_empty' })).toEqual({
      sql: `("m"."last_interaction_at" is null)`,
      parameters: [],
    })
    // A metrics row always has a number, so §5.2's counts deliberately offer no `is empty`.
    expect(issuesOf({ field: 'warmth', op: 'is_empty' })).toEqual(['operator_not_allowed'])
  })

  it('reports which metric table a chip needs joined, and null for everything else', () => {
    const metric = compileFilter({ field: 'warmth', op: 'gt', value: '50' }, ctx)
    const column = compileFilter({ field: 'created_at', op: 'after', value: '2026-01-01' }, ctx)
    const attribute = compileFilter({ field: 'city', op: 'is_empty' }, ctx)
    if (!metric.ok || !column.ok || !attribute.ok) throw new Error('expected all three to compile')
    expect(metricTableOf(metric.value.field)).toBe('contact_metrics')
    expect(metricTableOf(column.value.field)).toBeNull()
    expect(metricTableOf(attribute.value.field)).toBeNull()
  })

  it('resolves organization metrics to the same alias, because only one is ever in scope', () => {
    const organizations: CompileContext = {
      ...ctx,
      objectType: 'organization',
      resolver: makeFieldResolver('organization', []),
    }
    const result = compileFilter({ field: 'people_count', op: 'gt', value: '10' }, organizations)
    if (!result.ok) throw new Error('expected people_count to compile')
    expect(render(result.value.expression)).toEqual({
      sql: `"m"."people_count" > $1::numeric`,
      parameters: ['10'],
    })
    expect(metricTableOf(result.value.field)).toBe('organization_metrics')
  })
})

describe('SYSTEM_COLUMNS', () => {
  it('declares a SQL type for every system field of every object type', () => {
    const missing: string[] = []
    for (const objectType of OBJECT_TYPES as readonly ObjectType[]) {
      for (const field of systemFields(objectType)) {
        const key = `${field.table}.${field.column}`
        if (!(key in SYSTEM_COLUMNS)) missing.push(`${objectType}: ${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('declares every metric column nullable, because the metrics row is LEFT JOINed', () => {
    const metrics = Object.entries(SYSTEM_COLUMNS).filter(([key]) => key.includes('_metrics.'))
    expect(metrics.length).toBeGreaterThan(0)
    for (const [key, declared] of metrics) {
      expect(`${key}: ${String(declared.nullable)}`).toBe(`${key}: true`)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Refusals. Every one of them happens before a character of SQL exists.
// ---------------------------------------------------------------------------------------------

describe('refusals', () => {
  it('refuses an unknown slug rather than building a query around it', () => {
    expect(issuesOf({ field: 'wizard', op: 'is_empty' })).toEqual(['unknown_field'])
  })

  it('refuses an operator the field does not offer', () => {
    expect(issuesOf({ field: 'city', op: 'is_yes' })).toEqual(['operator_not_allowed'])
    expect(issuesOf({ field: 'notes', op: 'equals', value: 'x' })).toEqual(['operator_not_allowed'])
    expect(issuesOf({ field: 'organization', op: 'contains', value: 'x' })).toEqual([
      'operator_not_allowed',
    ])
  })

  it('refuses a value that is not a number', () => {
    expect(issuesOf({ field: 'check_size', op: 'eq', value: 'lots' })).toEqual(['not_a_number'])
    expect(issuesOf({ field: 'warmth', op: 'lt', value: '1e6' })).toEqual(['not_a_number'])
  })

  it('refuses a date that is not a calendar day', () => {
    expect(issuesOf({ field: 'birthday', op: 'before', value: '31/12/1990' })).toEqual(['bad_date'])
    expect(
      issuesOf({ field: 'birthday', op: 'between', from: '1990-02-30', to: '1991-01-01' }),
    ).toEqual(['bad_date'])
  })

  it('refuses an option key the attribute does not have', () => {
    expect(issuesOf({ field: 'job_role', op: 'is_one_of', values: ['wizard'] })).toEqual([
      'unknown_option',
    ])
  })

  it('refuses a relation target that is not a record id', () => {
    expect(issuesOf({ field: 'organization', op: 'has_any_of', values: ['acme'] })).toEqual([
      'invalid_input',
    ])
  })

  it('refuses a range whose start comes after its end', () => {
    expect(issuesOf({ field: 'check_size', op: 'between', from: '9', to: '1' })).toEqual([
      'out_of_range',
    ])
    expect(
      issuesOf({ field: 'birthday', op: 'between', from: '1991-01-01', to: '1990-01-01' }),
    ).toEqual(['out_of_range'])
  })

  it('refuses a relative window nobody could have meant', () => {
    expect(issuesOf({ field: 'birthday', op: 'older_than', n: 10_000_000, unit: 'day' })).toEqual([
      'out_of_range',
    ])
  })

  it('collects every bad chip instead of stopping at the first, and paths them by index', () => {
    const result = compileFilterSet(
      [
        { field: 'city', op: 'is_empty' },
        { field: 'wizard', op: 'is_empty' },
        { field: 'check_size', op: 'eq', value: 'lots' },
      ],
      ctx,
    )
    if (result.ok) throw new Error('expected the set to be refused')
    expect(result.issues.map((one) => one.code)).toEqual(['unknown_field', 'not_a_number'])
    expect(result.issues.map((one) => one.path)).toEqual([
      ['filter', 1, 'field'],
      ['filter', 2, 'field'],
    ])
  })

  it('compiles a clean set in order', () => {
    const result = compileFilterSet(
      [
        { field: 'city', op: 'is_not_empty' },
        { field: 'job_role', op: 'is_one_of', values: ['founder'] },
      ],
      ctx,
    )
    if (!result.ok) throw new Error('expected the set to compile')
    expect(result.value.map((one) => one.field.slug)).toEqual(['city', 'job_role'])
  })
})

// ---------------------------------------------------------------------------------------------
// Quick search (§5.2) and conjunction
// ---------------------------------------------------------------------------------------------

describe('compileSearch', () => {
  it('is one EXISTS over an attribute-id array, never an OR of one EXISTS per column', () => {
    // An OR between semi-joins defeats the sublink pull-up and degrades to a sequential scan.
    const expression = compileSearch('anna', [ATTRIBUTE_ID.short_text, ATTRIBUTE_ID.email])
    if (expression === null) throw new Error('expected a search predicate')
    expect(render(expression)).toEqual({
      sql: `("r"."label_norm" like '%' || mutuals_esc(mutuals_norm($1)) || '%' or exists (select 1 from "attribute_value" as "v" where "v"."record_id" = "r"."id" and "v"."attribute_id" = any($2::uuid[]) and "v"."text_norm" like '%' || mutuals_esc(mutuals_norm($3)) || '%'))`,
      parameters: ['anna', [ATTRIBUTE_ID.short_text, ATTRIBUTE_ID.email], 'anna'],
    })
  })

  it('falls back to the label column alone when no text attribute is visible', () => {
    const expression = compileSearch('anna', [])
    if (expression === null) throw new Error('expected a search predicate')
    expect(render(expression)).toEqual({
      sql: `"r"."label_norm" like '%' || mutuals_esc(mutuals_norm($1)) || '%'`,
      parameters: ['anna'],
    })
  })

  it('is null for blank text, so an empty search box adds no predicate at all', () => {
    expect(compileSearch('', [ATTRIBUTE_ID.short_text])).toBeNull()
    expect(compileSearch('   ', [ATTRIBUTE_ID.short_text])).toBeNull()
  })

  it('binds the needle verbatim and lets SQL normalise it', () => {
    // ADR-019: TypeScript never produces a value compared against a normalised column.
    const expression = compileSearch('  MÜNCH  ', [])
    if (expression === null) throw new Error('expected a search predicate')
    expect(render(expression).parameters).toEqual(['MÜNCH'])
  })
})

describe('conjoin', () => {
  it('is `true` for no chips, so an unfiltered list still has a WHERE', () => {
    expect(render(conjoin([])).sql).toBe('true')
  })

  it('returns the single chip untouched rather than wrapping it', () => {
    const one = compileFilter({ field: 'city', op: 'is_empty' }, ctx)
    if (!one.ok) throw new Error('expected it to compile')
    expect(render(conjoin([one.value.expression])).sql).toBe(render(one.value.expression).sql)
  })

  it('joins chips with AND only (§5.2, ADR-032) and renumbers the parameters', () => {
    const set = compileFilterSet(
      [
        { field: 'city', op: 'contains', value: 'münch' },
        { field: 'check_size', op: 'gt', value: '1000' },
      ],
      ctx,
    )
    if (!set.ok) throw new Error('expected the set to compile')
    const { sql, parameters } = render(conjoin(set.value.map((one) => one.expression)))
    expect(sql).toBe(
      `${inValues(`"v"."text_norm" like '%' || mutuals_esc(mutuals_norm($2)) || '%'`)} and ` +
        `exists (select 1 from "attribute_value" as "v" where "v"."record_id" = "r"."id" and "v"."attribute_id" = $3 and "v"."num_value" > $4::numeric)`,
    )
    expect(parameters).toEqual([ATTRIBUTE_ID.short_text, 'münch', ATTRIBUTE_ID.number, '1000'])
    expect(sql).not.toContain(' or ')
  })
})

// ---------------------------------------------------------------------------------------------
// No user input ever becomes a SQL identifier.
// ---------------------------------------------------------------------------------------------

describe('every user value is a bind parameter', () => {
  it('keeps a needle full of SQL syntax out of the statement', () => {
    const nasty = `x'); drop table record; --`
    const { sql, parameters } = compiled({ field: 'city', op: 'contains', value: nasty })
    expect(sql).not.toContain('drop table')
    expect(parameters).toEqual([ATTRIBUTE_ID.short_text, nasty])
  })

  it('keeps LIKE wildcards literal through mutuals_esc', () => {
    // Without the escape, `100%` would match everything and `a_b` would match `axb`.
    const { parameters } = compiled({ field: 'city', op: 'contains', value: '100%_' })
    expect(parameters).toEqual([ATTRIBUTE_ID.short_text, '100%_'])
  })

  it('emits only the four aliases this file declares, and only quoted identifiers', () => {
    const identifiers = new Set<string>()
    for (const entry of GOLDEN) {
      for (const match of compiled(entry.filter).sql.matchAll(/"([^"]+)"/g)) {
        identifiers.add(match[1] as string)
      }
    }
    expect([...identifiers].sort()).toEqual([
      'attribute_id',
      'attribute_value',
      'bool_value',
      'date_value',
      'from_record_id',
      'id',
      'l',
      'num_value',
      'option_id',
      'r',
      'record_id',
      'record_link',
      'text_norm',
      'text_sort',
      'to_record_id',
      'v',
      'v2',
      'value_key',
    ])
  })
})

// ---------------------------------------------------------------------------------------------
// ADR-033 extends the slot-column grep to packages/db/src/filter/**.
// ---------------------------------------------------------------------------------------------

describe('no hard-coded columns in packages/db/src/filter', () => {
  // CLAUDE.md states this rule in prose. A comment is not a mechanism; this is. The token list is
  // the one `packages/core/src/attributes/slots.test.ts` uses, character for character.
  const BANNED =
    /\b(text_value|text_norm|text_sort|num_value|date_value|bool_value|option_id|target_record_id|value_key)\b/

  const HERE = import.meta.dirname

  /**
   * The compiler's own source. Test files are excluded: a golden test's whole job is to name the
   * SQL the compiler must emit, so it holds the column names by construction — as does
   * `slots.test.ts`, which exempts itself the same way. `packages/db/src/schema.ts`, the
   * migrations and the write path are outside this directory and outside ADR-033's scope; they
   * are where the physical names legitimately live.
   */
  const SOURCES = readdirSync(HERE)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(join(HERE, name), 'utf8') }))

  it('scans the directory it is supposed to be scanning', () => {
    // Without this the grep below would pass vacuously the day a file is renamed. A file added to
    // `filter/` later is picked up automatically, which is the point of reading the directory.
    const names = SOURCES.map((source) => source.name)
    expect(names).toContain('compile.ts')
    expect(names).toContain('sort.ts')
    expect(names).toContain('list.ts')
  })

  it('mentions a physical value column nowhere outside a comment', () => {
    const offenders = SOURCES.flatMap((source) =>
      source.text
        .split('\n')
        .map((text, index) => ({ text, line: index + 1 }))
        // A comment may name a column while explaining why the code does not: what matters is
        // that no *expression* contains one, so every column reaches SQL through `slots.ts`.
        .filter((entry) => !/^\s*(\/\/|\*|\/\*)/.test(entry.text) && BANNED.test(entry.text))
        .map((entry) => `${source.name}:${String(entry.line)}`),
    )
    expect(offenders).toEqual([])
  })
})
