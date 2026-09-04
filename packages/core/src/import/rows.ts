/**
 * One raw row to canonical values, with every problem reported rather than the first (§6.8 step 4).
 *
 * This is where the Review grid's cells come from and where its `Find errors` toolbar gets its
 * list. Everything is a `Result`-shaped collection rather than a throw, for the reason
 * `result.ts` gives: a 10 000-row import has to surface every bad cell at once.
 *
 * Coercion is not reimplemented here. Each attribute type already owns `coerce(raw, config, ctx)`
 * — "free text — a CSV cell, an inline edit, LLM output — to something `value` accepts" — so a new
 * attribute type is importable the day it is registered. What this module adds is the three things
 * a *column* knows and a cell does not: the date format inferred over every row, the per-value
 * option mapping from step 3, and whether the row can produce a record at all.
 */
import { anyTypeDef } from '../attributes/registry.ts'
import type { AttributeDefinition } from '../attributes/definition.ts'
import type { ObjectType } from '../attributes/kinds.ts'
import type { TypeContext } from '../attributes/types/def.ts'
import { issue, type CoreIssue } from '../result.ts'
import { applyDateFormat, type DateFormat } from './dates.ts'
import type { ColumnMapping } from './automap.ts'
import { findTarget, type MappingTarget } from './targets.ts'

/**
 * Source value to option key, per target, from §6.8 step 3's value-mapping editor.
 *
 * Keyed by the *raw* source text so the user's choice survives a re-parse: "GP" to `investor` is a
 * statement about the file, not about the row it first appeared in.
 */
export type ValueMap = Readonly<Record<string, Readonly<Record<string, string>>>>

export interface MappedRow {
  /** Target id to canonical value. Absent rather than null when the cell was empty. */
  readonly values: Readonly<Record<string, unknown>>
  /** Every problem in the row. `path` is `[targetId]`, which is what highlights a cell. */
  readonly errors: readonly CoreIssue[]
}

export interface MapRowOptions {
  readonly objectType: ObjectType
  readonly mappings: readonly ColumnMapping[]
  readonly targets: readonly MappingTarget[]
  /** The definition behind each attribute target, by slug. `Schema.bySlug` in `apps/api`. */
  readonly definitions: ReadonlyMap<string, AttributeDefinition>
  /**
   * The options, phone region and phone normaliser one attribute validates against.
   *
   * Injected because only `apps/api` can supply `normalizePhone`: `packages/core` leaves it
   * undefined so a browser bundle never pulls libphonenumber-js's metadata (ADR-035).
   */
  readonly typeContext: (definition: AttributeDefinition) => TypeContext
  readonly valueMap?: ValueMap
}

/**
 * What a row must have to become a record at all.
 *
 * Not a `required` flag on the attribute definition — §4.2 defines no such concept, and
 * `AttributeDefinition` says so explicitly. This is a narrower and more defensible thing: the
 * subtype's label is a generated column (`contact.display_name` from the two name columns,
 * `organization.name` outright), and a record whose label is empty is unfindable in every list,
 * every search and every picker in the product. So the requirement is "can this row be named",
 * and the answer comes from the same system-field declaration the resolver reads.
 */
const LABEL_SOURCES: Readonly<Record<ObjectType, readonly string[]>> = {
  contact: ['first_name', 'last_name'],
  organization: ['name'],
  interaction: ['title'],
}

/** Spellings a spreadsheet uses for a boolean, beyond what a type's own coercion accepts. */
const TRUE_WORDS = new Set(['yes', 'y', 'true', 'ja', 'j', '1', 'x'])
const FALSE_WORDS = new Set(['no', 'n', 'false', 'nein', '0', ''])

export function mapRow(cells: readonly string[], options: MapRowOptions): MappedRow {
  const values: Record<string, unknown> = {}
  const errors: CoreIssue[] = []

  for (const mapping of options.mappings) {
    if (mapping.targetId === null) continue
    const target = findTarget(options.targets, mapping.targetId)
    if (target === undefined) continue

    const raw = (cells[mapping.index] ?? '').trim()
    if (raw === '') continue

    const mapped = options.valueMap?.[target.id]?.[raw] ?? raw
    const result = coerceCell(mapped, target, mapping.dateFormat, options)
    if (result.ok) values[target.id] = result.value
    else for (const one of result.issues) errors.push({ ...one, path: [target.id] })
  }

  const named = LABEL_SOURCES[options.objectType].some((slug) => {
    const value = values[slug]
    return typeof value === 'string' && value.trim() !== ''
  })
  if (!named) {
    const wanted = LABEL_SOURCES[options.objectType]
    errors.push(
      issue(
        'required',
        wanted.length === 1
          ? `A ${options.objectType} needs a ${wanted[0] as string}.`
          : `A ${options.objectType} needs a ${wanted.join(' or a ')}.`,
        [wanted[0] as string],
      ),
    )
  }

  return { values, errors }
}

interface CellResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly issues: readonly CoreIssue[]
}

function coerceCell(
  raw: string,
  target: MappingTarget,
  dateFormat: DateFormat | undefined,
  options: MapRowOptions,
): CellResult {
  // A date column is read with the format inferred over the whole column, then handed on as an
  // ISO day — so nothing downstream of here ever learns a format was involved.
  if (target.valueKind === 'date') {
    const format: DateFormat = dateFormat ?? 'iso'
    const parsed = applyDateFormat(raw, format)
    if (!parsed.ok) return { ok: false, issues: parsed.issues }
    if (target.kind !== 'attribute') return { ok: true, value: parsed.value, issues: [] }
    return runTypeCoercion(parsed.value, target, options)
  }

  if (target.valueKind === 'bool') {
    const word = raw.toLowerCase()
    if (TRUE_WORDS.has(word)) return { ok: true, value: true, issues: [] }
    if (FALSE_WORDS.has(word)) return { ok: true, value: false, issues: [] }
    return { ok: false, issues: [issue('invalid_input', `"${raw}" is not a yes or a no.`)] }
  }

  // A system column and a link's parts are plain text: the label columns, and the link's own title.
  if (target.kind !== 'attribute') return { ok: true, value: raw, issues: [] }

  return runTypeCoercion(raw, target, options)
}

/**
 * Hands the cell to the attribute type that owns it.
 *
 * A definition that is not in the map is a programmer error — the target list was built from the
 * same definitions — so it throws rather than reporting a row error the user cannot act on.
 */
function runTypeCoercion(raw: string, target: MappingTarget, options: MapRowOptions): CellResult {
  const definition = options.definitions.get(target.slug)
  if (definition === undefined) {
    throw new Error(`No attribute definition for import target ${target.id}`)
  }
  const coerced = anyTypeDef(definition.type).coerce(
    raw,
    definition.config,
    options.typeContext(definition),
  )
  return coerced.ok
    ? { ok: true, value: coerced.value, issues: [] }
    : { ok: false, issues: coerced.issues }
}
