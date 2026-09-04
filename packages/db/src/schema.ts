/**
 * The Kysely database interface (ADR-027), snake_case end to end.
 *
 * It is declared once, as data, and the `DB` type is derived from it. The alternative — a
 * hand-written `interface DB` plus a second hand-written table for the drift test to compare
 * against — has two declarations of the same fact, and only one of them is checked. Here the
 * declaration the drift test reads (`SCHEMA`) and the declaration the compiler reads (`DB`) are
 * the same object, so `schema.db.test.ts` proves something about the types the query builder
 * actually uses.
 *
 * `information_schema` is the arbiter of every field below: `udt` is `udt_name`, `nullable` is
 * `is_nullable`, `has_default` is `column_default IS NOT NULL`, `generated` is
 * `is_generated = 'ALWAYS'`.
 */

import type { ColumnType } from 'kysely'

// ---------------------------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------------------------

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export const OBJECT_TYPES = ['contact', 'organization', 'interaction'] as const
export type ObjectType = (typeof OBJECT_TYPES)[number]

export const ATTRIBUTE_TYPES = [
  'short_text',
  'long_text',
  'number',
  'date',
  'yes_no',
  'single_select',
  'multi_select',
  'tags',
  'url',
  'email',
  'phone',
  'relation',
] as const
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number]

export const VALUE_KINDS = ['text', 'number', 'date', 'bool', 'option', 'relation'] as const
export type ValueKind = (typeof VALUE_KINDS)[number]

export const FACT_SOURCES = [
  'manual',
  'import',
  'quick_capture',
  'agent',
  'gmail',
  'calendar',
  'crawler',
] as const
export type FactSource = (typeof FACT_SOURCES)[number]

export const CREATED_VIA = ['manual', 'import', 'api', 'agent'] as const
export type CreatedVia = (typeof CREATED_VIA)[number]

/** Every Postgres enum the migrations create, and its labels in declaration order. */
export const PG_ENUMS = {
  object_type: OBJECT_TYPES,
  attribute_type: ATTRIBUTE_TYPES,
  value_kind: VALUE_KINDS,
  fact_source: FACT_SOURCES,
  created_via: CREATED_VIA,
} as const satisfies Record<string, readonly string[]>

// The closed sets that live in a `CHECK (x IN (...))` rather than in an enum type. They are
// declared here so `schema.db.test.ts` can compare them against `pg_get_constraintdef`.
export const INTERACTION_TYPES = [
  'Meeting',
  'Call',
  'Email',
  'Message',
  'Intro',
  'Event',
  'Note',
] as const
export const INTERACTION_SOURCES = [
  'manual',
  'import',
  'gmail',
  'calendar',
  'whatsapp',
  'telegram',
  'agent',
] as const
export type InteractionType = (typeof INTERACTION_TYPES)[number]
export type InteractionSource = (typeof INTERACTION_SOURCES)[number]

const IDENTIFIER_KINDS = [
  'email',
  'phone',
  'linkedin_url',
  'website',
  'google_contact_id',
  'telegram',
  'whatsapp',
  'other',
] as const
const FOLLOW_UP_STATUSES = ['Open', 'Done', 'Snoozed'] as const
const FOLLOW_UP_ORIGINS = ['manual', 'system'] as const
const IMPORT_STATUSES = [
  'parsing',
  'mapping',
  'reviewing',
  'importing',
  'completed',
  'failed',
] as const
const IMPORT_DECISIONS = ['skip', 'merge', 'create'] as const
const LLM_TASK_KINDS = ['extraction', 'question', 'summary', 'embedding'] as const
const LLM_STATUSES = [
  'ok',
  'invalid_json',
  'schema_error',
  'http_error',
  'timeout',
  'budget_exceeded',
  'disabled',
] as const
const LLM_COST_SOURCES = ['reported', 'unreported', 'free'] as const

/**
 * `[select, write]` for every physical type the migrations use. `numeric` is a string because
 * node-pg leaves it as one — which is the only way `250000.50` survives a round trip — and `date`
 * is a string because `client.ts` installs a parser that stops node-pg turning a calendar day into
 * a zone-dependent `Date`.
 */
interface PgTypeMap {
  uuid: [string, string]
  text: [string, string]
  varchar: [string, string]
  int2: [number, number]
  int4: [number, number]
  numeric: [string, string | number]
  bool: [boolean, boolean]
  date: [string, string]
  timestamptz: [Date, Date | string]
  jsonb: [JsonValue, JsonValue | string]
  tsvector: [string, string]
  vector: [string, string]
  object_type: [ObjectType, ObjectType]
  attribute_type: [AttributeType, AttributeType]
  value_kind: [ValueKind, ValueKind]
  fact_source: [FactSource, FactSource]
  created_via: [CreatedVia, CreatedVia]
}

export type PgType = keyof PgTypeMap

// ---------------------------------------------------------------------------------------------
// Column declaration
// ---------------------------------------------------------------------------------------------

/**
 * The three properties are spelled as literal `true` rather than `boolean` so that a call site's
 * `{ null: true }` is inferred as `{ null: true }` and not widened to `{ null: boolean }` — which
 * is what lets `Build` below read them.
 */
interface ColumnOptions {
  readonly null?: true
  readonly default?: true
  readonly always?: true
}

type Nullable<T, O extends ColumnOptions> = O extends { null: true } ? T | null : T

type Build<S, W, O extends ColumnOptions> = ColumnType<
  Nullable<S, O>,
  O extends { always: true }
    ? never
    : O extends { default: true }
      ? Nullable<W, O> | undefined
      : Nullable<W, O>,
  O extends { always: true } ? never : Nullable<W, O>
>

export interface Column<T> {
  readonly udt: PgType
  readonly nullable: boolean
  readonly has_default: boolean
  readonly generated: boolean
  /** The labels of a `CHECK (x IN (…))`, for the columns that have one. */
  readonly values?: readonly string[]
  /** Never present at runtime. It exists only to carry the Kysely column type. */
  readonly column?: T
}

/** The runtime half of a column. It satisfies every `Column<T>` because `column` is optional. */
type ColumnSpec = Omit<Column<never>, 'column'>

function describe(udt: PgType, options: ColumnOptions, values?: readonly string[]): ColumnSpec {
  return {
    udt,
    nullable: options.null === true,
    // Postgres reports a NULL `column_default` for a generated column, so the two are exclusive.
    has_default: options.default === true,
    generated: options.always === true,
    values,
  }
}

/** One column of one table. */
function col<K extends PgType, O extends ColumnOptions = ColumnOptions>(
  udt: K,
  options?: O,
): Column<Build<PgTypeMap[K][0], PgTypeMap[K][1], O>> {
  return describe(udt, options ?? {})
}

/** A `text` column whose values are closed by a `CHECK` constraint rather than by an enum type. */
function oneOf<T extends string, O extends ColumnOptions = ColumnOptions>(
  values: readonly T[],
  options?: O,
): Column<Build<T, T, O>> {
  return describe('text', options ?? {}, values)
}

// ---------------------------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------------------------

/**
 * Every table in the `public` schema, including the two Kysely writes for its migration ledger:
 * the drift test asserts set equality in both directions, so a table missing here fails as loudly
 * as a column does.
 */
export const SCHEMA = {
  // -- 0001 -------------------------------------------------------------------------------------

  workspace: {
    id: col('uuid', { default: true }),
    name: col('text'),
    metrics_swept_at: col('timestamptz', { null: true }),
    created_at: col('timestamptz', { default: true }),
  },

  profile: {
    id: col('uuid', { default: true }),
    workspace_id: col('uuid', { null: true }),
    first_name: col('text'),
    last_name: col('text'),
    email: col('text', { null: true }),
    language: col('text', { default: true }),
    phone_region: col('text', { default: true }),
    time_zone: col('text', { default: true }),
    created_at: col('timestamptz', { default: true }),
    updated_at: col('timestamptz', { default: true }),
  },

  // -- 0002 -------------------------------------------------------------------------------------

  record: {
    id: col('uuid', { default: true }),
    workspace_id: col('uuid', { null: true }),
    object_type: col('object_type'),
    created_via: col('created_via', { default: true }),
    import_batch_id: col('uuid', { null: true }),
    last_enriched_at: col('timestamptz', { null: true }),
    enriched_by: col('text', { null: true }),
    // Written only by sync_record_label(); both are read-only to the application.
    display_label: col('text', { default: true }),
    label_norm: col('text', { default: true }),
    created_at: col('timestamptz', { default: true }),
    updated_at: col('timestamptz', { default: true }),
  },

  contact: {
    id: col('uuid'),
    first_name: col('text', { null: true }),
    last_name: col('text', { null: true }),
    display_name: col('text', { null: true, always: true }),
    pinned_important: col('bool', { default: true }),
    not_important: col('bool', { default: true }),
  },

  organization: {
    id: col('uuid'),
    name: col('text'),
  },

  interaction: {
    id: col('uuid'),
    type: oneOf(INTERACTION_TYPES),
    occurred_at: col('timestamptz'),
    title: col('text', { null: true }),
    body: col('text', { null: true }),
    source: oneOf(INTERACTION_SOURCES, { default: true }),
  },

  interaction_contact: {
    interaction_id: col('uuid'),
    contact_id: col('uuid'),
  },

  interaction_organization: {
    interaction_id: col('uuid'),
    organization_id: col('uuid'),
  },

  attribute_definition: {
    id: col('uuid', { default: true }),
    workspace_id: col('uuid', { null: true }),
    object_type: col('object_type'),
    title: col('text'),
    slug: col('text'),
    type: col('attribute_type'),
    value_kind: col('value_kind'),
    is_multi: col('bool'),
    config: col('jsonb', { default: true }),
    group_name: col('text', { null: true }),
    description: col('text', { null: true }),
    is_system: col('bool', { default: true }),
    position: col('int4', { default: true }),
    created_at: col('timestamptz', { default: true }),
    updated_at: col('timestamptz', { default: true }),
  },

  attribute_option: {
    id: col('uuid', { default: true }),
    workspace_id: col('uuid', { null: true }),
    attribute_id: col('uuid'),
    key: col('text'),
    label: col('text'),
    color: col('text', { null: true }),
    position: col('int4'),
    archived_at: col('timestamptz', { null: true }),
    created_at: col('timestamptz', { default: true }),
  },

  fact: {
    id: col('uuid', { default: true }),
    workspace_id: col('uuid', { null: true }),
    object_type: col('object_type'),
    record_id: col('uuid'),
    attribute_id: col('uuid'),
    value_kind: col('value_kind'),
    is_multi: col('bool'),
    text_value: col('text', { null: true }),
    num_value: col('numeric', { null: true }),
    date_value: col('date', { null: true }),
    bool_value: col('bool', { null: true }),
    option_id: col('uuid', { null: true }),
    target_record_id: col('uuid', { null: true }),
    link_title: col('text', { null: true }),
    link_from: col('date', { null: true }),
    link_to: col('date', { null: true }),
    link_is_primary: col('bool', { null: true }),
    value_key: col('text'),
    valid_from: col('date'),
    observed_at: col('timestamptz', { default: true }),
    source: col('fact_source'),
    source_ref: col('text', { null: true }),
    confidence: col('numeric', { default: true }),
    superseded_by_id: col('uuid', { null: true }),
    removed_at: col('timestamptz', { null: true }),
    removed_source: col('fact_source', { null: true }),
    created_at: col('timestamptz', { default: true }),
  },

  attribute_value: {
    id: col('uuid', { default: true }),
    workspace_id: col('uuid', { null: true }),
    object_type: col('object_type'),
    record_id: col('uuid'),
    attribute_id: col('uuid'),
    value_kind: col('value_kind'),
    is_multi: col('bool'),
    value_key: col('text'),
    position: col('int4', { default: true }),
    fact_id: col('uuid'),
    text_value: col('text', { null: true }),
    text_norm: col('text', { null: true }),
    text_sort: col('text', { null: true }),
    num_value: col('numeric', { null: true }),
    date_value: col('date', { null: true }),
    bool_value: col('bool', { null: true }),
    option_id: col('uuid', { null: true }),
    updated_at: col('timestamptz', { default: true }),
  },

  record_link: {
    id: col('uuid', { default: true }),
    workspace_id: col('uuid', { null: true }),
    attribute_id: col('uuid'),
    from_record_id: col('uuid'),
    to_record_id: col('uuid'),
    title: col('text', { null: true }),
    valid_from: col('date', { null: true }),
    valid_to: col('date', { null: true }),
    is_primary: col('bool', { default: true }),
    position: col('int4', { default: true }),
    fact_id: col('uuid'),
    created_at: col('timestamptz', { default: true }),
    updated_at: col('timestamptz', { default: true }),
  },

  identifier: {
    id: col('uuid', { default: true }),
    workspace_id: col('uuid', { null: true }),
    record_id: col('uuid'),
    kind: oneOf(IDENTIFIER_KINDS),
    value: col('text'),
    source: col('fact_source'),
    created_at: col('timestamptz', { default: true }),
  },

  follow_up: {
    id: col('uuid', { default: true }),
    workspace_id: col('uuid', { null: true }),
    contact_id: col('uuid'),
    title: col('text'),
    due_at: col('date'),
    status: oneOf(FOLLOW_UP_STATUSES, { default: true }),
    recurrence: col('jsonb', { null: true }),
    origin: oneOf(FOLLOW_UP_ORIGINS, { default: true }),
    notes: col('text', { null: true }),
    completed_at: col('timestamptz', { null: true }),
    created_at: col('timestamptz', { default: true }),
    updated_at: col('timestamptz', { default: true }),
  },

  // -- 0004 -------------------------------------------------------------------------------------

  contact_metrics: {
    contact_id: col('uuid'),
    workspace_id: col('uuid', { null: true }),
    last_interaction_at: col('timestamptz', { null: true }),
    interaction_count_12m: col('int4', { default: true }),
    open_followups: col('int4', { default: true }),
    next_followup_at: col('date', { null: true }),
    warmth: col('int2', { default: true }),
    computed_at: col('timestamptz', { default: true }),
  },

  organization_metrics: {
    organization_id: col('uuid'),
    workspace_id: col('uuid', { null: true }),
    people_count: col('int4', { default: true }),
    last_interaction_at: col('timestamptz', { null: true }),
    computed_at: col('timestamptz', { default: true }),
  },

  search_document: {
    record_id: col('uuid'),
    workspace_id: col('uuid', { null: true }),
    object_type: col('object_type'),
    title: col('text', { default: true }),
    body: col('text', { default: true }),
    tsv: col('tsvector', { null: true, always: true }),
    embedding: col('vector', { null: true }),
    embedding_model: col('text', { null: true }),
    embedded_at: col('timestamptz', { null: true }),
    updated_at: col('timestamptz', { default: true }),
  },

  saved_view: {
    id: col('uuid', { default: true }),
    workspace_id: col('uuid', { null: true }),
    object_type: col('object_type'),
    name: col('text'),
    is_default: col('bool', { default: true }),
    columns: col('jsonb', { default: true }),
    filters: col('jsonb', { default: true }),
    sort: col('jsonb', { null: true }),
    position: col('int4', { default: true }),
    created_at: col('timestamptz', { default: true }),
    updated_at: col('timestamptz', { default: true }),
  },

  // -- 0005 -------------------------------------------------------------------------------------

  import_batch: {
    id: col('uuid', { default: true }),
    workspace_id: col('uuid', { null: true }),
    file_name: col('text'),
    object_type: col('object_type'),
    row_count: col('int4', { default: true }),
    mapping: col('jsonb', { default: true }),
    status: oneOf(IMPORT_STATUSES, { default: true }),
    last_committed_row: col('int4', { default: true }),
    error_detail: col('jsonb', { null: true }),
    created_count: col('int4', { default: true }),
    merged_count: col('int4', { default: true }),
    skipped_count: col('int4', { default: true }),
    imported_at: col('timestamptz', { default: true }),
  },

  import_row: {
    batch_id: col('uuid'),
    row_number: col('int4'),
    raw: col('jsonb'),
    mapped: col('jsonb', { default: true }),
    errors: col('jsonb', { default: true }),
    duplicate_of: col('uuid', { null: true }),
    decision: oneOf(IMPORT_DECISIONS, { null: true }),
    // -- 0009 (ADR-097) --
    duplicate_of_row: col('int4', { null: true }),
    duplicate_detail: col('jsonb', { null: true }),
  },

  // -- 0006 -------------------------------------------------------------------------------------

  llm_call: {
    id: col('uuid', { default: true }),
    workspace_id: col('uuid', { null: true }),
    task_kind: oneOf(LLM_TASK_KINDS),
    prompt_id: col('text'),
    prompt_version: col('int4'),
    prompt_hash: col('text'),
    input_hash: col('text'),
    provider: col('text'),
    base_url: col('text'),
    model_requested: col('text'),
    model_served: col('text', { null: true }),
    upstream_provider: col('text', { null: true }),
    generation_id: col('text', { null: true }),
    request_body: col('jsonb', { null: true }),
    response_body: col('jsonb', { null: true }),
    status: oneOf(LLM_STATUSES),
    http_status: col('int4', { null: true }),
    attempt: col('int2', { default: true }),
    repair_of_id: col('uuid', { null: true }),
    error_detail: col('jsonb', { null: true }),
    parsed: col('jsonb', { null: true }),
    prompt_tokens: col('int4', { null: true }),
    completion_tokens: col('int4', { null: true }),
    reasoning_tokens: col('int4', { null: true }),
    cached_tokens: col('int4', { null: true }),
    cost_usd: col('numeric', { null: true }),
    cost_source: oneOf(LLM_COST_SOURCES, { null: true }),
    latency_ms: col('int4', { null: true }),
    record_id: col('uuid', { null: true }),
    request_id: col('text', { null: true }),
    created_at: col('timestamptz', { default: true }),
  },

  llm_setting: {
    key: col('text'),
    value: col('text'),
    updated_at: col('timestamptz', { default: true }),
  },

  // -- Kysely's own ledger ----------------------------------------------------------------------
  // Present because `assertSchemaCurrent` reads it through the query builder, and because a table
  // absent from `SCHEMA` fails the drift test.

  kysely_migration: {
    name: col('varchar'),
    timestamp: col('varchar'),
  },

  kysely_migration_lock: {
    id: col('varchar'),
    is_locked: col('int4', { default: true }),
  },
} satisfies Record<string, Record<string, Column<unknown>>>

export type Schema = typeof SCHEMA
export type TableName = keyof Schema

/** The Kysely interface, derived so it cannot disagree with what the drift test checks. */
export type DB = {
  [T in TableName]: {
    -readonly [C in keyof Schema[T]]: Schema[T][C] extends Column<infer V> ? V : never
  }
}
