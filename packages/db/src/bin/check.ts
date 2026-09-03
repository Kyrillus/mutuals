#!/usr/bin/env node
/**
 * `pnpm db:check` — Stage 1's definition of done, and the promise `docs/DECISIONS.md` §13 R1 makes:
 *
 * > Every performance number in this design is an extrapolation. … *Falsifier:* Stage 1's
 * > 10,000-contact × 60-attribute generator plus `EXPLAIN (ANALYZE, BUFFERS)` for each of the nine
 * > operator shapes.
 *
 * So this script generates that dataset, runs the **real compiled list query** — `compileList`,
 * the same function the API calls, not SQL written by hand for the occasion — through
 * `EXPLAIN (ANALYZE, BUFFERS)` for every operator shape, and prints what actually happened. A slow
 * honest number is worth more than a fast invented one; nothing here is tuned for the demo.
 *
 * It also checks the two invariants that only become interesting at size:
 *
 * - a full reprojection of 10,000 records reproduces the incremental projection **exactly**
 *   (ADR-025), because that is the entire safety argument for keeping a derived copy;
 * - no row in any table has a NULL `workspace_id` (ADR-014).
 *
 * ```
 * pnpm db:check                     generate, measure, verify, clean up
 * pnpm db:check -- --keep           leave the 10k dataset in place afterwards
 * pnpm db:check -- --contacts=2000  a smaller, faster run
 * pnpm db:check -- --drop           remove a dataset a previous --keep left behind
 * pnpm db:check -- --out=perf.md    also write the markdown table to a file
 * ```
 */
import { writeFileSync } from 'node:fs'
import process from 'node:process'

import pg from 'pg'
import type { CompiledQuery, Kysely } from 'kysely'
import { sql } from 'kysely'
import {
  makeFieldResolver,
  todayIn,
  type AttributeDefinition,
  type FieldResolver,
  type Filter,
  type ListQuery,
  type SortRequest,
} from '@mutuals/core'

import { PLANNER_SETTINGS, makeDb, resolveConnectionString } from '../client.ts'
import { assertSchemaCurrent } from '../migrate.ts'
import { compileList, type ListPlan } from '../filter/list.ts'
import { listAttributeDefinitions } from '../repositories/attributes.ts'
import { verifyProjection } from '../reproject.ts'
import { nullWorkspaceRows } from '../seed/counts.ts'
import { dropPerfDataset, generatePerfDataset } from '../seed/perf.ts'
import { resolveWorkspaceId } from '../write/workspace.ts'
import type { DB } from '../schema.ts'

const green = (text: string): string => `\u001b[32m${text}\u001b[0m`
const red = (text: string): string => `\u001b[31m${text}\u001b[0m`
const yellow = (text: string): string => `\u001b[33m${text}\u001b[0m`
const dim = (text: string): string => `\u001b[2m${text}\u001b[0m`
const bold = (text: string): string => `\u001b[1m${text}\u001b[0m`

const args = process.argv.slice(2)
const flag = (name: string): boolean => args.includes(`--${name}`)
const option = (name: string): string | undefined =>
  args
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=')

const CONTACTS = Number(option('contacts') ?? 10_000)
const TIME_ZONE = process.env.MUTUALS_TIME_ZONE ?? 'Europe/Berlin'
const RUNS = Number(option('runs') ?? 5)

// ---------------------------------------------------------------------------------------------
// EXPLAIN
// ---------------------------------------------------------------------------------------------

interface PlanNode {
  'Node Type': string
  'Index Name'?: string
  'Relation Name'?: string
  'Sort Method'?: string
  'Sort Space Type'?: string
  'Sort Space Used'?: number
  'Sort Key'?: string[]
  'Actual Rows'?: number
  'Shared Hit Blocks'?: number
  'Shared Read Blocks'?: number
  Plans?: PlanNode[]
}

interface TriggerTiming {
  'Trigger Name': string
  'Constraint Name'?: string
  Relation?: string
  Time: number
  Calls: number
}

interface ExplainResult {
  Plan: PlanNode
  Triggers?: TriggerTiming[]
  'Planning Time': number
  'Execution Time': number
}

interface Measurement {
  readonly shape: string
  readonly index: string
  readonly operator: string
  readonly rows: number
  readonly medianMs: number
  readonly planningMs: number
  readonly bufferHits: number
  readonly bufferReads: number
  readonly indexes: readonly string[]
  readonly sortMethod: string | null
  readonly sortKey: string | null
  readonly nullsLast: boolean | null
  /** Empty when the measurement matched expectations. */
  readonly notes: readonly string[]
}

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node)
  for (const child of node.Plans ?? []) walk(child, visit)
}

function summarise(plan: PlanNode): {
  indexes: string[]
  sortMethod: string | null
  sortSpace: string | null
  sortKey: string | null
  hits: number
  reads: number
  seqScans: string[]
} {
  const indexes: string[] = []
  const seqScans: string[] = []
  let sortMethod: string | null = null
  let sortSpace: string | null = null
  let sortKey: string | null = null
  let hits = 0
  let reads = 0

  walk(plan, (node) => {
    if (node['Index Name'] !== undefined) indexes.push(node['Index Name'])
    if (node['Node Type'] === 'Seq Scan' && node['Relation Name'] !== undefined) {
      seqScans.push(node['Relation Name'])
    }
    if (node['Sort Method'] !== undefined) {
      sortMethod = node['Sort Method']
      sortSpace = node['Sort Space Type'] ?? null
      sortKey = (node['Sort Key'] ?? []).join(', ')
    }
    hits += node['Shared Hit Blocks'] ?? 0
    reads += node['Shared Read Blocks'] ?? 0
  })

  return { indexes: [...new Set(indexes)], sortMethod, sortSpace, sortKey, hits, reads, seqScans }
}

async function explain(
  client: pg.Client,
  compiled: CompiledQuery,
  rollback = false,
): Promise<{ result: ExplainResult; summary: ReturnType<typeof summarise> }> {
  // `EXPLAIN ANALYZE` on a DELETE really deletes, so the write shapes run inside a transaction
  // that is thrown away. It is the only way to measure the referential-integrity triggers, and
  // those turned out to be the thing worth measuring.
  if (rollback) await client.query('begin')
  try {
    const rows = await client.query<{ 'QUERY PLAN': ExplainResult[] }>(
      `explain (analyze, buffers, format json) ${compiled.sql}`,
      [...compiled.parameters],
    )
    const result = rows.rows[0]?.['QUERY PLAN'][0]
    if (result === undefined) throw new Error('EXPLAIN returned no plan')
    return { result, summary: summarise(result.Plan) }
  } finally {
    if (rollback) await client.query('rollback')
  }
}

/** The same query, rendered as the text plan a human reads. Only ever run once per shape. */
async function explainText(
  client: pg.Client,
  compiled: CompiledQuery,
  rollback = false,
): Promise<string> {
  if (rollback) await client.query('begin')
  try {
    const rows = await client.query<{ 'QUERY PLAN': string }>(
      `explain (analyze, buffers, verbose, format text) ${compiled.sql}`,
      [...compiled.parameters],
    )
    return rows.rows.map((row) => row['QUERY PLAN']).join('\n')
  } finally {
    if (rollback) await client.query('rollback')
  }
}

/** The referential-integrity triggers that cost more than a millisecond, slowest first. */
function slowTriggers(result: ExplainResult): TriggerTiming[] {
  return [...(result.Triggers ?? [])].filter((one) => one.Time >= 1).sort((a, b) => b.Time - a.Time)
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0)
}

// ---------------------------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------------------------

interface Shape {
  readonly name: string
  /** The `attribute_value` index this operator exists to use (migration 0002's numbering). */
  readonly index: string
  readonly operator: string
  readonly query: Partial<ListQuery>
  /** Measure the count query (Q3) instead of the row query (Q1). */
  readonly count?: boolean
  /** Not a `compileList` query at all — the hydration read of a page of ids. */
  readonly hydration?: boolean
  /** Assert the sort sinks empty values to the bottom in this direction (ADR-078). */
  readonly nullsLast?: boolean
  /** Measure a `DELETE`, inside a transaction that is rolled back. */
  readonly del?: boolean
}

/**
 * A select filter carries the option's stable **key**, not its uuid — `coerceOptionIds` resolves
 * `values` through `findOptionByKey`. This only exists to fail loudly if the harness names a key
 * the generator did not create.
 */
function optionKey(definition: AttributeDefinition, key: string): string {
  const found = (definition.options ?? []).find((one) => one.key === key)
  if (found === undefined) throw new Error(`${definition.slug} has no option "${key}"`)
  return found.key
}

/**
 * Tables where a sequential scan is a finding rather than the right plan.
 *
 * `record` and `contact` are deliberately absent: they hold one row per contact, and hashing ten
 * thousand of them for the subtype join is the *correct* plan — flagging it would produce noise
 * that hides the one case that matters, which is a scan of a table that grows with
 * records × attributes.
 */
const SCAN_SENSITIVE_TABLES = new Set(['attribute_value', 'fact', 'record_link'])

function shapesFor(attributes: readonly AttributeDefinition[]): Shape[] {
  const bySlug = new Map(attributes.map((one) => [one.slug, one]))
  const need = (slug: string): AttributeDefinition => {
    const found = bySlug.get(slug)
    if (found === undefined) throw new Error(`the perf attribute "${slug}" is missing`)
    return found
  }

  const select = need('perf_select_main')
  const multi = need('perf_multi_main')

  const only = (filter: Filter): Partial<ListQuery> => ({ filter: [filter] })

  return [
    {
      name: '1. hydrate one page',
      index: 'av_record_attr_uq',
      operator: 'read 50 records’ values',
      hydration: true,
      query: {},
    },
    {
      name: '2. short_text equals',
      index: 'av_attr_text_idx',
      operator: 'equals',
      query: only({ field: 'perf_text_city', op: 'equals', value: 'München' }),
    },
    {
      name: '3. number between',
      index: 'av_attr_num_idx',
      operator: 'between',
      query: only({ field: 'perf_num_size', op: 'between', from: '100000', to: '140000' }),
    },
    {
      name: '4. date after',
      index: 'av_attr_date_idx',
      operator: 'after',
      query: only({ field: 'perf_date_main', op: 'after', value: '2015-01-01' }),
    },
    {
      name: '5. yes_no is yes',
      index: 'av_attr_bool_idx',
      operator: 'is_yes',
      query: only({ field: 'perf_bool_main', op: 'is_yes' }),
    },
    {
      name: '6. single_select is one of',
      index: 'av_attr_opt_idx',
      operator: 'is_one_of',
      query: only({
        field: 'perf_select_main',
        op: 'is_one_of',
        values: [optionKey(select, 'alpha')],
      }),
    },
    {
      name: '7. tags contains any of',
      index: 'av_attr_key_idx',
      operator: 'contains_any_of',
      query: only({ field: 'perf_tags_main', op: 'contains_any_of', values: ['climate tech'] }),
    },
    {
      name: '8. short_text is empty',
      index: 'av_attr_rec_idx',
      operator: 'is_empty',
      query: only({ field: 'perf_text_sparse', op: 'is_empty' }),
    },
    {
      name: '9. short_text contains',
      index: 'av_trgm_idx',
      operator: 'contains',
      query: only({ field: 'perf_text_unique', op: 'contains', value: 'ünch' }),
    },
    {
      name: '10. multi_select contains all of',
      index: 'av_attr_opt_idx',
      operator: 'contains_all_of',
      query: only({
        field: 'perf_multi_main',
        op: 'contains_all_of',
        values: [optionKey(multi, 'one'), optionKey(multi, 'two')],
      }),
    },
    {
      name: '11. relation has any of',
      index: 'rl_reverse_idx',
      operator: 'has_any_of',
      query: {},
    },
    {
      name: '12. sort by custom text asc',
      index: 'av_attr_text_idx',
      operator: 'ORDER BY … ASC NULLS LAST',
      nullsLast: true,
      query: { sort: { field: 'perf_text_city', direction: 'asc' } satisfies SortRequest },
    },
    {
      name: '13. sort by custom text desc',
      index: 'av_attr_text_idx',
      operator: 'ORDER BY … DESC NULLS LAST',
      nullsLast: true,
      query: { sort: { field: 'perf_text_city', direction: 'desc' } satisfies SortRequest },
    },
    {
      name: '14. sort by warmth desc',
      index: 'cm_warm_idx',
      operator: 'ORDER BY warmth DESC',
      query: { sort: { field: 'warmth', direction: 'desc' } satisfies SortRequest },
    },
    {
      name: '15. three chips + sort',
      index: 'several',
      operator: 'is_one_of AND equals AND contains_any_of',
      query: {
        filter: [
          { field: 'perf_select_main', op: 'is_one_of', values: [optionKey(select, 'alpha')] },
          { field: 'perf_text_city', op: 'equals', value: 'München' },
          { field: 'perf_tags_main', op: 'contains_any_of', values: ['climate tech', 'ai'] },
        ],
        sort: { field: 'perf_num_size', direction: 'desc' },
      },
    },
    {
      name: '16. three chips, row count',
      index: 'several',
      operator: 'count(*) over the same predicate',
      count: true,
      query: {
        filter: [
          { field: 'perf_select_main', op: 'is_one_of', values: [optionKey(select, 'alpha')] },
          { field: 'perf_text_city', op: 'equals', value: 'München' },
          { field: 'perf_tags_main', op: 'contains_any_of', values: ['climate tech', 'ai'] },
        ],
      },
    },
    {
      name: '17. quick search box',
      index: 'av_trgm_idx',
      operator: 'q= across text columns',
      query: { q: 'ünch', columns: ['perf_text_city', 'perf_text_unique'] },
    },
    {
      name: '18. delete one contact',
      index: 'record_pkey',
      operator: 'DELETE FROM record (§5.4, §6.8)',
      del: true,
      query: {},
    },
  ]
}

// ---------------------------------------------------------------------------------------------

const databaseName = new URL(resolveConnectionString()).pathname.replace(/^\//, '')
const db = makeDb({ applicationName: 'mutuals-check', max: 4 })

/** ADR-078: the perf session is one connection, so the planner GUCs cannot bind to another. */
const explainClient = new pg.Client({
  connectionString: resolveConnectionString(),
  application_name: 'mutuals-check-explain',
  options: Object.entries(PLANNER_SETTINGS)
    .map(([name, value]) => `-c ${name}=${value}`)
    .join(' '),
})

function planFor(
  objectType: 'contact',
  resolver: FieldResolver,
  workspaceId: string,
  query: Partial<ListQuery>,
): ListPlan {
  const compiled = compileList({
    objectType,
    resolver,
    workspaceId,
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
    today: todayIn(TIME_ZONE, new Date()),
    timeZone: TIME_ZONE,
    limit: 50,
    ...(query.columns == null ? {} : { searchFields: query.columns }),
  })
  if (!compiled.ok) {
    throw new Error(`compileList refused the shape: ${JSON.stringify(compiled.issues)}`)
  }
  return compiled.value
}

/** Shape 11 and shape 1 are not list filters, so they are compiled by hand from the real reads. */
async function specialQuery(
  shape: Shape,
  db2: Kysely<DB>,
  attributes: readonly AttributeDefinition[],
  workspaceId: string,
): Promise<CompiledQuery | null> {
  if (shape.hydration) {
    const page = await db2
      .selectFrom('record')
      .select('id')
      .where('object_type', '=', 'contact')
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute()
    const ids = page.map((row) => row.id)
    // Exactly `valuesByRecord` in repositories/records.ts — the second half of the read path.
    return sql`
      select v.record_id, v.attribute_id, v.value_kind, v.value_key, v.position, v.fact_id,
             v.text_value, v.num_value, v.date_value, v.bool_value, v.option_id,
             o.key as option_key, o.label as option_label
        from attribute_value v
        left join attribute_option o on o.id = v.option_id
       where v.record_id = any(${ids}::uuid[])
       order by v.attribute_id, v.position
    `.compile(db2)
  }

  if (shape.del === true) {
    const victim = await db2
      .selectFrom('record')
      .select('id')
      .where('object_type', '=', 'contact')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst()
    if (victim === undefined) return null
    // §5.4's "This will delete 3 contacts and 12 interactions", and §6.8's re-import after a
    // delete. `record` is the supertype, so this one statement is the whole deletion (ADR-015).
    return sql`delete from record where id = ${victim.id}::uuid`.compile(db2)
  }

  if (shape.index === 'rl_reverse_idx') {
    const relation = attributes.find((one) => one.slug === 'perf_relation_org')
    if (relation === undefined) return null
    const targets = await db2.selectFrom('organization').select('id').limit(3).execute()
    const resolver = makeFieldResolver('contact', attributes)
    return planFor('contact', resolver, workspaceId, {
      filter: [
        { field: 'perf_relation_org', op: 'has_any_of', values: targets.map((row) => row.id) },
      ],
    }).rows.compile(db2)
  }

  return null
}

const startedAt = Date.now()
let exitCode = 0

try {
  await assertSchemaCurrent(db)
  await explainClient.connect()

  const workspaceId = await resolveWorkspaceId(db, null)
  console.log(dim(`database: ${databaseName}   contacts: ${CONTACTS}   runs per shape: ${RUNS}`))

  if (flag('drop')) {
    const dropped = await dropPerfDataset(db)
    console.log(
      `${green('✓')} removed ${dropped.records} generated records and ${dropped.attributes} perf ` +
        `attributes; reclaimed down to ${dropped.reclaimed}`,
    )
    process.exit(0)
  }

  // --- 1. Generate ---------------------------------------------------------------------------
  console.log(`\n${bold('Generating')} ${CONTACTS} contacts × 60 attributes`)
  const dataset = await generatePerfDataset(db, {
    contacts: CONTACTS,
    workspaceId,
    onProgress: (message) => console.log(`    ${dim(message)}`),
  })
  console.log(
    `${green('✓')} ${dataset.contacts} contacts, ${dataset.facts} facts in ${dataset.seconds.toFixed(1)}s`,
  )

  const sizes = await sql<{ table_name: string; rows: string; size: string }>`
    select relname as table_name, n_live_tup::text as rows,
           pg_size_pretty(pg_total_relation_size(relid)) as size
      from pg_stat_user_tables
     where relname in ('record','contact','attribute_value','fact','record_link','identifier',
                       'search_document','contact_metrics')
     order by pg_total_relation_size(relid) desc
  `.execute(db)
  console.log('')
  for (const row of sizes.rows) {
    console.log(`    ${row.table_name.padEnd(18)} ${row.rows.padStart(9)} rows   ${row.size}`)
  }

  const settings = await explainClient.query<{
    name: string
    setting: string
    unit: string | null
  }>(
    `select name, setting, unit from pg_settings
      where name in ('work_mem','shared_buffers','effective_cache_size','random_page_cost',
                     'max_parallel_workers_per_gather','join_collapse_limit')`,
  )
  console.log('')
  console.log(
    dim(
      `    planner: ${settings.rows.map((row) => `${row.name}=${row.setting}${row.unit ?? ''}`).join('  ')}`,
    ),
  )

  // --- 2. Measure ----------------------------------------------------------------------------
  const attributes = await listAttributeDefinitions(db, 'contact')
  const resolver = makeFieldResolver('contact', attributes)
  const shapes = shapesFor(attributes)
  const measurements: Measurement[] = []
  const textPlans: string[] = []

  console.log(`\n${bold('EXPLAIN (ANALYZE, BUFFERS)')}`)
  for (const shape of shapes) {
    const special = await specialQuery(shape, db, attributes, workspaceId)
    const compiled =
      special ??
      (shape.count === true
        ? planFor('contact', resolver, workspaceId, shape.query).total.compile(db)
        : planFor('contact', resolver, workspaceId, shape.query).rows.compile(db))

    const timings: number[] = []
    let last: Awaited<ReturnType<typeof explain>> | null = null
    for (let run = 0; run < RUNS; run += 1) {
      last = await explain(explainClient, compiled, shape.del === true)
      timings.push(last.result['Execution Time'])
    }
    if (last === null) continue

    const notes: string[] = []
    const expected = shape.index
    if (expected !== 'several' && !last.summary.indexes.includes(expected)) {
      notes.push(`expected ${expected}, used ${last.summary.indexes.join(', ') || 'no index'}`)
    }
    for (const relation of last.summary.seqScans) {
      // A seq scan of `attribute_option` (thirty rows) is the right plan; one of `attribute_value`
      // at 650,000 rows is the failure this whole storage design exists to avoid.
      if (SCAN_SENSITIVE_TABLES.has(relation)) notes.push(`sequential scan on ${relation}`)
    }
    if (last.summary.sortSpace === 'Disk') notes.push('the sort spilled to disk')
    for (const trigger of slowTriggers(last.result)) {
      notes.push(
        `${trigger['Constraint Name'] ?? trigger['Trigger Name']} cost ${trigger.Time.toFixed(1)} ms`,
      )
    }

    // EXPLAIN prints a NULLS clause only when it differs from Postgres's own default, which is
    // NULLS LAST for ASC and NULLS FIRST for DESC. So "no clause" means NULLS LAST ascending and
    // NULLS FIRST descending, and only the descending case has to say it out loud.
    const sortKey = last.summary.sortKey
    const nullsLast =
      sortKey === null
        ? null
        : /desc/i.test(sortKey)
          ? /NULLS LAST/i.test(sortKey)
          : !/NULLS FIRST/i.test(sortKey)
    if (shape.nullsLast === true && nullsLast !== true) {
      notes.push(`the ORDER BY is not NULLS LAST: ${sortKey ?? 'no sort node'}`)
    }

    measurements.push({
      shape: shape.name,
      index: expected,
      operator: shape.operator,
      rows: last.result.Plan['Actual Rows'] ?? 0,
      medianMs: median(timings),
      planningMs: last.result['Planning Time'],
      bufferHits: last.summary.hits,
      bufferReads: last.summary.reads,
      indexes: last.summary.indexes,
      sortMethod: last.summary.sortMethod,
      sortKey: last.summary.sortKey,
      nullsLast,
      notes,
    })

    if (option('out') !== undefined) {
      textPlans.push(
        `### ${shape.name}\n\n${compiled.sql}\n\n` +
          (await explainText(explainClient, compiled, shape.del === true)),
      )
    }

    const mark = notes.length === 0 ? green('✓') : yellow('!')
    console.log(
      `  ${mark} ${shape.name.padEnd(34)} ${median(timings).toFixed(2).padStart(8)} ms  ` +
        dim(last.summary.indexes.join(', ') || 'no index'),
    )
    for (const note of notes) console.log(`      ${yellow(note)}`)
  }

  // --- 3. The two invariants -------------------------------------------------------------------
  console.log(`\n${bold('Invariants')}`)

  const reprojectStarted = Date.now()
  const equivalence = await verifyProjection(db)
  const reprojectSeconds = (Date.now() - reprojectStarted) / 1000
  if (equivalence.ok) {
    console.log(
      `  ${green('✓')} reprojection is byte-identical for ` +
        `${Object.keys(equivalence.after).length} records (${reprojectSeconds.toFixed(1)}s)`,
    )
  } else {
    exitCode = 1
    console.log(`  ${red('✗')} ${equivalence.diverged.length} record(s) differ after a rebuild:`)
    for (const id of equivalence.diverged.slice(0, 10)) console.log(`      ${id}`)
  }

  const nulls = await nullWorkspaceRows(db)
  if (Object.keys(nulls).length === 0) {
    console.log(`  ${green('✓')} no row anywhere has a NULL workspace_id (ADR-014)`)
  } else {
    exitCode = 1
    for (const [table, n] of Object.entries(nulls)) {
      console.log(`  ${red('✗')} ${table}: ${n} row(s) with a NULL workspace_id`)
    }
  }

  // --- 4. The table ----------------------------------------------------------------------------
  const markdown = renderMarkdown(measurements, {
    contacts: dataset.contacts,
    facts: dataset.facts,
    reprojectSeconds,
    settings: settings.rows.map((row) => `${row.name}=${row.setting}${row.unit ?? ''}`),
  })
  console.log(`\n${markdown}`)

  const out = option('out')
  if (out !== undefined) {
    writeFileSync(out, markdown)
    writeFileSync(`${out}.plans.txt`, textPlans.join('\n\n'))
    console.log(dim(`written to ${out} and ${out}.plans.txt`))
  }

  // --- 5. Clean up -----------------------------------------------------------------------------
  if (flag('keep')) {
    console.log(
      `\n${yellow('!')} --keep: ${dataset.contacts} generated contacts are still in ${databaseName}.` +
        ` Remove them with: pnpm db:check -- --drop`,
    )
  } else {
    const dropped = await dropPerfDataset(db, dataset.batchId)
    console.log(
      `\n${green('✓')} removed ${dropped.records} generated records and ${dropped.attributes} perf ` +
        `attributes; reclaimed down to ${dropped.reclaimed}`,
    )
  }

  console.log(dim(`\ntotal ${((Date.now() - startedAt) / 1000).toFixed(1)}s`))
} catch (error) {
  console.error(`\n${red('✗')} db:check failed.`)
  console.error(error)
  exitCode = 1
} finally {
  await explainClient.end().catch(() => undefined)
  await db.destroy()
  process.exitCode = exitCode
}

function renderMarkdown(
  measurements: readonly Measurement[],
  context: {
    contacts: number
    facts: number
    reprojectSeconds: number
    settings: readonly string[]
  },
): string {
  const lines: string[] = []
  lines.push(
    `<!-- generated by \`pnpm db:check\` on ${new Date().toISOString().slice(0, 10)}; ` +
      `${context.contacts} contacts, ${context.facts} facts -->`,
  )
  lines.push('')
  lines.push(
    `| # | Operator | Index it should use | Index it used | Rows | Median | Planning | Buffers (hit/read) |`,
  )
  lines.push(
    `| - | -------- | ------------------- | ------------- | ---: | -----: | -------: | ------------------ |`,
  )
  for (const row of measurements) {
    const used = row.indexes.length === 0 ? '—' : row.indexes.join(', ')
    lines.push(
      `| ${row.shape.replace(/^\d+\.\s*/, '')} | \`${row.operator}\` | \`${row.index}\` | ` +
        `${used === '—' ? '—' : `\`${used}\``} | ${row.rows} | ${row.medianMs.toFixed(2)} ms | ` +
        `${row.planningMs.toFixed(2)} ms | ${row.bufferHits}/${row.bufferReads} |`,
    )
  }
  lines.push('')
  const problems = measurements.filter((row) => row.notes.length > 0)
  if (problems.length === 0) {
    lines.push('Every shape used the index it was designed for, and no sort spilled to disk.')
  } else {
    lines.push('Shapes that did **not** behave as designed:')
    lines.push('')
    for (const row of problems) {
      lines.push(`- **${row.shape}** — ${row.notes.join('; ')}`)
    }
  }
  lines.push('')
  lines.push(
    `Reprojecting all ${context.contacts.toLocaleString('en-US')}+ records from the fact log took ` +
      `${context.reprojectSeconds.toFixed(1)}s and reproduced the incremental projection exactly.`,
  )
  lines.push('')
  lines.push(`Planner settings during the run: \`${context.settings.join('`, `')}\`.`)
  return lines.join('\n')
}
