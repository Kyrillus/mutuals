/**
 * The drift test that makes a hand-maintained `DB` interface acceptable (ADR-027).
 *
 * `schema.ts` is written by a person, so the honest claim is not "drift is impossible" but "drift
 * fails a test". This is that test: it reads `information_schema` from the migrated database and
 * asserts, table by table and column by column, that the declaration the compiler reads is the one
 * Postgres actually has — physical type, nullability, whether there is a default, and whether the
 * column is generated.
 *
 * The two things a weaker version of this test would miss are both covered on purpose. A column
 * added by a migration and forgotten in `schema.ts` fails, because table and column sets are
 * compared in *both* directions. And a `text` column whose values are closed by a `CHECK` rather
 * than by an enum — `interaction.type`, `interaction.source`, `identifier.kind` — is compared
 * against `pg_get_constraintdef`, because those literal lists are the type Kysely hands the caller.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { testDb } from './test-support/index.ts'
import {
  INTERACTION_SOURCES,
  INTERACTION_TYPES,
  PG_ENUMS,
  SCHEMA,
  type Column,
  type TableName,
} from './schema.ts'

interface ActualColumn {
  readonly udt: string
  readonly nullable: boolean
  readonly has_default: boolean
  readonly generated: boolean
}

type ActualSchema = Map<string, Map<string, ActualColumn>>

/** What `schema.ts` says about one column, in the shape `information_schema` reports. */
function declared(column: Column<unknown>): ActualColumn {
  return {
    udt: column.udt,
    nullable: column.nullable,
    has_default: column.has_default,
    generated: column.generated,
  }
}

let actual: ActualSchema
let checkConstraints: { table: string; def: string }[]

beforeAll(async () => {
  const columns = await sql<{
    table_name: string
    column_name: string
    udt_name: string
    is_nullable: 'YES' | 'NO'
    has_default: boolean
    is_generated: string
  }>`
    select c.table_name, c.column_name, c.udt_name, c.is_nullable,
           c.column_default is not null as has_default, c.is_generated
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
     order by c.table_name, c.ordinal_position
  `.execute(testDb())

  actual = new Map()
  for (const row of columns.rows) {
    const table = actual.get(row.table_name) ?? new Map<string, ActualColumn>()
    table.set(row.column_name, {
      udt: row.udt_name,
      nullable: row.is_nullable === 'YES',
      has_default: row.has_default,
      generated: row.is_generated === 'ALWAYS',
    })
    actual.set(row.table_name, table)
  }

  const constraints = await sql<{ table_name: string; def: string }>`
    select rel.relname as table_name, pg_get_constraintdef(con.oid) as def
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public' and con.contype = 'c'
  `.execute(testDb())
  checkConstraints = constraints.rows.map((row) => ({ table: row.table_name, def: row.def }))
})

const tableNames = Object.keys(SCHEMA) as TableName[]

describe('the Kysely interface and the migrated database', () => {
  it('declare the same tables', () => {
    expect([...actual.keys()].sort()).toEqual([...tableNames].sort())
  })

  describe.each(tableNames)('%s', (table) => {
    it('declares the same columns', () => {
      const declaredColumns = Object.keys(SCHEMA[table]).sort()
      expect([...(actual.get(table)?.keys() ?? [])].sort()).toEqual(declaredColumns)
    })

    it('declares the same type, nullability, default and generation for each', () => {
      const columns = SCHEMA[table] as Record<string, Column<unknown>>
      const expected = Object.fromEntries(
        Object.entries(columns).map(([name, column]) => [name, declared(column)]),
      )
      expect(Object.fromEntries(actual.get(table) ?? [])).toEqual(expected)
    })
  })
})

/**
 * `CHECK (x IN ('a','b'))` is stored as `CHECK ((x = ANY (ARRAY['a'::text, 'b'::text])))`, so the
 * labels are read back out of the rendered definition in the order Postgres holds them.
 */
function closedSetOf(table: string, column: string): string[] | undefined {
  const prefix = `CHECK ((${column} = ANY (ARRAY[`
  const def = checkConstraints.find((row) => row.table === table && row.def.startsWith(prefix))?.def
  if (def === undefined) return undefined
  return [...def.matchAll(/'((?:[^']|'')*)'::text/g)].map((match) =>
    (match[1] ?? '').replaceAll("''", "'"),
  )
}

describe('the closed sets', () => {
  it('are the CHECK constraint on interaction.type', () => {
    expect(closedSetOf('interaction', 'type')).toEqual([...INTERACTION_TYPES])
  })

  it('are the CHECK constraint on interaction.source', () => {
    expect(closedSetOf('interaction', 'source')).toEqual([...INTERACTION_SOURCES])
  })

  it('are the CHECK constraint on identifier.kind', () => {
    expect(closedSetOf('identifier', 'kind')).toEqual([...(SCHEMA.identifier.kind.values ?? [])])
  })

  // Every other `oneOf` column too, so adding one to `schema.ts` without a constraint — or a label
  // to a constraint without the type — is caught without anyone remembering to extend this file.
  it('match every column declared with a value list', () => {
    const declaredSets: Record<string, readonly string[]> = {}
    const actualSets: Record<string, readonly string[] | undefined> = {}

    for (const table of tableNames) {
      for (const [name, column] of Object.entries(
        SCHEMA[table] as Record<string, Column<unknown>>,
      )) {
        if (column.values === undefined) continue
        declaredSets[`${table}.${name}`] = column.values
        actualSets[`${table}.${name}`] = closedSetOf(table, name)
      }
    }

    expect(Object.keys(declaredSets).length).toBeGreaterThan(0)
    expect(actualSets).toEqual(declaredSets)
  })
})

describe('the enum types', () => {
  it('have the labels PG_ENUMS declares, in declaration order', async () => {
    const rows = await sql<{ typname: string; enumlabel: string }>`
      select t.typname, e.enumlabel
        from pg_type t
        join pg_enum e on e.enumtypid = t.oid
        join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public'
       order by t.typname, e.enumsortorder
    `.execute(testDb())

    const byType: Record<string, string[]> = {}
    for (const row of rows.rows) (byType[row.typname] ??= []).push(row.enumlabel)

    expect(byType).toEqual(
      Object.fromEntries(Object.entries(PG_ENUMS).map(([name, labels]) => [name, [...labels]])),
    )
  })
})
