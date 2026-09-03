import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import {
  civil,
  completeDefinition,
  makeFieldResolver,
  type AttributeDefinition,
} from '@mutuals/core'
import { compileList } from './list.ts'

const WS = '00000000-0000-4000-8000-000000000001'
const A = '9a000000-0000-4000-8000-000000000001'
const B = '9b000000-0000-4000-8000-000000000002'
const C = '9c000000-0000-4000-8000-000000000003'
const NAMES: Record<string, string> = { [A]: 'A', [B]: 'B', [C]: 'C' }

const pool = new pg.Pool({
  connectionString: 'postgres://mutuals:mutuals@localhost:5432/mutuals_dev',
})
const db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool }) })

const stamps = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
const def = (o: Record<string, unknown>): AttributeDefinition =>
  completeDefinition(
    {
      objectType: 'contact',
      config: {},
      isSystem: true,
      position: 1,
      showByDefault: true,
      ...o,
    } as never,
    stamps,
  )

const attributes = [
  def({
    id: '00000001-0000-4000-8000-000000000005',
    title: 'City',
    slug: 'city',
    type: 'short_text',
    position: 4,
  }),
  def({
    id: '00000001-0000-4000-8000-000000000007',
    title: 'Birthday',
    slug: 'birthday',
    type: 'date',
    position: 6,
  }),
  def({
    id: '00000001-0000-4000-8000-00000000000e',
    title: 'Notes',
    slug: 'notes',
    type: 'long_text',
    position: 13,
  }),
  def({
    id: '00000001-0000-4000-8000-000000000008',
    title: 'Areas',
    slug: 'areas_of_interest',
    type: 'tags',
    position: 7,
  }),
  def({
    id: '00000001-0000-4000-8000-000000000004',
    title: 'Organization',
    slug: 'organization',
    type: 'relation',
    position: 3,
    config: { targetObjectType: 'organization', cardinality: 'many', hasLinkMetadata: true },
  }),
  def({
    id: '00000001-0000-4000-8000-000000000003',
    title: 'Job role',
    slug: 'job_role',
    type: 'single_select',
    position: 2,
    options: [
      { id: '00000003-0000-4000-8000-000000030000', key: 'founder', label: 'Founder', position: 0 },
      {
        id: '00000003-0000-4000-8000-000000030001',
        key: 'investor',
        label: 'Investor',
        position: 1,
      },
    ],
  }),
  def({
    id: '90000001-0000-4000-8000-000000000001',
    title: 'Check size',
    slug: 'check_size',
    type: 'number',
    isSystem: false,
    position: 20,
  }),
  def({
    id: '90000001-0000-4000-8000-000000000002',
    title: 'Mentor',
    slug: 'is_mentor',
    type: 'yes_no',
    isSystem: false,
    position: 21,
  }),
  def({
    id: '90000001-0000-4000-8000-000000000003',
    title: 'Sectors',
    slug: 'sectors',
    type: 'multi_select',
    isSystem: false,
    position: 22,
    options: [
      { id: '90000003-0000-4000-8000-000000000001', key: 'climate', label: 'Climate', position: 0 },
      { id: '90000003-0000-4000-8000-000000000002', key: 'health', label: 'Health', position: 1 },
    ],
  }),
]
const resolver = makeFieldResolver('contact', attributes)

let failures = 0
async function check(
  label: string,
  query: Record<string, unknown>,
  expected: string[],
  ordered = false,
) {
  const plan = compileList({
    objectType: 'contact',
    resolver,
    workspaceId: WS,
    query: {
      filter: [],
      sort: null,
      columns: null,
      q: null,
      view: null,
      limit: null,
      cursor: null,
      ...query,
    } as never,
    today: civil('2026-09-03'),
    timeZone: 'Europe/Berlin',
    limit: 50,
  })
  if (!plan.ok) {
    console.log(`FAIL ${label}: ${JSON.stringify(plan.issues)}`)
    failures++
    return
  }
  const rows = await plan.value.rows.execute(db)
  const total = await plan.value.total.execute(db)
  const seen = rows.rows.map((r) => NAMES[r.id] ?? r.id).filter((n) => n.length === 1)
  const want = ordered ? expected : [...expected].sort()
  const got = ordered ? seen : [...seen].sort()
  const okRows = JSON.stringify(want) === JSON.stringify(got)
  const okTotal = Number(total.rows[0]?.total ?? -1) >= expected.length
  console.log(
    `${okRows && okTotal ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} -> ${got.join(',') || '(none)'}${okRows ? '' : `  expected ${want.join(',')}`}`,
  )
  if (!okRows) failures++
}

async function checkError(label: string, query: Record<string, unknown>, code: string) {
  const plan = compileList({
    objectType: 'contact',
    resolver,
    workspaceId: WS,
    query: {
      filter: [],
      sort: null,
      columns: null,
      q: null,
      view: null,
      limit: null,
      cursor: null,
      ...query,
    } as never,
    today: civil('2026-09-03'),
    timeZone: 'Europe/Berlin',
    limit: 50,
  })
  const got = plan.ok ? 'ok' : plan.issues.map((i) => i.code).join(',')
  console.log(`${got === code ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} -> ${got}`)
  if (got !== code) failures++
}

const f = (...filter: unknown[]) => ({ filter })

await check(
  'city contains MÜNCH (unaccent)',
  f({ field: 'city', op: 'contains', value: 'MÜNCH' }),
  ['A'],
)
await check('city contains munich', f({ field: 'city', op: 'contains', value: 'munich' }), ['B'])
await check('city equals münchen', f({ field: 'city', op: 'equals', value: 'münchen' }), ['A'])
await check('city is empty', f({ field: 'city', op: 'is_empty' }), ['C'])
await check('city is not empty', f({ field: 'city', op: 'is_not_empty' }), ['A', 'B'])
await check(
  'job_role is one of [investor]',
  f({ field: 'job_role', op: 'is_one_of', values: ['investor'] }),
  ['A'],
)
await check(
  'job_role is NOT one of [investor]',
  f({ field: 'job_role', op: 'is_not_one_of', values: ['investor'] }),
  ['B', 'C'],
)
await check(
  'areas contains any of [climate]',
  f({ field: 'areas_of_interest', op: 'contains_any_of', values: ['Climate'] }),
  ['A'],
)
await check(
  'areas contains any of [ai, health]',
  f({ field: 'areas_of_interest', op: 'contains_any_of', values: ['ai', 'HEALTH'] }),
  ['A', 'B'],
)
await check(
  'check_size neq 100 (has a value)',
  f({ field: 'check_size', op: 'neq', value: '100' }),
  ['A'],
)
await check('check_size gt 1000', f({ field: 'check_size', op: 'gt', value: '1000' }), ['A'])
await check(
  'check_size between 50 and 200',
  f({ field: 'check_size', op: 'between', from: '50', to: '200' }),
  ['B'],
)
await check('check_size eq 600000.50', f({ field: 'check_size', op: 'eq', value: '600000.50' }), [
  'A',
])
await check('is_mentor is yes', f({ field: 'is_mentor', op: 'is_yes' }), ['A'])
await check('is_mentor is no', f({ field: 'is_mentor', op: 'is_no' }), ['B'])
await check(
  'sectors contains all of [climate,health]',
  f({ field: 'sectors', op: 'contains_all_of', values: ['climate', 'health'] }),
  ['A'],
)
await check(
  'sectors contains any of [climate]',
  f({ field: 'sectors', op: 'contains_any_of', values: ['climate'] }),
  ['A', 'B'],
)
await check(
  'birthday before 1990-01-01',
  f({ field: 'birthday', op: 'before', value: '1990-01-01' }),
  ['A'],
)
await check(
  'birthday between 1995 and 1996',
  f({ field: 'birthday', op: 'between', from: '1995-01-01', to: '1996-01-01' }),
  ['B'],
)
await check('organization is empty', f({ field: 'organization', op: 'is_empty' }), ['A', 'B', 'C'])
await check(
  'organization has any of [x]',
  f({ field: 'organization', op: 'has_any_of', values: ['30000000-0000-4000-8000-000000000001'] }),
  [],
)
await check('warmth gt 50', f({ field: 'warmth', op: 'gt', value: '50' }), ['A'])
await check(
  'warmth between 10 and 30',
  f({ field: 'warmth', op: 'between', from: '10', to: '30' }),
  ['B'],
)
await check(
  'last_interaction older_than 90 days',
  f({ field: 'last_interaction_at', op: 'older_than', n: 90, unit: 'day' }),
  ['A'],
)
await check(
  'last_interaction newer_than 90 days',
  f({ field: 'last_interaction_at', op: 'newer_than', n: 90, unit: 'day' }),
  ['B'],
)
await check('last_interaction is empty', f({ field: 'last_interaction_at', op: 'is_empty' }), ['C'])
await check('next_followup_at is empty', f({ field: 'next_followup_at', op: 'is_empty' }), [
  'B',
  'C',
])
await check(
  'next_followup_at after today',
  f({ field: 'next_followup_at', op: 'newer_than', n: 0, unit: 'day' }),
  ['A'],
)
await check(
  'display_name contains anna',
  f({ field: 'display_name', op: 'contains', value: 'ANNA' }),
  ['A'],
)
await check(
  'display_name equals bob klein',
  f({ field: 'display_name', op: 'equals', value: 'Bob Klein' }),
  ['B'],
)
await check(
  'created_via is one of [manual]',
  f({ field: 'created_via', op: 'is_one_of', values: ['manual'] }),
  ['A', 'B', 'C'],
)
await check(
  'created_via is not one of [manual]',
  f({ field: 'created_via', op: 'is_not_one_of', values: ['manual'] }),
  [],
)
await check('import_batch_id is empty', f({ field: 'import_batch_id', op: 'is_empty' }), [
  'A',
  'B',
  'C',
])
await check(
  'created_at between Jan and Feb',
  f({ field: 'created_at', op: 'between', from: '2026-01-01', to: '2026-02-01' }),
  ['A', 'B'],
)
await check(
  'two chips: city + job_role',
  f(
    { field: 'city', op: 'is_not_empty' },
    { field: 'job_role', op: 'is_one_of', values: ['founder'] },
  ),
  ['B'],
)
await check('search q=berg', { q: 'berg' }, ['A'])
await check('search q=munch (attribute text)', { q: 'münch' }, ['A'])

await check(
  'sort check_size desc',
  { sort: { field: 'check_size', direction: 'desc' } },
  ['A', 'B', 'C'],
  true,
)
await check(
  'sort check_size asc',
  { sort: { field: 'check_size', direction: 'asc' } },
  ['B', 'A', 'C'],
  true,
)
await check(
  'sort job_role asc (option position)',
  { sort: { field: 'job_role', direction: 'asc' } },
  ['B', 'A', 'C'],
  true,
)
await check(
  'sort is_mentor asc (yes first)',
  { sort: { field: 'is_mentor', direction: 'asc' } },
  ['A', 'B', 'C'],
  true,
)
await check(
  'sort is_mentor desc (no first)',
  { sort: { field: 'is_mentor', direction: 'desc' } },
  ['B', 'A', 'C'],
  true,
)
await check('sort city asc', { sort: { field: 'city', direction: 'asc' } }, ['B', 'A', 'C'], true)
await check(
  'sort display_name asc',
  { sort: { field: 'display_name', direction: 'asc' } },
  ['A', 'B', 'C'],
  true,
)
await check(
  'sort warmth desc (nulls last)',
  { sort: { field: 'warmth', direction: 'desc' } },
  ['A', 'B', 'C'],
  true,
)
await check('sort created_at desc (default keyset)', {}, ['C', 'B', 'A'], true)
await check(
  'sort birthday asc',
  { sort: { field: 'birthday', direction: 'asc' } },
  ['A', 'B', 'C'],
  true,
)

await checkError(
  'sort notes (long_text)',
  { sort: { field: 'notes', direction: 'asc' } },
  'not_sortable',
)
await checkError(
  'sort areas (tags)',
  { sort: { field: 'areas_of_interest', direction: 'asc' } },
  'not_sortable',
)
await checkError(
  'sort organization (relation)',
  { sort: { field: 'organization', direction: 'asc' } },
  'not_sortable',
)
await checkError(
  'sort sectors (multi_select)',
  { sort: { field: 'sectors', direction: 'asc' } },
  'not_sortable',
)
await checkError('unknown slug', f({ field: 'nope', op: 'is_empty' }), 'unknown_field')
await checkError('operator not offered', f({ field: 'city', op: 'is_yes' }), 'operator_not_allowed')
await checkError(
  'not a number',
  f({ field: 'check_size', op: 'eq', value: 'lots' }),
  'not_a_number',
)
await checkError(
  'bad date',
  f({ field: 'birthday', op: 'before', value: '31/12/1990' }),
  'bad_date',
)
await checkError(
  'unknown option',
  f({ field: 'job_role', op: 'is_one_of', values: ['wizard'] }),
  'unknown_option',
)
await checkError(
  'inverted range',
  f({ field: 'check_size', op: 'between', from: '9', to: '1' }),
  'out_of_range',
)

// keyset paging over the default sort
{
  const page1 = compileList({
    objectType: 'contact',
    resolver,
    workspaceId: WS,
    query: {
      filter: [],
      sort: null,
      columns: null,
      q: null,
      view: null,
      limit: null,
      cursor: null,
    },
    today: civil('2026-09-03'),
    timeZone: 'Europe/Berlin',
    limit: 2,
  })
  if (page1.ok) {
    const r1 = await page1.value.rows.execute(db)
    const last = r1.rows[r1.rows.length - 1]
    const page2 = compileList({
      objectType: 'contact',
      resolver,
      workspaceId: WS,
      query: {
        filter: [],
        sort: null,
        columns: null,
        q: null,
        view: null,
        limit: null,
        cursor: null,
      },
      today: civil('2026-09-03'),
      timeZone: 'Europe/Berlin',
      limit: 2,
      page: {
        mode: 'keyset',
        createdAt: new Date(last!.sort_key as string).toISOString(),
        id: last!.id,
      },
    })
    if (page2.ok) {
      const r2 = await page2.value.rows.execute(db)
      const got = [...r1.rows, ...r2.rows]
        .map((r) => NAMES[r.id] ?? r.id)
        .filter((n) => n.length === 1)
      const okp = JSON.stringify(got) === JSON.stringify(['C', 'B', 'A'])
      console.log(
        `${okp ? 'ok  ' : 'FAIL'} keyset paging over the default sort   -> ${got.join(',')}`,
      )
      if (!okp) failures++
    }
  }
}

console.log(failures === 0 ? '\nALL LIVE CHECKS PASSED' : `\n${failures} LIVE CHECKS FAILED`)
await db.destroy()
process.exit(failures === 0 ? 0 : 1)
