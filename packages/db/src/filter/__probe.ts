import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely'
import {
  civil,
  completeDefinition,
  makeFieldResolver,
  type AttributeDefinition,
  type ObjectType,
} from '@mutuals/core'
import { compileFilter, compileSearch } from './compile.ts'

const db = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (d) => new PostgresIntrospector(d),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
})
const stamps = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
const def = (o: Record<string, unknown>): AttributeDefinition =>
  completeDefinition(
    {
      objectType: 'contact',
      config: {},
      isSystem: false,
      position: 1,
      showByDefault: true,
      ...o,
    } as never,
    stamps,
  )

const attrs = [
  def({
    id: '10000000-0000-4000-8000-000000000001',
    title: 'Notes',
    slug: 'notes',
    type: 'long_text',
  }),
  def({
    id: '10000000-0000-4000-8000-000000000002',
    title: 'Birthday',
    slug: 'birthday',
    type: 'date',
  }),
  def({
    id: '10000000-0000-4000-8000-000000000003',
    title: 'Mentor',
    slug: 'is_mentor',
    type: 'yes_no',
  }),
  def({
    id: '10000000-0000-4000-8000-000000000004',
    title: 'Sectors',
    slug: 'sectors',
    type: 'multi_select',
    options: [
      { id: '20000000-0000-4000-8000-000000000001', key: 'climate', label: 'Climate', position: 0 },
      { id: '20000000-0000-4000-8000-000000000002', key: 'health', label: 'Health', position: 1 },
    ],
  }),
  def({
    id: '10000000-0000-4000-8000-000000000005',
    title: 'Organization',
    slug: 'organization',
    type: 'relation',
    config: { targetObjectType: 'organization', cardinality: 'many', hasLinkMetadata: true },
  }),
  def({ id: '10000000-0000-4000-8000-000000000006', title: 'Email', slug: 'email', type: 'email' }),
]
const resolver = makeFieldResolver('contact', attrs)
const ctx = {
  objectType: 'contact' as ObjectType,
  resolver,
  today: civil('2026-09-03'),
  timeZone: 'Europe/Berlin',
}

const cases = [
  { field: 'notes', op: 'contains', value: 'raising' },
  { field: 'birthday', op: 'before', value: '1990-01-01' },
  { field: 'birthday', op: 'after', value: '1990-01-01' },
  { field: 'birthday', op: 'between', from: '1990-01-01', to: '1991-01-01' },
  { field: 'birthday', op: 'in_relative', preset: 'this_year' },
  { field: 'birthday', op: 'newer_than', n: 1, unit: 'year' },
  { field: 'is_mentor', op: 'is_yes' },
  { field: 'is_mentor', op: 'is_no' },
  { field: 'sectors', op: 'contains_any_of', values: ['climate', 'health'] },
  { field: 'sectors', op: 'contains_all_of', values: ['climate', 'health'] },
  { field: 'organization', op: 'has_any_of', values: ['30000000-0000-4000-8000-000000000001'] },
  { field: 'organization', op: 'is_empty' },
  { field: 'organization', op: 'is_not_empty' },
  { field: 'email', op: 'contains', value: 'ai' },
  { field: 'import_batch_id', op: 'equals', value: '40000000-0000-4000-8000-000000000001' },
  { field: 'import_batch_id', op: 'is_empty' },
  { field: 'created_at', op: 'between', from: '2026-01-01', to: '2026-01-31' },
  { field: 'created_at', op: 'after', value: '2026-01-01' },
  { field: 'created_at', op: 'in_relative', preset: 'last_30_days' },
  { field: 'next_followup_at', op: 'newer_than', n: 0, unit: 'day' },
  { field: 'next_followup_at', op: 'is_empty' },
  { field: 'next_followup_at', op: 'between', from: '2026-01-01', to: '2026-01-31' },
  { field: 'pinned_important', op: 'is_yes' },
  { field: 'first_name', op: 'is_not_empty' },
  { field: 'created_via', op: 'is_one_of', values: ['import', 'manual'] },
  { field: 'created_via', op: 'equals', value: 'manual' },
  { field: 'interaction_count_12m', op: 'between', from: '1', to: '5' },
]
for (const f of cases) {
  const r = compileFilter(f as never, ctx)
  if (!r.ok) {
    console.log('!!', f.field, f.op, JSON.stringify(r.issues))
    continue
  }
  const c = r.value.expression as never as {
    compile: (d: unknown) => { sql: string; parameters: readonly unknown[] }
  }
  const out = c.compile(db)
  console.log(`--- ${f.field} ${f.op}\n ${out.sql}\n ${JSON.stringify(out.parameters)}`)
}
const s = compileSearch('anna', ['10000000-0000-4000-8000-000000000001'])
const sc = (
  s as never as { compile: (d: unknown) => { sql: string; parameters: readonly unknown[] } }
).compile(db)
console.log('--- search\n', sc.sql, '\n', JSON.stringify(sc.parameters))
const s2 = compileSearch('anna', [])
const sc2 = (
  s2 as never as { compile: (d: unknown) => { sql: string; parameters: readonly unknown[] } }
).compile(db)
console.log('--- search no attrs\n', sc2.sql, '\n', JSON.stringify(sc2.parameters))
