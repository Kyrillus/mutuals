/**
 * The filter compiler (ADR-033): one validated `Filter` in, one `Expression<SqlBool>` out.
 *
 * Three properties hold by construction and each of them is asserted by a test:
 *
 * 1. **No user input ever becomes a SQL identifier.** Every value is a bind parameter. The only
 *    identifiers emitted are table aliases declared here, physical slot columns taken from
 *    `@mutuals/core`'s `slots.ts`, and system columns whose `(table, column)` pair is a closed
 *    literal union in `fields/system.ts`. A slug is resolved to a definition *before* any SQL
 *    exists, so an unknown slug is an issue, not a query.
 * 2. **One `EXISTS` per chip.** A `JOIN` per predicate multiplies rows for a multi-valued
 *    attribute — five tags, five copies of the contact, and a footer count that lies. `EXISTS`
 *    compiles to a semi-join that Postgres can pull up into the join tree and drive from whichever
 *    chip is selective (storage-DECISION §5.2).
 * 3. **No clock.** `today` is injected and relative operators are resolved in `packages/core`
 *    before they reach here (ADR-040), so `now()` never appears in emitted SQL and a saved view
 *    parsed on two different days compiles to two different bound parameters.
 *
 * Text normalisation happens in SQL and only in SQL (ADR-019): the needle is bound verbatim and
 * wrapped in `mutuals_norm()`, so TypeScript never produces a value compared against a normalised
 * column.
 */
import { sql, type Expression, type RawBuilder, type SqlBool } from 'kysely'
import {
  addDays,
  assertNever,
  compareCivil,
  compareDecimal,
  definitionOptions,
  fieldValueKind,
  findOptionByKey,
  issue,
  normColumn,
  ok,
  parseCivil,
  parseDecimal,
  resolveRelativeDate,
  sortColumn,
  valueColumn,
  VALUE_KEY_COLUMN,
  type CivilDate,
  type CoreIssue,
  type DecimalString,
  type FieldDescriptor,
  type FieldResolver,
  type Filter,
  type FilterSet,
  type MetricTable,
  type ObjectType,
  type RelativeDateSpec,
  type ResolvedDateBound,
  type Result,
  type SystemTable,
  type ValueKind,
} from '@mutuals/core'

/** The driving `record` row every predicate correlates against. */
export const RECORD_ALIAS = 'r'
/** The `attribute_value` row inside a chip's `EXISTS`. */
export const VALUE_ALIAS = 'v'
/** The second `attribute_value` scan `contains all of` counts over. */
export const VALUE_COUNT_ALIAS = 'v2'
/** The `record_link` row inside a relation chip's `EXISTS`. */
export const LINK_ALIAS = 'l'

const VALUE_TABLE = 'attribute_value'
const LINK_TABLE = 'record_link'

/**
 * Aliases for the tables a system field can live on. `contact_metrics` and `organization_metrics`
 * share `m` because exactly one of them is ever in scope: the object type decides which.
 */
export const TABLE_ALIASES = {
  record: RECORD_ALIAS,
  contact: 'c',
  organization: 'o',
  interaction: 'i',
  contact_metrics: 'm',
  organization_metrics: 'm',
} as const satisfies Record<SystemTable | MetricTable, string>

/** `text_sort` is `left(text_norm, 256)`; the projector's truncation, mirrored by `equals`. */
const TEXT_SORT_LENGTH = 256
/** A `tags` element's `value_key` is `left(mutuals_norm(text), 512)` (ADR-018). */
const VALUE_KEY_LENGTH = 512

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const COLUMN_SQL_TYPES = [
  'text',
  'enum_text',
  'uuid',
  'timestamptz',
  'date',
  'boolean',
  'numeric',
] as const

export type ColumnSqlType = (typeof COLUMN_SQL_TYPES)[number]

/**
 * The physical shape of every system and metric column.
 *
 * `valueKind` on a field descriptor is *filter* semantics, not storage: `created_at`,
 * `occurred_at` and `last_interaction_at` all filter as dates and are all `timestamptz`, while
 * `next_followup_at` really is a `date`. Both the cast a predicate needs and whether an `ORDER BY`
 * has to say `NULLS LAST` follow from the physical column, so they are written down here — keyed
 * by the `(table, column)` pair, both of which are closed literal unions in `fields/system.ts`.
 * `compile.test.ts` asserts every system field of every object type has an entry.
 *
 * Every metric column is `nullable`, including the ones the DDL declares `NOT NULL`: the metrics
 * row reaches the query through a `LEFT JOIN`, so a contact the nightly sweep has not reached yet
 * has no row and every one of its metrics reads as NULL.
 */
export const SYSTEM_COLUMNS = {
  'record.created_at': { type: 'timestamptz', nullable: false },
  'record.updated_at': { type: 'timestamptz', nullable: false },
  // A real Postgres enum, so a bare parameter comparison would need the enum's own type.
  'record.created_via': { type: 'enum_text', nullable: false },
  'record.import_batch_id': { type: 'uuid', nullable: true },
  // Generated, and generated columns carry no NOT NULL constraint even when the expression cannot
  // produce one — so the planner treats it as nullable and so does this table.
  'contact.display_name': { type: 'text', nullable: true },
  'contact.first_name': { type: 'text', nullable: true },
  'contact.last_name': { type: 'text', nullable: true },
  'contact.pinned_important': { type: 'boolean', nullable: false },
  'contact.not_important': { type: 'boolean', nullable: false },
  'organization.name': { type: 'text', nullable: false },
  // `text` with a CHECK, but the values are machine keys: matched exactly, never case-folded.
  'interaction.type': { type: 'enum_text', nullable: false },
  'interaction.title': { type: 'text', nullable: true },
  'interaction.occurred_at': { type: 'timestamptz', nullable: false },
  'interaction.body': { type: 'text', nullable: true },
  'interaction.source': { type: 'enum_text', nullable: false },
  'contact_metrics.warmth': { type: 'numeric', nullable: true },
  'contact_metrics.last_interaction_at': { type: 'timestamptz', nullable: true },
  'contact_metrics.interaction_count_12m': { type: 'numeric', nullable: true },
  'contact_metrics.open_followups': { type: 'numeric', nullable: true },
  'contact_metrics.next_followup_at': { type: 'date', nullable: true },
  'organization_metrics.people_count': { type: 'numeric', nullable: true },
  'organization_metrics.last_interaction_at': { type: 'timestamptz', nullable: true },
} as const satisfies Record<string, { readonly type: ColumnSqlType; readonly nullable: boolean }>

export type ColumnRef = keyof typeof SYSTEM_COLUMNS

export interface CompileContext {
  readonly objectType: ObjectType
  readonly resolver: FieldResolver
  /** Injected, never read from the wall clock (ADR-034). */
  readonly today: CivilDate
  /** `profile.time_zone` (ADR-045): what "on this day" means for a `timestamptz` column. */
  readonly timeZone: string
}

/** One compiled chip, with the field it came from so the caller knows which joins it needs. */
export interface CompiledFilter {
  readonly field: FieldDescriptor
  readonly expression: Expression<SqlBool>
}

export function ref(alias: string, column: string): RawBuilder<unknown> {
  return sql.ref(`${alias}.${column}`)
}

/** The aliased reference for a system or metric field. Throws for an attribute — a caller bug. */
export function columnRef(field: FieldDescriptor): RawBuilder<unknown> {
  const source = field.source
  if (source.kind === 'attribute') {
    throw new Error(`"${field.slug}" is an attribute, not a column`)
  }
  return ref(TABLE_ALIASES[source.table], source.column)
}

/** The `(table, column)` key a system field's cast and nullability are looked up by. */
export function columnKey(field: FieldDescriptor): ColumnRef {
  const source = field.source
  if (source.kind === 'attribute') {
    throw new Error(`"${field.slug}" is an attribute, not a column`)
  }
  return `${source.table}.${source.column}` as ColumnRef
}

export function systemColumn(field: FieldDescriptor): (typeof SYSTEM_COLUMNS)[ColumnRef] {
  const key = columnKey(field)
  const declared = SYSTEM_COLUMNS[key] as (typeof SYSTEM_COLUMNS)[ColumnRef] | undefined
  if (declared === undefined) throw new Error(`No SQL type declared for the column "${key}"`)
  return declared
}

function sqlTypeOf(field: FieldDescriptor): ColumnSqlType {
  return systemColumn(field).type
}

function fieldIssue(
  code: CoreIssue['code'],
  message: string,
  slug: string,
  meta?: Readonly<Record<string, string | number | boolean>>,
): Result<never> {
  return { ok: false, issues: [issue(code, message, ['field'], { field: slug, ...meta })] }
}

/** `mutuals_norm($1)` — the one normaliser, applied to the needle in SQL and never in TypeScript. */
function norm(value: string): RawBuilder<string> {
  return sql<string>`mutuals_norm(${value})`
}

/** `'%' || mutuals_esc(mutuals_norm($1)) || '%'` — a substring needle with `%` and `_` neutralised. */
function likeNeedle(value: string): RawBuilder<string> {
  return sql<string>`'%' || mutuals_esc(${norm(value)}) || '%'`
}

// ---------------------------------------------------------------------------------------------
// Attribute predicates: one EXISTS over attribute_value, or over record_link for a relation.
// ---------------------------------------------------------------------------------------------

function existsValue(attributeId: string, predicate: RawBuilder<unknown>): RawBuilder<SqlBool> {
  return sql<SqlBool>`exists (select 1 from ${sql.table(VALUE_TABLE)} as ${sql.id(VALUE_ALIAS)} where ${ref(VALUE_ALIAS, 'record_id')} = ${ref(RECORD_ALIAS, 'id')} and ${ref(VALUE_ALIAS, 'attribute_id')} = ${attributeId} and ${predicate})`
}

function notExistsValue(attributeId: string, predicate: RawBuilder<unknown>): RawBuilder<SqlBool> {
  return sql<SqlBool>`not ${existsValue(attributeId, predicate)}`
}

/** ADR-017's one definition of empty, for all twelve types: no live value row exists. */
function anyValue(attributeId: string): RawBuilder<SqlBool> {
  return sql<SqlBool>`exists (select 1 from ${sql.table(VALUE_TABLE)} as ${sql.id(VALUE_ALIAS)} where ${ref(VALUE_ALIAS, 'record_id')} = ${ref(RECORD_ALIAS, 'id')} and ${ref(VALUE_ALIAS, 'attribute_id')} = ${attributeId})`
}

function anyLink(attributeId: string): RawBuilder<SqlBool> {
  return sql<SqlBool>`exists (select 1 from ${sql.table(LINK_TABLE)} as ${sql.id(LINK_ALIAS)} where ${ref(LINK_ALIAS, 'from_record_id')} = ${ref(RECORD_ALIAS, 'id')} and ${ref(LINK_ALIAS, 'attribute_id')} = ${attributeId})`
}

function linkTargets(attributeId: string, targets: readonly string[]): RawBuilder<SqlBool> {
  return sql<SqlBool>`exists (select 1 from ${sql.table(LINK_TABLE)} as ${sql.id(LINK_ALIAS)} where ${ref(LINK_ALIAS, 'from_record_id')} = ${ref(RECORD_ALIAS, 'id')} and ${ref(LINK_ALIAS, 'attribute_id')} = ${attributeId} and ${ref(LINK_ALIAS, 'to_record_id')} = any(${targets}::uuid[]))`
}

const slot = (kind: ValueKind): RawBuilder<unknown> => ref(VALUE_ALIAS, valueColumn(kind))

function textNorm(): RawBuilder<unknown> {
  const column = normColumn('text')
  if (column === undefined) throw new Error('The text kind must have a normalised column')
  return ref(VALUE_ALIAS, column)
}

function textSort(): RawBuilder<unknown> {
  const column = sortColumn('text')
  if (column === undefined) throw new Error('The text kind must have a sort column')
  return ref(VALUE_ALIAS, column)
}

// ---------------------------------------------------------------------------------------------
// Value coercion. Everything on the wire is a string; the field decides what it means.
// ---------------------------------------------------------------------------------------------

function coerceNumber(raw: string, slug: string, path: string): Result<DecimalString> {
  const parsed = parseDecimal(raw)
  if (!parsed.ok) {
    return fieldIssue('not_a_number', `"${raw}" is not a number.`, slug, { path })
  }
  return ok(parsed.value)
}

function coerceDate(raw: string, slug: string, path: string): Result<CivilDate> {
  const parsed = parseCivil(raw)
  if (!parsed.ok) {
    return fieldIssue('bad_date', `"${raw}" is not a date in YYYY-MM-DD form.`, slug, { path })
  }
  return ok(parsed.value)
}

function coerceUuid(raw: string, slug: string): Result<string> {
  if (!UUID_PATTERN.test(raw)) {
    return fieldIssue('invalid_input', `"${raw}" is not a record id.`, slug)
  }
  return ok(raw)
}

function coerceUuids(values: readonly string[], slug: string): Result<readonly string[]> {
  const issues: CoreIssue[] = []
  const ids: string[] = []
  for (const value of values) {
    const parsed = coerceUuid(value, slug)
    if (parsed.ok) ids.push(parsed.value)
    else issues.push(...parsed.issues)
  }
  return issues.length === 0 ? ok(ids) : { ok: false, issues }
}

/**
 * Select filters carry option *keys*, because a key survives a rename and an id does not appear in
 * a shareable URL. Archived options resolve too: a saved view that filters on a retired option
 * must keep working, and §6.7 keeps the row precisely so history still renders.
 */
function coerceOptionIds(
  values: readonly string[],
  field: FieldDescriptor,
): Result<readonly string[]> {
  if (field.source.kind !== 'attribute') {
    return fieldIssue('operator_not_allowed', `"${field.slug}" has no options.`, field.slug)
  }
  const options = definitionOptions(field.source.def)
  const issues: CoreIssue[] = []
  const ids: string[] = []
  for (const key of values) {
    const option = findOptionByKey(options, key)
    if (option === undefined) {
      issues.push(
        issue('unknown_option', `"${key}" is not an option of "${field.label}".`, ['field'], {
          field: field.slug,
          option: key,
        }),
      )
      continue
    }
    ids.push(option.id)
  }
  return issues.length === 0 ? ok(ids) : { ok: false, issues }
}

function rangeOrder<T extends string>(
  from: T,
  to: T,
  slug: string,
  compare: (a: T, b: T) => number,
): Result<readonly [T, T]> {
  if (compare(from, to) > 0) {
    return fieldIssue('out_of_range', 'The start of a range must not come after its end.', slug)
  }
  return ok([from, to])
}

// ---------------------------------------------------------------------------------------------
// Attribute chips
// ---------------------------------------------------------------------------------------------

function compileAttributeFilter(
  filter: Filter,
  field: FieldDescriptor,
  ctx: CompileContext,
): Result<Expression<SqlBool>> {
  if (field.source.kind !== 'attribute') throw new Error('Not an attribute field')
  const attributeId = field.source.def.id
  const kind = fieldValueKind(field)
  const slug = field.slug
  const unsupported = (): Result<never> =>
    fieldIssue('operator_not_allowed', `"${filter.op}" cannot be used on "${field.label}".`, slug, {
      op: filter.op,
    })

  switch (filter.op) {
    case 'is_empty':
      return ok(
        kind === 'relation'
          ? sql<SqlBool>`not ${anyLink(attributeId)}`
          : sql<SqlBool>`not ${anyValue(attributeId)}`,
      )
    case 'is_not_empty':
      return ok(kind === 'relation' ? anyLink(attributeId) : anyValue(attributeId))

    case 'contains': {
      if (kind !== 'text') return unsupported()
      return ok(existsValue(attributeId, sql`${textNorm()} like ${likeNeedle(filter.value)}`))
    }

    case 'equals': {
      if (kind !== 'text') return unsupported()
      // The truncated, `COLLATE "C"` sort column narrows through `av_attr_text_idx`; the full
      // normalised column then rechecks, so two values sharing a 256-character prefix stay apart.
      return ok(
        existsValue(
          attributeId,
          sql`${textSort()} = left(${norm(filter.value)}, ${sql.lit(TEXT_SORT_LENGTH)}) and ${textNorm()} = ${norm(filter.value)}`,
        ),
      )
    }

    case 'eq':
    case 'neq':
    case 'lt':
    case 'gt': {
      if (kind !== 'number') return unsupported()
      const value = coerceNumber(filter.value, slug, 'value')
      if (!value.ok) return value
      const operator = NUMBER_OPERATOR_SQL[filter.op]
      // ADR-017: `≠` means "has a value, and it differs", so it lives inside the EXISTS and a
      // record with no value is not returned. `is empty` is the operator for that.
      return ok(
        existsValue(attributeId, sql`${slot(kind)} ${sql.raw(operator)} ${value.value}::numeric`),
      )
    }

    case 'between': {
      if (kind === 'number') {
        const from = coerceNumber(filter.from, slug, 'from')
        const to = coerceNumber(filter.to, slug, 'to')
        if (!from.ok) return from
        if (!to.ok) return to
        const ordered = rangeOrder(from.value, to.value, slug, compareDecimal)
        if (!ordered.ok) return ordered
        return ok(
          existsValue(
            attributeId,
            sql`${slot(kind)} between ${ordered.value[0]}::numeric and ${ordered.value[1]}::numeric`,
          ),
        )
      }
      if (kind === 'date') {
        const from = coerceDate(filter.from, slug, 'from')
        const to = coerceDate(filter.to, slug, 'to')
        if (!from.ok) return from
        if (!to.ok) return to
        const ordered = rangeOrder<CivilDate>(from.value, to.value, slug, compareCivil)
        if (!ordered.ok) return ordered
        return ok(
          dateBound(attributeId, { kind: 'range', from: ordered.value[0], to: ordered.value[1] }),
        )
      }
      return unsupported()
    }

    case 'before':
    case 'after': {
      if (kind !== 'date') return unsupported()
      const value = coerceDate(filter.value, slug, 'value')
      if (!value.ok) return value
      return ok(
        dateBound(
          attributeId,
          filter.op === 'before'
            ? { kind: 'before', cutoff: value.value }
            : { kind: 'after', cutoff: value.value },
        ),
      )
    }

    case 'in_relative':
    case 'older_than':
    case 'newer_than': {
      if (kind !== 'date') return unsupported()
      const resolved = resolveRelativeDate(relativeSpec(filter), ctx.today)
      if (!resolved.ok) return resolved
      return ok(dateBound(attributeId, resolved.value))
    }

    case 'is_yes':
    case 'is_no': {
      if (kind !== 'bool') return unsupported()
      const column = slot(kind)
      return ok(
        existsValue(attributeId, filter.op === 'is_yes' ? sql`${column}` : sql`not ${column}`),
      )
    }

    case 'is_one_of':
    case 'is_not_one_of': {
      if (kind !== 'option') return unsupported()
      const ids = coerceOptionIds(filter.values, field)
      if (!ids.ok) return ids
      const predicate = sql`${slot(kind)} = any(${ids.value}::uuid[])`
      // ADR-017: `is not one of` is the negation of the whole semi-join, so a record with no
      // value matches — which is how a person reads "is not an Investor".
      return ok(
        filter.op === 'is_one_of'
          ? existsValue(attributeId, predicate)
          : notExistsValue(attributeId, predicate),
      )
    }

    case 'contains_any_of': {
      if (kind === 'option') {
        const ids = coerceOptionIds(filter.values, field)
        if (!ids.ok) return ids
        return ok(existsValue(attributeId, sql`${slot(kind)} = any(${ids.value}::uuid[])`))
      }
      if (kind === 'text') {
        // `tags`. The identity of one element is its normalised, truncated key, and normalisation
        // is SQL's job — so the needles are normalised by the database, not before it (ADR-019).
        return ok(
          existsValue(
            attributeId,
            sql`${ref(VALUE_ALIAS, VALUE_KEY_COLUMN)} = any(array(select left(mutuals_norm(k), ${sql.lit(VALUE_KEY_LENGTH)}) from unnest(${filter.values}::text[]) as k))`,
          ),
        )
      }
      return unsupported()
    }

    case 'contains_all_of': {
      if (kind !== 'option') return unsupported()
      const ids = coerceOptionIds(filter.values, field)
      if (!ids.ok) return ids
      // Not an EXISTS: "has all of these" is a count, and counting distinct options tolerates the
      // same option arriving twice from two facts without inflating the total.
      return ok(
        sql<SqlBool>`(select count(distinct ${ref(VALUE_COUNT_ALIAS, valueColumn(kind))}) from ${sql.table(VALUE_TABLE)} as ${sql.id(VALUE_COUNT_ALIAS)} where ${ref(VALUE_COUNT_ALIAS, 'record_id')} = ${ref(RECORD_ALIAS, 'id')} and ${ref(VALUE_COUNT_ALIAS, 'attribute_id')} = ${attributeId} and ${ref(VALUE_COUNT_ALIAS, valueColumn(kind))} = any(${ids.value}::uuid[])) = cardinality(${ids.value}::uuid[])`,
      )
    }

    case 'has_any_of': {
      if (kind !== 'relation') return unsupported()
      const ids = coerceUuids(filter.values, slug)
      if (!ids.ok) return ids
      return ok(linkTargets(attributeId, ids.value))
    }

    default:
      return assertNever(filter, 'filter operator')
  }
}

/** A resolved bound against `attribute_value`'s `date` slot: no casts beyond `::date`, no clock. */
function dateBound(attributeId: string, bound: ResolvedDateBound): RawBuilder<SqlBool> {
  const column = slot('date')
  switch (bound.kind) {
    case 'range':
      return existsValue(
        attributeId,
        sql`${column} between ${bound.from}::date and ${bound.to}::date`,
      )
    case 'before':
      return existsValue(attributeId, sql`${column} < ${bound.cutoff}::date`)
    case 'after':
      return existsValue(attributeId, sql`${column} > ${bound.cutoff}::date`)
    default:
      return assertNever(bound, 'resolved date bound')
  }
}

// ---------------------------------------------------------------------------------------------
// System and derived columns
// ---------------------------------------------------------------------------------------------

function compileColumnFilter(
  filter: Filter,
  field: FieldDescriptor,
  ctx: CompileContext,
): Result<Expression<SqlBool>> {
  const column = columnRef(field)
  const type = sqlTypeOf(field)
  const slug = field.slug
  const unsupported = (): Result<never> =>
    fieldIssue('operator_not_allowed', `"${filter.op}" cannot be used on "${field.label}".`, slug, {
      op: filter.op,
    })

  switch (filter.op) {
    case 'is_empty':
    case 'is_not_empty': {
      const empty =
        type === 'text'
          ? // A generated `display_name` is `''` for a contact with no names at all, so "empty"
            // has to cover both — otherwise it would disagree with ADR-017 for attributes.
            sql<SqlBool>`(${column} is null or ${column} = '')`
          : sql<SqlBool>`(${column} is null)`
      return ok(filter.op === 'is_empty' ? empty : sql<SqlBool>`not ${empty}`)
    }

    case 'contains': {
      if (type !== 'text') return unsupported()
      return ok(sql<SqlBool>`mutuals_norm(${column}) like ${likeNeedle(filter.value)}`)
    }

    case 'equals': {
      if (type === 'text') {
        return ok(sql<SqlBool>`mutuals_norm(${column}) = ${norm(filter.value)}`)
      }
      if (type === 'enum_text') {
        return ok(sql<SqlBool>`(${column})::text = ${filter.value}`)
      }
      if (type === 'uuid') {
        const id = coerceUuid(filter.value, slug)
        if (!id.ok) return id
        return ok(sql<SqlBool>`${column} = ${id.value}::uuid`)
      }
      return unsupported()
    }

    case 'is_one_of':
    case 'is_not_one_of': {
      if (type !== 'enum_text') return unsupported()
      // `<> all` rather than `not (= any)` so a NULL column still matches "is not one of",
      // which is the same reading ADR-017 gives `single_select is not one of`.
      return ok(
        filter.op === 'is_one_of'
          ? sql<SqlBool>`(${column})::text = any(${filter.values}::text[])`
          : sql<SqlBool>`(${column} is null or (${column})::text <> all(${filter.values}::text[]))`,
      )
    }

    case 'eq':
    case 'neq':
    case 'lt':
    case 'gt': {
      if (type !== 'numeric') return unsupported()
      const value = coerceNumber(filter.value, slug, 'value')
      if (!value.ok) return value
      const operator = NUMBER_OPERATOR_SQL[filter.op]
      return ok(sql<SqlBool>`${column} ${sql.raw(operator)} ${value.value}::numeric`)
    }

    case 'between': {
      if (type === 'numeric') {
        const from = coerceNumber(filter.from, slug, 'from')
        const to = coerceNumber(filter.to, slug, 'to')
        if (!from.ok) return from
        if (!to.ok) return to
        const ordered = rangeOrder(from.value, to.value, slug, compareDecimal)
        if (!ordered.ok) return ordered
        return ok(
          sql<SqlBool>`${column} between ${ordered.value[0]}::numeric and ${ordered.value[1]}::numeric`,
        )
      }
      if (isDateType(type)) {
        const from = coerceDate(filter.from, slug, 'from')
        const to = coerceDate(filter.to, slug, 'to')
        if (!from.ok) return from
        if (!to.ok) return to
        const ordered = rangeOrder<CivilDate>(from.value, to.value, slug, compareCivil)
        if (!ordered.ok) return ordered
        return ok(
          columnDateBound(
            column,
            type,
            { kind: 'range', from: ordered.value[0], to: ordered.value[1] },
            ctx.timeZone,
          ),
        )
      }
      return unsupported()
    }

    case 'before':
    case 'after': {
      if (!isDateType(type)) return unsupported()
      const value = coerceDate(filter.value, slug, 'value')
      if (!value.ok) return value
      return ok(
        columnDateBound(
          column,
          type,
          filter.op === 'before'
            ? { kind: 'before', cutoff: value.value }
            : { kind: 'after', cutoff: value.value },
          ctx.timeZone,
        ),
      )
    }

    case 'in_relative':
    case 'older_than':
    case 'newer_than': {
      if (!isDateType(type)) return unsupported()
      const resolved = resolveRelativeDate(relativeSpec(filter), ctx.today)
      if (!resolved.ok) return resolved
      return ok(columnDateBound(column, type, resolved.value, ctx.timeZone))
    }

    case 'is_yes':
    case 'is_no': {
      if (type !== 'boolean') return unsupported()
      return ok(filter.op === 'is_yes' ? sql<SqlBool>`${column}` : sql<SqlBool>`not ${column}`)
    }

    case 'contains_any_of':
    case 'contains_all_of':
    case 'has_any_of':
      return unsupported()

    default:
      return assertNever(filter, 'filter operator')
  }
}

function isDateType(type: ColumnSqlType): type is 'date' | 'timestamptz' {
  return type === 'date' || type === 'timestamptz'
}

/**
 * A civil-day bound applied to a real column.
 *
 * A `date` column compares directly. A `timestamptz` is an instant, and "on 3 March" is only a
 * question you can answer in a timezone — so the bound is converted to the profile's local
 * midnight and the *day after* the upper bound becomes an exclusive limit. The `+1 day` is
 * computed in TypeScript and bound, so the emitted SQL contains no interval arithmetic.
 */
function columnDateBound(
  column: RawBuilder<unknown>,
  type: 'date' | 'timestamptz',
  bound: ResolvedDateBound,
  timeZone: string,
): RawBuilder<SqlBool> {
  const at = (day: CivilDate): RawBuilder<unknown> =>
    type === 'date' ? sql`${day}::date` : sql`(${day}::date::timestamp at time zone ${timeZone})`

  switch (bound.kind) {
    case 'range':
      return type === 'date'
        ? sql<SqlBool>`${column} between ${at(bound.from)} and ${at(bound.to)}`
        : sql<SqlBool>`(${column} >= ${at(bound.from)} and ${column} < ${at(addDays(bound.to, 1))})`
    case 'before':
      return sql<SqlBool>`${column} < ${at(bound.cutoff)}`
    case 'after':
      // "After 3 March" excludes 3 March itself, exactly as `date_value > $d` does for a date
      // attribute — which for an instant means "at or after the start of 4 March".
      return type === 'date'
        ? sql<SqlBool>`${column} > ${at(bound.cutoff)}`
        : sql<SqlBool>`${column} >= ${at(addDays(bound.cutoff, 1))}`
    default:
      return assertNever(bound, 'resolved date bound')
  }
}

const NUMBER_OPERATOR_SQL = {
  eq: '=',
  neq: '<>',
  lt: '<',
  gt: '>',
} as const

function relativeSpec(
  filter: Extract<Filter, { op: 'in_relative' | 'older_than' | 'newer_than' }>,
): RelativeDateSpec {
  return filter.op === 'in_relative'
    ? { op: 'in_relative', preset: filter.preset }
    : { op: filter.op, n: filter.n, unit: filter.unit }
}

// ---------------------------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------------------------

/**
 * Compiles one filter chip.
 *
 * The slug is resolved first: an unknown field, or an operator the field does not offer, is an
 * issue before a single character of SQL exists.
 */
export function compileFilter(filter: Filter, ctx: CompileContext): Result<CompiledFilter> {
  const field = ctx.resolver.get(filter.field)
  if (field === undefined) {
    return {
      ok: false,
      issues: [
        issue('unknown_field', `There is no field called "${filter.field}".`, ['field'], {
          field: filter.field,
        }),
      ],
    }
  }
  if (!field.operators.includes(filter.op)) {
    return fieldIssue(
      'operator_not_allowed',
      `"${filter.op}" cannot be used on "${field.label}".`,
      field.slug,
      { op: filter.op },
    )
  }

  const compiled =
    field.source.kind === 'attribute'
      ? compileAttributeFilter(filter, field, ctx)
      : compileColumnFilter(filter, field, ctx)
  return compiled.ok ? ok({ field, expression: compiled.value }) : compiled
}

/**
 * Compiles a whole filter set, collecting every issue rather than stopping at the first: a
 * hand-edited URL with three bad chips should say so three times, in one response.
 */
export function compileFilterSet(
  filters: FilterSet,
  ctx: CompileContext,
): Result<readonly CompiledFilter[]> {
  const compiled: CompiledFilter[] = []
  const issues: CoreIssue[] = []
  filters.forEach((filter, index) => {
    const one = compileFilter(filter, ctx)
    if (one.ok) compiled.push(one.value)
    else issues.push(...one.issues.map((i) => ({ ...i, path: ['filter', index, ...i.path] })))
  })
  return issues.length === 0 ? ok(compiled) : { ok: false, issues }
}

/**
 * §5.2's quick search box.
 *
 * One `EXISTS` with an attribute-id array, not an `OR` of one `EXISTS` per column: an `OR`
 * between semi-joins defeats the sublink pull-up and degrades to a sequential scan. The label
 * branch reads `record.label_norm`, which the label trigger keeps in step with `display_label`
 * and which `record_label_trgm_idx` covers.
 */
export function compileSearch(
  text: string,
  attributeIds: readonly string[],
): Expression<SqlBool> | null {
  const needle = text.trim()
  if (needle === '') return null
  const label = sql<SqlBool>`${ref(RECORD_ALIAS, 'label_norm')} like ${likeNeedle(needle)}`
  if (attributeIds.length === 0) return label
  return sql<SqlBool>`(${label} or exists (select 1 from ${sql.table(VALUE_TABLE)} as ${sql.id(VALUE_ALIAS)} where ${ref(VALUE_ALIAS, 'record_id')} = ${ref(RECORD_ALIAS, 'id')} and ${ref(VALUE_ALIAS, 'attribute_id')} = any(${attributeIds}::uuid[]) and ${textNorm()} like ${likeNeedle(needle)}))`
}

/** `a and b and …`, or `true` for no chips at all. */
export function conjoin(expressions: readonly Expression<SqlBool>[]): Expression<SqlBool> {
  if (expressions.length === 0) return sql<SqlBool>`true`
  if (expressions.length === 1) return expressions[0] as Expression<SqlBool>
  return sql<SqlBool>`${sql.join(expressions, sql.raw(' and '))}`
}

/** Which metric table, if any, a compiled chip needs joined. */
export function metricTableOf(field: FieldDescriptor): MetricTable | null {
  return field.source.kind === 'metric' ? field.source.table : null
}
