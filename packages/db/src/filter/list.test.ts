/**
 * Golden SQL for the two queries a list page runs (storage-DECISION §5.1).
 *
 * Q1 is narrow on purpose — `(id, sort_key)` and nothing else — so the sort cannot spill
 * `work_mem` however wide the visible columns get. Q3 is a separate `count(*)`, never
 * `count(*) OVER ()`, because a window function with no partition buffers its whole input before
 * emitting a row and `LIMIT 50` would short-circuit nothing (ADR-023). Both are asserted here in
 * full, with no database: `.compile()` is pure.
 *
 * The other property under test is that **a join appears only when something references it**.
 * Fewer base relations means the planner keeps reordering exhaustively for more filter chips
 * before `join_collapse_limit` hands over to the genetic optimiser (§5.4), so an unused
 * `LEFT JOIN contact_metrics` is not cosmetic.
 */
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
  EMPTY_LIST_QUERY,
  civil,
  completeDefinition,
  makeFieldResolver,
  type AttributeDefinition,
  type ListQuery,
} from '@mutuals/core'

import { compileList, type ListPage, type ListPlan, type ListRequest } from './list.ts'

const dialect = {
  createAdapter: () => new PostgresAdapter(),
  createDriver: () => new DummyDriver(),
  createIntrospector: (db: Kysely<never>) => new PostgresIntrospector(db),
  createQueryCompiler: () => new PostgresQueryCompiler(),
}

const db = new Kysely<Record<string, never>>({ dialect })

interface Rendered {
  readonly sql: string
  readonly parameters: readonly unknown[]
}

/**
 * `ListPlan.where` is typed as the `Expression<SqlBool>` a caller composes with; every fragment the
 * builder actually produces is made by the `sql` tag, so it is a `RawBuilder` and carries
 * `compile()`. The guard turns a future change of that into a readable failure.
 */
function render(fragment: RawBuilder<unknown> | Expression<SqlBool>): Rendered {
  const raw = fragment as RawBuilder<unknown>
  if (raw.isRawBuilder !== true) throw new Error('the builder returned a non-raw fragment')
  const compiled = raw.compile(db)
  return { sql: compiled.sql, parameters: compiled.parameters }
}

// ---------------------------------------------------------------------------------------------

const WORKSPACE = '00000000-0000-4000-8000-000000000001'

const ATTRIBUTE_ID = {
  city: 'a0000000-0000-4000-8000-000000000001',
  notes: 'a0000000-0000-4000-8000-000000000002',
  check_size: 'a0000000-0000-4000-8000-000000000003',
  birthday: 'a0000000-0000-4000-8000-000000000004',
} as const

const STAMPS = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }

const define = (slug: keyof typeof ATTRIBUTE_ID, type: string, position: number) =>
  completeDefinition(
    {
      id: ATTRIBUTE_ID[slug],
      objectType: 'contact',
      title: slug,
      slug,
      type,
      config: {},
      isSystem: false,
      position,
      showByDefault: true,
    } as never,
    STAMPS,
  )

const ATTRIBUTES: readonly AttributeDefinition[] = [
  define('city', 'short_text', 1),
  define('notes', 'long_text', 2),
  define('check_size', 'number', 3),
  define('birthday', 'date', 4),
]

const resolver = makeFieldResolver('contact', ATTRIBUTES)

function request(
  query: Partial<ListQuery> = {},
  extra: Partial<Omit<ListRequest, 'query'>> = {},
): ListRequest {
  return {
    objectType: 'contact',
    resolver,
    workspaceId: WORKSPACE,
    query: { ...EMPTY_LIST_QUERY, ...query },
    today: civil('2026-09-03'),
    timeZone: 'Europe/Berlin',
    limit: 50,
    ...extra,
  }
}

function plan(
  query: Partial<ListQuery> = {},
  extra: Partial<Omit<ListRequest, 'query'>> = {},
): ListPlan {
  const result = compileList(request(query, extra))
  if (!result.ok) throw new Error(`compileList failed: ${JSON.stringify(result.issues)}`)
  return result.value
}

function refusal(
  query: Partial<ListQuery> = {},
  extra: Partial<Omit<ListRequest, 'query'>> = {},
): readonly string[] {
  const result = compileList(request(query, extra))
  if (result.ok) throw new Error('expected the request to be refused')
  return result.issues.map((one) => one.code)
}

const CONTACT_FROM = `from "record" as "r" join "contact" as "c" on "c"."id" = "r"."id"`
const METRICS_JOIN = `left join "contact_metrics" as "m" on "m"."contact_id" = "r"."id"`
const SCOPE = `"r"."workspace_id" = $1::uuid and "r"."object_type" = $2`

// ---------------------------------------------------------------------------------------------

describe('the unfiltered list', () => {
  it('selects only the id and the sort key', () => {
    // Roughly 40-byte tuples, so the sort stays in memory whatever the table shows.
    expect(render(plan().rows)).toEqual({
      sql:
        `select "r"."id" as "id", "r"."created_at" as "sort_key" ${CONTACT_FROM} ` +
        `where ${SCOPE} order by "r"."created_at" desc, "r"."id" desc limit $3`,
      parameters: [WORKSPACE, 'contact', 50],
    })
  })

  it('counts with a separate count(*), never a window function', () => {
    expect(render(plan().total)).toEqual({
      sql: `select count(*)::bigint as "total" ${CONTACT_FROM} where ${SCOPE}`,
      parameters: [WORKSPACE, 'contact'],
    })
  })

  it('scopes to the workspace and the object type before anything the user typed', () => {
    // ADR-014 keeps `workspace_id` so multi-tenancy stays a filter rather than a migration.
    for (const query of [render(plan().rows), render(plan().total)]) {
      expect(query.sql).toContain(SCOPE)
      expect(query.parameters.slice(0, 2)).toEqual([WORKSPACE, 'contact'])
    }
  })

  it('joins the subtype and nothing else', () => {
    expect(render(plan().rows).sql).not.toContain('left join')
    expect(render(plan().total).sql).not.toContain('left join')
  })

  it('lists organizations and interactions through the same builder', () => {
    const organizations = compileList({
      ...request(),
      objectType: 'organization',
      resolver: makeFieldResolver('organization', []),
    })
    if (!organizations.ok) throw new Error('expected the organization list to compile')
    expect(render(organizations.value.rows).sql).toContain(
      `from "record" as "r" join "organization" as "o" on "o"."id" = "r"."id"`,
    )

    const interactions = compileList({
      ...request(),
      objectType: 'interaction',
      resolver: makeFieldResolver('interaction', []),
    })
    if (!interactions.ok) throw new Error('expected the interaction list to compile')
    // `interaction` owns no metrics table, so there is nothing that could be joined by accident.
    expect(render(interactions.value.rows).sql).not.toContain('_metrics')
  })
})

describe('filters', () => {
  it('ANDs every chip into both queries, with the same parameters', () => {
    const filtered = plan({
      filter: [
        { field: 'city', op: 'contains', value: 'münch' },
        { field: 'check_size', op: 'gt', value: '1000' },
      ],
    })
    const where =
      `${SCOPE} and exists (select 1 from "attribute_value" as "v" where "v"."record_id" = "r"."id" ` +
      `and "v"."attribute_id" = $3 and "v"."text_norm" like '%' || mutuals_esc(mutuals_norm($4)) || '%') ` +
      `and exists (select 1 from "attribute_value" as "v" where "v"."record_id" = "r"."id" ` +
      `and "v"."attribute_id" = $5 and "v"."num_value" > $6::numeric)`

    expect(render(filtered.total)).toEqual({
      sql: `select count(*)::bigint as "total" ${CONTACT_FROM} where ${where}`,
      parameters: [
        WORKSPACE,
        'contact',
        ATTRIBUTE_ID.city,
        'münch',
        ATTRIBUTE_ID.check_size,
        '1000',
      ],
    })
    expect(render(filtered.rows).sql).toContain(`where ${where}`)
  })

  it('exposes the predicate on its own, so a bulk action can reuse the exact selection', () => {
    const filtered = plan({ filter: [{ field: 'city', op: 'is_empty' }] })
    expect(render(filtered.where).sql).toBe(
      `${SCOPE} and not exists (select 1 from "attribute_value" as "v" ` +
        `where "v"."record_id" = "r"."id" and "v"."attribute_id" = $3)`,
    )
  })

  it('collects a bad chip and a bad sort in one response', () => {
    // One bad URL should produce one 400 naming everything wrong with it, not three round trips.
    expect(
      refusal({
        filter: [
          { field: 'wizard', op: 'is_empty' },
          { field: 'check_size', op: 'eq', value: 'lots' },
        ],
        sort: { field: 'notes', direction: 'asc' },
      }),
    ).toEqual(['unknown_field', 'not_a_number', 'not_sortable'])
  })
})

describe('the metrics join', () => {
  it('is absent from both queries when nothing references a derived column', () => {
    const filtered = plan({ filter: [{ field: 'city', op: 'is_not_empty' }] })
    expect(render(filtered.rows).sql).not.toContain(METRICS_JOIN)
    expect(render(filtered.total).sql).not.toContain(METRICS_JOIN)
  })

  it('appears in both queries when a filter chip reads one', () => {
    const filtered = plan({ filter: [{ field: 'warmth', op: 'gt', value: '50' }] })
    expect(render(filtered.rows).sql).toContain(`${CONTACT_FROM} ${METRICS_JOIN}`)
    expect(render(filtered.total).sql).toContain(`${CONTACT_FROM} ${METRICS_JOIN}`)
  })

  it('appears only in the row query when the sort reads one', () => {
    // The count does not order anything, so joining the metrics row for it would be dead weight.
    const sorted = plan({ sort: { field: 'warmth', direction: 'desc' } })
    expect(render(sorted.rows).sql).toContain(METRICS_JOIN)
    expect(render(sorted.total).sql).not.toContain(METRICS_JOIN)
  })

  it('is a LEFT JOIN, so a contact the nightly sweep has not reached still appears', () => {
    const sorted = plan({ sort: { field: 'last_interaction_at', direction: 'desc' } })
    expect(render(sorted.rows)).toEqual({
      sql:
        `select "r"."id" as "id", "m"."last_interaction_at" as "sort_key" ` +
        `${CONTACT_FROM} ${METRICS_JOIN} where ${SCOPE} ` +
        `order by "m"."last_interaction_at" desc nulls last, "r"."id" desc limit $3`,
      parameters: [WORKSPACE, 'contact', 50],
    })
  })
})

describe('sorting', () => {
  it('selects the sort key as sort_key and joins what it needs', () => {
    const sorted = plan({ sort: { field: 'check_size', direction: 'asc' } })
    // The join is in the FROM clause, so its parameter is numbered before the WHERE clause's.
    expect(render(sorted.rows)).toEqual({
      sql:
        `select "r"."id" as "id", "sv"."num_value" as "sort_key" ${CONTACT_FROM} ` +
        `left join "attribute_value" as "sv" on "sv"."record_id" = "r"."id" ` +
        `and "sv"."attribute_id" = $1 and "sv"."value_key" = '' ` +
        `where "r"."workspace_id" = $2::uuid and "r"."object_type" = $3 ` +
        `order by "sv"."num_value" asc nulls last, "r"."id" asc limit $4`,
      parameters: [ATTRIBUTE_ID.check_size, WORKSPACE, 'contact', 50],
    })
    // The sort join must not reach the count: it would change nothing and cost a scan.
    expect(render(sorted.total).sql).toBe(
      `select count(*)::bigint as "total" ${CONTACT_FROM} where ${SCOPE}`,
    )
  })

  it('refuses a sort on a type §4.2 marks "—" rather than returning insertion order', () => {
    expect(refusal({ sort: { field: 'notes', direction: 'asc' } })).toEqual(['not_sortable'])
  })
})

describe('pagination', () => {
  it('binds the limit rather than splicing it', () => {
    const capped = plan({}, { limit: 25 })
    expect(render(capped.rows).parameters.at(-1)).toBe(25)
    expect(capped.limit).toBe(25)
  })

  it('walks record_list_idx with one row comparison for the default ordering', () => {
    const page: ListPage = {
      mode: 'keyset',
      createdAt: '2026-02-01T10:00:00.000Z',
      id: '9b000000-0000-4000-8000-000000000002',
    }
    const paged = plan({}, { page })
    expect(render(paged.rows)).toEqual({
      sql:
        `select "r"."id" as "id", "r"."created_at" as "sort_key" ${CONTACT_FROM} where ${SCOPE} ` +
        `and ("r"."created_at", "r"."id") < ($3::timestamptz, $4::uuid) ` +
        `order by "r"."created_at" desc, "r"."id" desc limit $5`,
      parameters: [WORKSPACE, 'contact', page.createdAt, page.id, 50],
    })
  })

  it('flips the keyset comparison with the direction', () => {
    const page: ListPage = {
      mode: 'keyset',
      createdAt: '2026-02-01T10:00:00.000Z',
      id: '9b000000-0000-4000-8000-000000000002',
    }
    const ascending = plan({ sort: { field: 'created_at', direction: 'asc' } }, { page })
    expect(render(ascending.rows).sql).toContain(`("r"."created_at", "r"."id") > ($3::timestamptz`)
  })

  it('keeps the keyset predicate out of the count and out of the reusable predicate', () => {
    const page: ListPage = {
      mode: 'keyset',
      createdAt: '2026-02-01T10:00:00.000Z',
      id: '9b000000-0000-4000-8000-000000000002',
    }
    const paged = plan({}, { page })
    // The footer says how many rows match, not how many are left after this page.
    expect(render(paged.total).sql).not.toContain('created_at", "r"."id") <')
    expect(render(paged.where).sql).not.toContain('created_at", "r"."id") <')
  })

  it('pages an ordering that reads its key from a join by offset', () => {
    const paged = plan(
      { sort: { field: 'city', direction: 'asc' } },
      { page: { mode: 'offset', offset: 100 } },
    )
    const rendered = render(paged.rows)
    expect(rendered.sql).toContain('limit $4 offset $5')
    expect(rendered.parameters.slice(-2)).toEqual([50, 100])
    expect(paged.sort.mode).toBe('offset')
  })
})

describe('the quick search box', () => {
  it('scans the record label and every text attribute by default', () => {
    // §5.2's "visible text columns": `text_norm` is the only column the trigram index covers, and
    // "Munich" is not a substring of a number or a date.
    const searched = plan({ q: 'münch' })
    const rendered = render(searched.rows)
    expect(rendered.sql).toContain(
      `and ("r"."label_norm" like '%' || mutuals_esc(mutuals_norm($3)) || '%' or exists ` +
        `(select 1 from "attribute_value" as "v" where "v"."record_id" = "r"."id" ` +
        `and "v"."attribute_id" = any($4::uuid[]) ` +
        `and "v"."text_norm" like '%' || mutuals_esc(mutuals_norm($5)) || '%'))`,
    )
    expect(rendered.parameters).toEqual([
      WORKSPACE,
      'contact',
      'münch',
      [ATTRIBUTE_ID.city, ATTRIBUTE_ID.notes],
      'münch',
      50,
    ])
  })

  it('narrows to the columns the caller says are visible, skipping the ones that are not text', () => {
    // A non-text field is skipped rather than refused: the caller passes the visible columns, and
    // most of them are not text.
    const searched = plan({ q: 'anna' }, { searchFields: ['city', 'check_size', 'display_name'] })
    expect(render(searched.rows).parameters[3]).toEqual([ATTRIBUTE_ID.city])
  })

  it('refuses a column name it cannot resolve', () => {
    expect(refusal({ q: 'anna' }, { searchFields: ['wizard'] })).toEqual(['unknown_field'])
  })

  it('adds no predicate at all when the box is empty', () => {
    expect(render(plan({ q: '   ' }).rows).sql).not.toContain('label_norm')
    expect(render(plan().rows).sql).not.toContain('label_norm')
  })

  it('applies to the count as well, so the footer agrees with the page', () => {
    expect(render(plan({ q: 'anna' }).total).sql).toContain('label_norm')
  })
})

describe('no clock reaches the emitted SQL', () => {
  it('binds a resolved civil date for every relative operator (ADR-040)', () => {
    const relative = plan({
      filter: [
        { field: 'last_interaction_at', op: 'older_than', n: 90, unit: 'day' },
        { field: 'birthday', op: 'in_relative', preset: 'this_year' },
        { field: 'created_at', op: 'in_relative', preset: 'last_30_days' },
      ],
    })
    for (const query of [render(relative.rows), render(relative.total)]) {
      expect(query.sql).not.toContain('now()')
      expect(query.sql).not.toContain('current_date')
      expect(query.sql).not.toContain('interval')
    }
    expect(render(relative.total).parameters).toEqual([
      WORKSPACE,
      'contact',
      '2026-06-05',
      'Europe/Berlin',
      ATTRIBUTE_ID.birthday,
      '2026-01-01',
      '2026-12-31',
      '2026-08-04',
      'Europe/Berlin',
      '2026-09-04',
      'Europe/Berlin',
    ])
  })

  it('compiles the same saved view to different parameters on a different day', () => {
    const view: Partial<ListQuery> = {
      filter: [{ field: 'last_interaction_at', op: 'older_than', n: 90, unit: 'day' }],
    }
    const today = render(plan(view).total)
    const tomorrow = render(plan(view, { today: civil('2026-09-04') }).total)
    expect(today.sql).toBe(tomorrow.sql)
    expect(today.parameters).not.toEqual(tomorrow.parameters)
    expect(tomorrow.parameters[2]).toBe('2026-06-06')
  })
})
