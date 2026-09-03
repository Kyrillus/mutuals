/**
 * The 10,000-contact × 60-attribute generator behind `pnpm db:check`.
 *
 * R1 in `docs/DECISIONS.md` says it plainly: *every performance number in this design is an
 * extrapolation*, and this generator plus `EXPLAIN (ANALYZE, BUFFERS)` is the named falsifier. So
 * the dataset it produces has to be shaped like real data rather than sized like it — an attribute
 * whose every value is distinct and an attribute with five options exercise completely different
 * halves of the planner, and a filter that matches 95% of rows is not a filter anybody runs.
 *
 * Unlike the demo seed, this one does **not** go through the TypeScript write path: 650,000 facts
 * at five statements each is an hour, and what is being measured is the read side. It writes
 * `fact` in bulk with the projection trigger deferred, then calls `project_record` — the same SQL
 * function the write path calls — once per record. So the projection is still produced by the
 * production projector, and `--verify` re-derives it from the same log to prove it.
 */
import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { AttributeDefinition, Uuid } from '@mutuals/core'

import { createAttributeDefinition, listAttributeDefinitions } from '../repositories/attributes.ts'
import type { DB } from '../schema.ts'
import type { Executor } from '../write/types.ts'
import { WriteError } from '../write/types.ts'
import { resolveWorkspaceId } from '../write/workspace.ts'

/** The prefix every generated attribute carries, so the cleanup can find them all. */
export const PERF_SLUG_PREFIX = 'perf_'

/** The `import_batch.file_name` that marks every generated record. Cleanup keys off it. */
export const PERF_BATCH_NAME = 'db:check 10k generator'

export interface PerfShape {
  readonly slug: string
  readonly title: string
  readonly type: AttributeDefinition['type']
  readonly options?: readonly { key: string; label: string }[]
  /** Fraction of contacts that carry a value at all — `is empty` needs somewhere to be true. */
  readonly fill: number
  /** For multi-valued types: how many elements a contact carries. */
  readonly elements?: number
}

const CITY_POOL = [
  'München',
  'Berlin',
  'Hamburg',
  'Köln',
  'Zürich',
  'Wien',
  'Amsterdam',
  'London',
  'Paris',
  'Stockholm',
  'København',
  'Oslo',
  'Lisboa',
  'Barcelona',
  'Tallinn',
  'New York',
  'San Francisco',
  'Warszawa',
  'Milano',
  'Dublin',
]

const TAG_POOL = [
  'climate tech',
  'fintech',
  'health tech',
  'developer tools',
  'ai',
  'robotics',
  'manufacturing',
  'logistics',
  'marketplaces',
  'open source',
  'hardware',
  'energy',
  'biotech',
  'cybersecurity',
  'design',
  'community building',
  'public policy',
  'education',
  'mobility',
  'insurance',
  'supply chain',
  'commerce',
  'materials',
  'ocean',
  'agritech',
  'payments',
  'legaltech',
  'hr tech',
  'deeptech',
  'space',
]

const SELECT_OPTIONS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] as const
const MULTI_OPTIONS = ['one', 'two', 'three', 'four', 'five', 'six'] as const

function repeat<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => make(index))
}

/**
 * Sixty attributes covering all twelve types.
 *
 * The counts are not arbitrary: a real contact table is mostly text, dates and selects, and it is
 * exactly the text ones that decide whether `av_trgm_idx` and `av_attr_text_idx` earn their keep.
 * `..._sparse` variants are filled on a minority of records so `is empty` has a real answer, and
 * `perf_text_unique` holds a distinct value per contact so the trigram index is measured against
 * high cardinality rather than twenty repeated cities.
 */
export const PERF_SHAPES: readonly PerfShape[] = [
  { slug: 'perf_text_city', title: 'Perf city', type: 'short_text', fill: 1 },
  { slug: 'perf_text_unique', title: 'Perf unique text', type: 'short_text', fill: 1 },
  { slug: 'perf_text_sparse', title: 'Perf sparse text', type: 'short_text', fill: 0.2 },
  ...repeat(11, (i) => ({
    slug: `perf_text_${i}`,
    title: `Perf text ${i}`,
    type: 'short_text' as const,
    fill: 0.85,
  })),
  ...repeat(6, (i) => ({
    slug: `perf_long_${i}`,
    title: `Perf long text ${i}`,
    type: 'long_text' as const,
    fill: 0.6,
  })),
  { slug: 'perf_num_size', title: 'Perf number', type: 'number', fill: 1 },
  ...repeat(7, (i) => ({
    slug: `perf_num_${i}`,
    title: `Perf number ${i}`,
    type: 'number' as const,
    fill: 0.8,
  })),
  { slug: 'perf_date_main', title: 'Perf date', type: 'date', fill: 1 },
  ...repeat(5, (i) => ({
    slug: `perf_date_${i}`,
    title: `Perf date ${i}`,
    type: 'date' as const,
    fill: 0.75,
  })),
  { slug: 'perf_bool_main', title: 'Perf yes/no', type: 'yes_no', fill: 1 },
  ...repeat(3, (i) => ({
    slug: `perf_bool_${i}`,
    title: `Perf yes/no ${i}`,
    type: 'yes_no' as const,
    fill: 0.7,
  })),
  {
    slug: 'perf_select_main',
    title: 'Perf select',
    type: 'single_select',
    fill: 1,
    options: SELECT_OPTIONS.map((key) => ({ key, label: key })),
  },
  ...repeat(4, (i) => ({
    slug: `perf_select_${i}`,
    title: `Perf select ${i}`,
    type: 'single_select' as const,
    fill: 0.8,
    options: SELECT_OPTIONS.map((key) => ({ key, label: key })),
  })),
  {
    slug: 'perf_multi_main',
    title: 'Perf multi-select',
    type: 'multi_select',
    fill: 1,
    elements: 2,
    options: MULTI_OPTIONS.map((key) => ({ key, label: key })),
  },
  ...repeat(3, (i) => ({
    slug: `perf_multi_${i}`,
    title: `Perf multi-select ${i}`,
    type: 'multi_select' as const,
    fill: 0.7,
    elements: 2,
    options: MULTI_OPTIONS.map((key) => ({ key, label: key })),
  })),
  { slug: 'perf_tags_main', title: 'Perf tags', type: 'tags', fill: 1, elements: 3 },
  ...repeat(5, (i) => ({
    slug: `perf_tags_${i}`,
    title: `Perf tags ${i}`,
    type: 'tags' as const,
    fill: 0.7,
    elements: 2,
  })),
  ...repeat(3, (i) => ({
    slug: `perf_url_${i}`,
    title: `Perf url ${i}`,
    type: 'url' as const,
    fill: 0.7,
  })),
  { slug: 'perf_email_main', title: 'Perf email', type: 'email', fill: 1 },
  { slug: 'perf_email_alt', title: 'Perf email alt', type: 'email', fill: 0.5 },
  { slug: 'perf_phone_main', title: 'Perf phone', type: 'phone', fill: 0.7 },
  { slug: 'perf_relation_org', title: 'Perf organization', type: 'relation', fill: 0.8 },
]

if (PERF_SHAPES.length !== 60) {
  throw new Error(`PERF_SHAPES must describe exactly 60 attributes, not ${PERF_SHAPES.length}`)
}

export interface PerfDataset {
  readonly batchId: Uuid
  readonly contacts: number
  readonly attributes: readonly AttributeDefinition[]
  readonly facts: number
  readonly seconds: number
}

export interface PerfOptions {
  readonly contacts: number
  readonly workspaceId?: string | null
  /** Any integer; the generator is a deterministic function of it. */
  readonly seed?: number
  readonly onProgress?: (message: string) => void
}

/**
 * A 32-bit xorshift. Deterministic, dependency-free, and fast enough that generating 650,000 values
 * is not the slow part — `faker` here would be, and none of these values needs to look like a name.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x100000000
  }
}

async function ensurePerfAttributes(
  exec: Executor,
  workspaceId: string,
): Promise<AttributeDefinition[]> {
  const existing = await exec
    .selectFrom('attribute_definition')
    .select(['id', 'slug'])
    .where('object_type', '=', 'contact')
    .where('slug', 'like', `${PERF_SLUG_PREFIX}%`)
    .execute()
  const bySlug = new Map(existing.map((row) => [row.slug, row.id]))

  for (const shape of PERF_SHAPES) {
    if (bySlug.has(shape.slug)) continue
    await createAttributeDefinition(exec, {
      objectType: 'contact',
      title: shape.title,
      slug: shape.slug,
      type: shape.type,
      group: 'Performance harness',
      showByDefault: false,
      workspaceId,
      ...(shape.options === undefined ? {} : { options: [...shape.options] }),
      ...(shape.type === 'relation'
        ? {
            config: { targetObjectType: 'organization', cardinality: 'one', hasLinkMetadata: true },
          }
        : {}),
    })
  }

  const all = await listAttributeDefinitions(exec, 'contact')
  return all.filter((definition) => definition.slug.startsWith(PERF_SLUG_PREFIX))
}

interface FactBuffer {
  recordIds: string[]
  attributeIds: string[]
  valueKinds: string[]
  isMulti: boolean[]
  textValues: (string | null)[]
  numValues: (string | null)[]
  dateValues: (string | null)[]
  boolValues: (boolean | null)[]
  optionIds: (string | null)[]
  targetIds: (string | null)[]
}

function emptyBuffer(): FactBuffer {
  return {
    recordIds: [],
    attributeIds: [],
    valueKinds: [],
    isMulti: [],
    textValues: [],
    numValues: [],
    dateValues: [],
    boolValues: [],
    optionIds: [],
    targetIds: [],
  }
}

function pushFact(
  buffer: FactBuffer,
  recordId: string,
  definition: AttributeDefinition,
  isMulti: boolean,
  slot: {
    text?: string
    num?: string
    date?: string
    bool?: boolean
    option?: string
    target?: string
  },
): void {
  buffer.recordIds.push(recordId)
  buffer.attributeIds.push(definition.id)
  buffer.valueKinds.push(
    slot.text !== undefined
      ? 'text'
      : slot.num !== undefined
        ? 'number'
        : slot.date !== undefined
          ? 'date'
          : slot.bool !== undefined
            ? 'bool'
            : slot.option !== undefined
              ? 'option'
              : 'relation',
  )
  buffer.isMulti.push(isMulti)
  buffer.textValues.push(slot.text ?? null)
  buffer.numValues.push(slot.num ?? null)
  buffer.dateValues.push(slot.date ?? null)
  buffer.boolValues.push(slot.bool ?? null)
  buffer.optionIds.push(slot.option ?? null)
  buffer.targetIds.push(slot.target ?? null)
}

const CHUNK = 400

/**
 * Builds the dataset. Returns once the records are committed, projected and `ANALYZE`d, so the
 * caller can go straight to `EXPLAIN`.
 */
export async function generatePerfDataset(
  db: Kysely<DB>,
  options: PerfOptions,
): Promise<PerfDataset> {
  const startedAt = Date.now()
  const progress = options.onProgress ?? ((): void => {})
  const workspaceId = await resolveWorkspaceId(db, options.workspaceId)
  const random = makeRandom(options.seed ?? 424242)

  const attributes = await ensurePerfAttributes(db, workspaceId)
  const byslug = new Map(attributes.map((definition) => [definition.slug, definition]))
  progress(`${attributes.length} perf attributes ready`)

  const organizations = await db.selectFrom('organization').select('id').limit(200).execute()
  if (organizations.length === 0) {
    throw new WriteError(
      'db:check needs organizations for the relation attribute; run `pnpm seed` first.',
    )
  }

  const batchId = randomUUID()
  await db
    .insertInto('import_batch')
    .values({
      id: batchId,
      workspace_id: workspaceId,
      file_name: PERF_BATCH_NAME,
      object_type: 'contact',
      row_count: options.contacts,
      status: 'completed',
    })
    .execute()

  let facts = 0
  for (let start = 0; start < options.contacts; start += CHUNK) {
    const size = Math.min(CHUNK, options.contacts - start)
    const ids = repeat(size, () => randomUUID())
    const buffer = emptyBuffer()

    ids.forEach((recordId, offset) => {
      const ordinal = start + offset
      for (const shape of PERF_SHAPES) {
        const definition = byslug.get(shape.slug)
        if (definition === undefined) continue
        if (random() > shape.fill) continue
        fillShape(buffer, recordId, definition, shape, ordinal, random, organizations)
      }
    })
    facts += buffer.recordIds.length

    // One transaction per chunk, with the statement-level projection trigger switched off inside
    // it: a 26,000-row `INSERT INTO fact` would otherwise fire the backstop, which projects every
    // record in the batch — the work this loop does explicitly one line later. `SET LOCAL` is
    // exactly right here, because the flag must not outlive the transaction that needs it.
    await db.transaction().execute(async (trx) => {
      await sql`set local mutuals.defer_projection = 'on'`.execute(trx)

      await sql`
        insert into record (id, workspace_id, object_type, created_via, import_batch_id, created_at)
        select t.id, ${workspaceId}::uuid, 'contact', 'import', ${batchId}::uuid,
               now() - ((${start} + t.ord) || ' minutes')::interval
          from unnest(${ids}::uuid[]) with ordinality as t(id, ord)
      `.execute(trx)

      await sql`
        insert into contact (id, first_name, last_name)
        select t.id, 'Perf' || (${start} + t.ord), 'Contact' || (${start} + t.ord)
          from unnest(${ids}::uuid[]) with ordinality as t(id, ord)
      `.execute(trx)

      await sql`
        insert into contact_metrics (contact_id, workspace_id, warmth, interaction_count_12m,
                                     last_interaction_at)
        select t.id, ${workspaceId}::uuid, ((${start} + t.ord) * 7) % 101,
               ((${start} + t.ord) * 3) % 40,
               now() - ((((${start} + t.ord) * 13) % 900) || ' days')::interval
          from unnest(${ids}::uuid[]) with ordinality as t(id, ord)
      `.execute(trx)

      await insertFacts(trx, buffer, workspaceId)

      // The production projector, called exactly as the write path calls it.
      await sql`
        select project_record(t.id, null) from unnest(${ids}::uuid[]) as t(id)
      `.execute(trx)
    })

    if ((start / CHUNK) % 5 === 0) {
      progress(`${start + size}/${options.contacts} contacts, ${facts} facts`)
    }
  }

  progress('analyzing')
  await sql`analyze record, contact, contact_metrics, attribute_value, record_link, fact, identifier, search_document`.execute(
    db,
  )

  return {
    batchId,
    contacts: options.contacts,
    attributes,
    facts,
    seconds: (Date.now() - startedAt) / 1000,
  }
}

function fillShape(
  buffer: FactBuffer,
  recordId: string,
  definition: AttributeDefinition,
  shape: PerfShape,
  ordinal: number,
  random: () => number,
  organizations: readonly { id: string }[],
): void {
  const optionOf = (key: string): string | undefined =>
    definition.options?.find((option) => option.key === key)?.id

  switch (shape.type) {
    case 'short_text':
      pushFact(buffer, recordId, definition, false, {
        text:
          shape.slug === 'perf_text_unique'
            ? `Value ${ordinal} ${CITY_POOL[ordinal % CITY_POOL.length] ?? 'x'}`
            : (CITY_POOL[Math.floor(random() * CITY_POOL.length)] ?? 'München'),
      })
      return
    case 'long_text':
      pushFact(buffer, recordId, definition, false, {
        text: `Contact ${ordinal}. ${TAG_POOL[ordinal % TAG_POOL.length] ?? ''} notes, written for the performance harness so the body has real length and the trigram index has real work.`,
      })
      return
    case 'number':
      pushFact(buffer, recordId, definition, false, {
        num: String(Math.floor(random() * 1_000_000)),
      })
      return
    case 'date':
      pushFact(buffer, recordId, definition, false, {
        date: isoDay(1960 + Math.floor(random() * 60), random),
      })
      return
    case 'yes_no':
      pushFact(buffer, recordId, definition, false, { bool: random() < 0.5 })
      return
    case 'single_select': {
      const key = SELECT_OPTIONS[Math.floor(random() * SELECT_OPTIONS.length)] ?? 'alpha'
      const option = optionOf(key)
      if (option !== undefined) pushFact(buffer, recordId, definition, false, { option })
      return
    }
    case 'multi_select': {
      const used = new Set<string>()
      for (let n = 0; n < (shape.elements ?? 1); n += 1) {
        const key = MULTI_OPTIONS[Math.floor(random() * MULTI_OPTIONS.length)] ?? 'one'
        if (used.has(key)) continue
        used.add(key)
        const option = optionOf(key)
        if (option !== undefined) pushFact(buffer, recordId, definition, true, { option })
      }
      return
    }
    case 'tags': {
      const used = new Set<string>()
      for (let n = 0; n < (shape.elements ?? 1); n += 1) {
        const tag = TAG_POOL[Math.floor(random() * TAG_POOL.length)] ?? 'ai'
        if (used.has(tag)) continue
        used.add(tag)
        pushFact(buffer, recordId, definition, true, { text: tag })
      }
      return
    }
    case 'url':
      pushFact(buffer, recordId, definition, false, {
        text: `https://example-${ordinal % 997}.com/${definition.slug}`,
      })
      return
    case 'email':
      pushFact(buffer, recordId, definition, false, {
        text: `${definition.slug}.${ordinal}@perf.example.com`,
      })
      return
    case 'phone':
      pushFact(buffer, recordId, definition, false, {
        text: `+4915${String(2_000_000 + ordinal).padStart(8, '0')}`,
      })
      return
    case 'relation': {
      const target = organizations[Math.floor(random() * organizations.length)]
      if (target !== undefined) {
        pushFact(buffer, recordId, definition, false, { target: target.id })
      }
      return
    }
    default:
      return
  }
}

function isoDay(year: number, random: () => number): string {
  const month = 1 + Math.floor(random() * 12)
  const day = 1 + Math.floor(random() * 28)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * One `INSERT … SELECT FROM unnest(...)` per chunk, with the projection trigger deferred for the
 * whole transaction. `value_key` is computed **in SQL** (ADR-018/ADR-019): TypeScript never
 * produces a value that is compared against a normalised column, and this column is compared
 * against `mutuals_norm()` output on every write the product makes.
 */
async function insertFacts(exec: Executor, buffer: FactBuffer, workspaceId: string): Promise<void> {
  if (buffer.recordIds.length === 0) return
  await sql`
    insert into fact (id, workspace_id, object_type, record_id, attribute_id, value_kind, is_multi,
                      text_value, num_value, date_value, bool_value, option_id, target_record_id,
                      value_key, valid_from, source, source_ref)
    select gen_random_uuid(), ${workspaceId}::uuid, 'contact', t.record_id, t.attribute_id,
           t.value_kind::value_kind, t.is_multi,
           t.text_value, t.num_value, t.date_value, t.bool_value, t.option_id, t.target_record_id,
           case
             when not t.is_multi then ''
             when t.value_kind = 'text'
               then left(mutuals_norm(t.text_value), 512)
             else coalesce((select o.key from attribute_option o where o.id = t.option_id), '')
           end,
           current_date, 'import', 'db:check'
      from unnest(
             ${buffer.recordIds}::uuid[],
             ${buffer.attributeIds}::uuid[],
             ${buffer.valueKinds}::text[],
             ${buffer.isMulti}::boolean[],
             ${buffer.textValues}::text[],
             ${buffer.numValues}::numeric[],
             ${buffer.dateValues}::date[],
             ${buffer.boolValues}::boolean[],
             ${buffer.optionIds}::uuid[],
             ${buffer.targetIds}::uuid[]
           ) as t(record_id, attribute_id, value_kind, is_multi, text_value, num_value,
                  date_value, bool_value, option_id, target_record_id)
  `.execute(exec)
}

export interface PerfCleanup {
  readonly records: number
  readonly attributes: number
  /** What the tables shrank to once the dead tuples were reclaimed. */
  readonly reclaimed: string
}

/**
 * Four foreign keys with no index behind them.
 *
 * Postgres does not index a referencing column automatically, and every `ON DELETE CASCADE` and
 * `ON DELETE SET NULL` has to find the referencing rows before it can act. These four have nothing
 * to find them with: `fact_live_uq` is partial on `superseded_by_id IS NULL`, so it cannot serve
 * `WHERE superseded_by_id = $1`, and no index anywhere leads with `attribute_value.fact_id`,
 * `record_link.fact_id` or `fact.target_record_id`.
 *
 * The consequence is quadratic: deleting one record deletes its facts, and each deleted fact makes
 * Postgres scan the whole of `fact`, `attribute_value` and `record_link` again. `pnpm db:check`
 * measured it — this is a **finding**, not a workaround, and it is written up in
 * `docs/ARCHITECTURE.md`. The harness creates them for the duration of its own cleanup only,
 * because removing its 650,000 rows without them takes longer than generating them, and drops them
 * again so the schema it leaves behind is exactly the schema the migrations describe.
 */
export const MISSING_FK_INDEXES = [
  ['perf_tmp_fact_superseded_idx', 'fact (superseded_by_id) where superseded_by_id is not null'],
  ['perf_tmp_fact_target_idx', 'fact (target_record_id) where target_record_id is not null'],
  ['perf_tmp_av_fact_idx', 'attribute_value (fact_id)'],
  ['perf_tmp_rl_fact_idx', 'record_link (fact_id)'],
] as const

async function withCascadeIndexes<T>(exec: Executor, run: () => Promise<T>): Promise<T> {
  for (const [name, definition] of MISSING_FK_INDEXES) {
    await sql`${sql.raw(`create index if not exists ${name} on ${definition}`)}`.execute(exec)
  }
  try {
    return await run()
  } finally {
    for (const [name] of MISSING_FK_INDEXES) {
      await sql`${sql.raw(`drop index if exists ${name}`)}`.execute(exec)
    }
  }
}

/**
 * Removes everything the harness created and nothing else: the records carry the batch id, the
 * attributes carry the slug prefix. `record` is the supertype, so one `DELETE` takes the facts,
 * values, links, identifiers, metrics rows and search documents with it.
 */
export async function dropPerfDataset(exec: Executor, batchId?: Uuid): Promise<PerfCleanup> {
  const deleted = await withCascadeIndexes(exec, () => dropPerfDatasetUnaided(exec, batchId))
  return { ...deleted, reclaimed: await reclaimSpace(exec) }
}

/**
 * Deleting 650,000 rows leaves 650,000 dead tuples, and Postgres does not give the space back on
 * its own — measured, `attribute_value` sat at **850 MB for 2,400 live rows** after one run. Every
 * sequential scan the referential-integrity triggers of finding F1 perform then walks all of it, so
 * the next ordinary `pnpm seed` paid ten times over for a harness that had already finished.
 *
 * `VACUUM FULL` takes an ACCESS EXCLUSIVE lock and would be indefensible in production. Here it is
 * the honest thing: this is a developer command, run by hand, that has just deleted its own data
 * and should leave the database as it found it. `PARALLEL 0` because the compose container's
 * default 64 MB `/dev/shm` is too small for a parallel vacuum's shared memory segment.
 */
async function reclaimSpace(exec: Executor): Promise<string> {
  for (const table of ['attribute_value', 'fact', 'search_document', 'record']) {
    await sql`${sql.raw(`vacuum (full, analyze) ${table}`)}`.execute(exec)
  }
  await sql`vacuum (analyze, parallel 0) record_link, identifier, contact, contact_metrics`.execute(
    exec,
  )

  const sizes = await sql<{ total: string }>`
    select pg_size_pretty(sum(pg_total_relation_size(relid))) as total
      from pg_stat_user_tables
     where relname in ('record','contact','attribute_value','fact','record_link','identifier',
                       'search_document','contact_metrics')
  `.execute(exec)
  return sizes.rows[0]?.total ?? 'unknown'
}

async function dropPerfDatasetUnaided(
  exec: Executor,
  batchId?: Uuid,
): Promise<Omit<PerfCleanup, 'reclaimed'>> {
  const batches =
    batchId === undefined
      ? (
          await exec
            .selectFrom('import_batch')
            .select('id')
            .where('file_name', '=', PERF_BATCH_NAME)
            .execute()
        ).map((row) => row.id)
      : [batchId]

  let records = 0
  for (const id of batches) {
    const deleted = await exec
      .deleteFrom('record')
      .where('import_batch_id', '=', id)
      .executeTakeFirst()
    records += Number(deleted.numDeletedRows)
    await exec.deleteFrom('import_batch').where('id', '=', id).execute()
  }

  const attributes = await exec
    .deleteFrom('attribute_definition')
    .where('object_type', '=', 'contact')
    .where('slug', 'like', `${PERF_SLUG_PREFIX}%`)
    .executeTakeFirst()

  return { records, attributes: Number(attributes.numDeletedRows) }
}
