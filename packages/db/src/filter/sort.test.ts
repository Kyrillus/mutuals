/**
 * Golden SQL for typed sorting (storage-DECISION §6, §4.2's "Sort" column).
 *
 * Two things are being asserted, and they are the two ways an `ORDER BY` goes wrong.
 *
 * **The key is a native value in a real column**, so `9` sorts before `10` and `1988-03-12` before
 * `1990-01-01` by construction rather than by encoding discipline. Text is the one exception, and
 * it is deliberate: it orders by `lower(…) COLLATE "C"`, the form `contact_name_sort_idx` stores,
 * so the answer does not change when somebody else's machine upgrades glibc.
 *
 * **The types §4.2 marks "—" are refused**, with `not_sortable`, rather than silently demoted to
 * insertion order — §6.5's "explicit refusal, not a silent fallback".
 */
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type RawBuilder,
} from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTE_TYPE_NAMES,
  civil,
  completeDefinition,
  isSortableType,
  makeFieldResolver,
  type AttributeDefinition,
  type AttributeTypeName,
  type SortDirection,
  type SortRequest,
} from '@mutuals/core'

import type { CompileContext } from './compile.ts'
import { defaultSort, resolveSort, type SortPlan } from './sort.ts'

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

function render(fragment: RawBuilder<unknown>): Rendered {
  const compiled = fragment.compile(db)
  return { sql: compiled.sql, parameters: compiled.parameters }
}

// ---------------------------------------------------------------------------------------------
// One attribute per type, so §4.2's Sort column can be walked end to end.
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

/** Only the two types that need more than a bare definition to be constructable. */
const EXTRAS: Partial<Record<AttributeTypeName, Record<string, unknown>>> = {
  single_select: {
    options: [
      { id: 'b0000000-0000-4000-8000-000000000001', key: 'founder', label: 'Founder', position: 0 },
    ],
  },
  multi_select: {
    options: [
      { id: 'b0000000-0000-4000-8000-000000000011', key: 'climate', label: 'Climate', position: 0 },
    ],
  },
  relation: {
    config: { targetObjectType: 'organization', cardinality: 'many', hasLinkMetadata: true },
  },
}

const ATTRIBUTES: readonly AttributeDefinition[] = ATTRIBUTE_TYPE_NAMES.map((type) =>
  define(type, EXTRAS[type] ?? {}),
)

const ctx: CompileContext = {
  objectType: 'contact',
  resolver: makeFieldResolver('contact', ATTRIBUTES),
  today: civil('2026-09-03'),
  timeZone: 'Europe/Berlin',
}

const interactions: CompileContext = {
  ...ctx,
  objectType: 'interaction',
  resolver: makeFieldResolver('interaction', []),
}

function planFor(field: string, direction: SortDirection, context: CompileContext = ctx): SortPlan {
  const sort: SortRequest = { field, direction }
  const result = resolveSort(sort, context)
  if (!result.ok) throw new Error(`sort refused: ${JSON.stringify(result.issues)}`)
  return result.value
}

function refusalFor(field: string, context: CompileContext = ctx): readonly string[] {
  const result = resolveSort({ field, direction: 'asc' }, context)
  if (result.ok) throw new Error(`expected "${field}" to be refused as a sort key`)
  return result.issues.map((one) => one.code)
}

const joinsOf = (plan: SortPlan): readonly Rendered[] => plan.joins.map(render)

// ---------------------------------------------------------------------------------------------
// The joins a custom-attribute sort needs
// ---------------------------------------------------------------------------------------------

const VALUE_JOIN = `left join "attribute_value" as "sv" on "sv"."record_id" = "r"."id" and "sv"."attribute_id" = $1 and "sv"."value_key" = ''`
const OPTION_JOIN = `left join "attribute_option" as "so" on "so"."id" = "sv"."option_id"`

describe('the sort join', () => {
  it('is a plain LEFT JOIN, not a LATERAL, because every sortable type is single-valued', () => {
    // `value_key = ''` plus `av_record_attr_uq` already guarantee at most one row, so a lateral
    // with LIMIT 1 would only take freedom away from the planner for the same answer.
    const [join, ...rest] = joinsOf(planFor('city', 'asc'))
    expect(join).toEqual({ sql: VALUE_JOIN, parameters: [ATTRIBUTE_ID.short_text] })
    expect(rest).toEqual([])
  })

  it('adds the option join only where the key is an option position', () => {
    expect(joinsOf(planFor('job_role', 'asc'))).toEqual([
      { sql: VALUE_JOIN, parameters: [ATTRIBUTE_ID.single_select] },
      { sql: OPTION_JOIN, parameters: [] },
    ])
  })

  it('needs no join at all for a system or derived column', () => {
    expect(joinsOf(planFor('display_name', 'asc'))).toEqual([])
    expect(joinsOf(planFor('warmth', 'desc'))).toEqual([])
    expect(joinsOf(defaultSort())).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// §4.2's Sort column, type by type
// ---------------------------------------------------------------------------------------------

describe('typed ordering, one case per sortable type of §4.2', () => {
  it('short_text and email sort alphabetically on the truncated, byte-ordered column', () => {
    for (const slug of ['city', 'email'] as const) {
      const plan = planFor(slug, 'asc')
      expect(render(plan.key).sql).toBe(`"sv"."text_sort"`)
      expect(render(plan.orderBy).sql).toBe(`"sv"."text_sort" asc nulls last, "r"."id" asc`)
    }
  })

  it('number sorts numerically, so 9 comes before 10 without any zero padding', () => {
    const plan = planFor('check_size', 'desc')
    expect(render(plan.key).sql).toBe(`"sv"."num_value"`)
    expect(render(plan.orderBy).sql).toBe(`"sv"."num_value" desc nulls last, "r"."id" desc`)
  })

  it('date sorts chronologically on the date slot', () => {
    const plan = planFor('birthday', 'asc')
    expect(render(plan.key).sql).toBe(`"sv"."date_value"`)
    expect(render(plan.orderBy).sql).toBe(`"sv"."date_value" asc nulls last, "r"."id" asc`)
  })

  it('yes_no puts yes first when ascending, which means the key direction is inverted', () => {
    // §4.2 asks for "yes first"; `true` sorts after `false`, so an ascending click emits DESC on
    // the key. The tiebreaker keeps the direction the user asked for, so paging stays stable.
    const ascending = planFor('is_mentor', 'asc')
    expect(render(ascending.orderBy).sql).toBe(`"sv"."bool_value" desc nulls last, "r"."id" asc`)
    expect(ascending.direction).toBe('asc')

    const descending = planFor('is_mentor', 'desc')
    expect(render(descending.orderBy).sql).toBe(`"sv"."bool_value" asc nulls last, "r"."id" desc`)
  })

  it('single_select sorts by the option’s own position, never alphabetically', () => {
    const plan = planFor('job_role', 'asc')
    expect(render(plan.key).sql).toBe(`"so"."position"`)
    expect(render(plan.orderBy).sql).toBe(`"so"."position" asc nulls last, "r"."id" asc`)
  })

  it('refuses every type §4.2 marks "—", rather than falling back to insertion order', () => {
    const unsortable = ATTRIBUTE_TYPE_NAMES.filter((type) => !isSortableType(type))
    // long_text, multi_select, tags, url, phone, relation.
    expect(unsortable).toEqual(['long_text', 'multi_select', 'tags', 'url', 'phone', 'relation'])
    for (const type of unsortable) {
      expect(`${type}: ${refusalFor(SLUG[type]).join()}`).toBe(`${type}: not_sortable`)
    }
  })

  it('accepts exactly the types §4.2 gives a sort semantic', () => {
    const sortable = ATTRIBUTE_TYPE_NAMES.filter((type) => isSortableType(type))
    expect(sortable).toEqual(['short_text', 'number', 'date', 'yes_no', 'single_select', 'email'])
    for (const type of sortable) expect(planFor(SLUG[type], 'asc').field?.slug).toBe(SLUG[type])
  })
})

// ---------------------------------------------------------------------------------------------
// System and derived columns
// ---------------------------------------------------------------------------------------------

describe('column ordering', () => {
  it('orders text case-folded and byte-ordered, the way the sort index stores it', () => {
    // Immune to a glibc collation change on the machine somebody else runs this on.
    const plan = planFor('display_name', 'asc')
    expect(render(plan.key).sql).toBe(`lower("c"."display_name") collate "C"`)
    expect(render(plan.orderBy).sql).toBe(
      `lower("c"."display_name") collate "C" asc nulls last, "r"."id" asc`,
    )
  })

  it('casts an enum column to text before folding it', () => {
    const plan = planFor('type', 'asc', interactions)
    expect(render(plan.key).sql).toBe(`lower(("i"."type")::text) collate "C"`)
    // `interaction.type` is NOT NULL, so no NULLS LAST is emitted for it.
    expect(render(plan.orderBy).sql).toBe(`lower(("i"."type")::text) collate "C" asc, "r"."id" asc`)
  })

  it('sinks empty derived values to the bottom in both directions', () => {
    // "Empty always last" keeps the plan shape the same between asc and desc (§6).
    for (const direction of ['asc', 'desc'] as const) {
      const plan = planFor('warmth', direction)
      expect(render(plan.orderBy).sql).toBe(
        `"m"."warmth" ${direction} nulls last, "r"."id" ${direction}`,
      )
    }
    expect(planFor('warmth', 'desc').metricTable).toBe('contact_metrics')
    expect(planFor('last_interaction_at', 'desc').metricTable).toBe('contact_metrics')
  })

  it('omits NULLS LAST where the column cannot be null, so the ordering still matches the index', () => {
    // On `record.created_at` it would buy nothing and would stop the ordering matching
    // `record_list_idx`, which is the one index this design pages through.
    expect(render(planFor('created_at', 'asc').orderBy).sql).toBe(
      `"r"."created_at" asc, "r"."id" asc`,
    )
    expect(planFor('created_at', 'asc').metricTable).toBeNull()
  })

  it('refuses a system column §4.2 does not sort', () => {
    expect(refusalFor('created_via')).toEqual(['not_sortable'])
    expect(refusalFor('import_batch_id')).toEqual(['not_sortable'])
    expect(refusalFor('pinned_important')).toEqual(['not_sortable'])
    expect(refusalFor('body', interactions)).toEqual(['not_sortable'])
  })

  it('refuses an unknown slug before any SQL exists', () => {
    expect(refusalFor('wizard')).toEqual(['unknown_field'])
    const result = resolveSort({ field: 'wizard', direction: 'asc' }, ctx)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.issues[0]?.path).toEqual(['sort'])
  })
})

// ---------------------------------------------------------------------------------------------
// Pagination mode
// ---------------------------------------------------------------------------------------------

describe('the default ordering', () => {
  it('is created_at DESC with the id as the tiebreaker, and pages by keyset', () => {
    const plan = defaultSort()
    expect(render(plan.key).sql).toBe(`"r"."created_at"`)
    expect(render(plan.orderBy).sql).toBe(`"r"."created_at" desc, "r"."id" desc`)
    expect(plan.mode).toBe('keyset')
    expect(plan.field).toBeNull()
  })

  it('is what an absent sort request resolves to', () => {
    const resolved = resolveSort(null, ctx)
    if (!resolved.ok) throw new Error('expected the default sort')
    expect(render(resolved.value.orderBy).sql).toBe(render(defaultSort().orderBy).sql)
    expect(resolved.value.mode).toBe('keyset')
  })

  it('is still a keyset walk when the user asks for created_at by name', () => {
    // Explicitly asking for the default ordering is the default ordering: same index, same walk.
    expect(planFor('created_at', 'desc').mode).toBe('keyset')
    expect(planFor('created_at', 'asc').mode).toBe('keyset')
  })

  it('pages by offset for every ordering that reads its key from a join', () => {
    // Those pay for a sort anyway, so a keyset walk would buy nothing and needs a second cursor
    // shape; both are hidden behind one opaque cursor at the API boundary (ADR-023).
    for (const slug of ['city', 'check_size', 'birthday', 'is_mentor', 'job_role']) {
      expect(`${slug}: ${planFor(slug, 'asc').mode}`).toBe(`${slug}: offset`)
    }
    expect(planFor('display_name', 'asc').mode).toBe('offset')
    expect(planFor('warmth', 'desc').mode).toBe('offset')
    expect(planFor('updated_at', 'desc').mode).toBe('offset')
  })

  it('always ends in the record id, so no two pages can repeat or skip a row', () => {
    for (const slug of ['city', 'check_size', 'job_role', 'display_name', 'warmth', 'created_at']) {
      for (const direction of ['asc', 'desc'] as const) {
        expect(render(planFor(slug, direction).orderBy).sql).toContain(`, "r"."id" ${direction}`)
      }
    }
  })
})
