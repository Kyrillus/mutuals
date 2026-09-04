/**
 * The create/edit form, as data — everything the dialog does to a draft, with no React in sight.
 *
 * The dialog itself then holds one `AttributeDraft` in `useState` and calls these, which is what
 * makes the rules testable in a Node test runner: `apps/web`'s unit tests are `.test.ts` files with
 * no DOM (vitest's `unit` project), so anything worth asserting has to live outside a component.
 *
 * Two rules are encoded here rather than in the JSX because both are easy to get subtly wrong:
 * the slug stops following the title the moment a person edits it, and an option's `key` is its
 * identity — it follows the label only until the option has been saved, and never afterwards.
 */
import {
  MAX_SLUG_LENGTH,
  suggestSlug,
  transliterateForSlug,
  valueKindOf,
  type AttributeDefinitionDto,
  type AttributeType,
  type ObjectType,
} from '@mutuals/core'

// Relative, not `@/`: this module is covered by `draft.test.ts`, and vitest's `unit` project runs
// without the Vite config that defines the alias. Every other tested module in `apps/web` gets
// away with `@/` because it only imports *types* from there, which are erased before the runtime
// ever tries to resolve them. `CHIP_COLORS` is a value.
import { isChipColor, CHIP_COLORS, type ChipColor } from '../../../ui/chip-colors.ts'

/**
 * Which types own an option list — asked of the registry, not answered from a list of two names.
 * A thirteenth option-backed type gets the options editor by declaring `value_kind: 'option'`.
 */
export function hasOptions(type: AttributeType): boolean {
  return valueKindOf(type) === 'option'
}

export interface OptionRow {
  /** Stable React key. The server id once saved, so a row keeps its identity across a refetch. */
  readonly rowId: string
  /** Present exactly when this option exists on the server. */
  readonly id?: string
  /** The position this option has on the server, so {@link optionWrites} can see that it moved. */
  readonly savedPosition?: number
  readonly key: string
  readonly label: string
  readonly color: ChipColor
}

export interface NumberDraft {
  readonly unit: string
  /** Kept as typed text so an in-progress "1" is not rounded into meaning by `Number('')`. */
  readonly decimals: string
}

export interface RelationDraft {
  readonly targetObjectType: ObjectType
  readonly cardinality: 'one' | 'many'
}

export interface AttributeDraft {
  readonly objectType: ObjectType
  readonly title: string
  readonly slug: string
  /** Once true the slug stops following the title, for the rest of this dialog's life. */
  readonly slugEdited: boolean
  readonly type: AttributeType
  readonly group: string
  readonly description: string
  readonly options: readonly OptionRow[]
  /**
   * Options retired before this dialog opened. The editor has no verb for them — they are history
   * (ADR-016) — but {@link optionWrites} still has to know the positions they occupy, because
   * `(attribute_id, position)` is UNIQUE across archived rows too.
   */
  readonly archived: readonly OptionRow[]
  readonly number: NumberDraft
  readonly relation: RelationDraft
}

const DEFAULT_TYPE: AttributeType = 'short_text'

/** Unsaved rows need a key React can keep; a counter beats an index, which changes on a reorder. */
let rowCounter = 0

function newRowId(): string {
  rowCounter += 1
  return `new:${String(rowCounter)}`
}

export function emptyDraft(objectType: ObjectType): AttributeDraft {
  return {
    objectType,
    title: '',
    slug: '',
    slugEdited: false,
    type: DEFAULT_TYPE,
    group: '',
    description: '',
    options: [],
    archived: [],
    number: { unit: '', decimals: '' },
    relation: { targetObjectType: 'organization', cardinality: 'one' },
  }
}

/** An existing attribute, as a draft. Live options are editable; archived ones are carried. */
export function draftFromDefinition(definition: AttributeDefinitionDto): AttributeDraft {
  const base = emptyDraft(definition.objectType)
  const config = definition.config
  const rows = definition.options
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((option) => ({
      row: {
        rowId: option.id,
        id: option.id,
        savedPosition: option.position,
        key: option.key,
        label: option.label,
        color: isChipColor(option.color) ? option.color : 'gray',
      },
      archived: option.archivedAt !== null,
    }))

  return {
    ...base,
    title: definition.title,
    slug: definition.slug,
    slugEdited: true,
    type: definition.type as AttributeType,
    group: definition.group ?? '',
    description: definition.description ?? '',
    options: rows.filter((entry) => !entry.archived).map((entry) => entry.row),
    archived: rows.filter((entry) => entry.archived).map((entry) => entry.row),
    number: {
      unit: readString(config, 'unit'),
      decimals: readNumberText(config, 'decimals'),
    },
    relation: {
      targetObjectType: readObjectType(config) ?? base.relation.targetObjectType,
      cardinality: readString(config, 'cardinality') === 'many' ? 'many' : 'one',
    },
  }
}

export function setTitle(
  draft: AttributeDraft,
  title: string,
  taken: ReadonlySet<string>,
): AttributeDraft {
  if (draft.slugEdited) return { ...draft, title }
  const slug =
    title.trim() === '' ? '' : suggestSlug(title, { objectType: draft.objectType, taken })
  return { ...draft, title, slug }
}

/**
 * Emptying the field hands the suggestion back rather than leaving a required field permanently
 * blank — the only way out of "I deleted it and now nothing fills it in" that does not need a
 * second control.
 */
export function setSlug(
  draft: AttributeDraft,
  slug: string,
  taken: ReadonlySet<string>,
): AttributeDraft {
  if (slug === '') {
    return setTitle({ ...draft, slug: '', slugEdited: false }, draft.title, taken)
  }
  return { ...draft, slug, slugEdited: true }
}

/** Switching to a select type opens the options editor with a row to type in, never with none. */
export function setType(draft: AttributeDraft, type: AttributeType): AttributeDraft {
  const next = { ...draft, type }
  if (hasOptions(type) && next.options.length === 0) return addOption(next)
  return next
}

export function addOption(draft: AttributeDraft): AttributeDraft {
  const used = new Set(draft.options.map((option) => option.color))
  const color = CHIP_COLORS.find((candidate) => !used.has(candidate)) ?? 'gray'
  return {
    ...draft,
    options: [...draft.options, { rowId: newRowId(), key: '', label: '', color }],
  }
}

/**
 * The label drives the key while an option is unsaved, and stops the moment it has an id: a key is
 * what the wire carries and what a saved filter was written against (ADR-031), so renaming
 * "Investor" to "Angel" must not silently invalidate a view somebody saved last month.
 */
export function setOptionLabel(
  draft: AttributeDraft,
  rowId: string,
  label: string,
): AttributeDraft {
  // `(attribute_id, key)` is unique across archived options too, so a retired "Angel" still
  // occupies the name a new option would otherwise derive.
  const taken = [...draft.options, ...draft.archived]
    .filter((other) => other.rowId !== rowId)
    .map((other) => other.key)

  return {
    ...draft,
    options: draft.options.map((option) => {
      if (option.rowId !== rowId) return option
      if (option.id !== undefined) return { ...option, label }
      return { ...option, label, key: optionKey(label, taken) }
    }),
  }
}

export function setOptionColor(
  draft: AttributeDraft,
  rowId: string,
  color: ChipColor,
): AttributeDraft {
  return {
    ...draft,
    options: draft.options.map((option) =>
      option.rowId === rowId ? { ...option, color } : option,
    ),
  }
}

export function removeOption(draft: AttributeDraft, rowId: string): AttributeDraft {
  return { ...draft, options: draft.options.filter((option) => option.rowId !== rowId) }
}

/** §4.2: for a `single_select` this order *is* the sort order, so a drag is a real edit. */
export function moveOption(draft: AttributeDraft, from: number, to: number): AttributeDraft {
  const options = draft.options
  if (from === to || from < 0 || to < 0 || from >= options.length || to >= options.length) {
    return draft
  }
  const next = options.slice()
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return draft
  next.splice(to, 0, moved)
  return { ...draft, options: next }
}

/**
 * An option's machine key, from its label.
 *
 * Not `suggestSlug`: that one also refuses the reserved *attribute* slugs, and an option called
 * "Website" or "Type" is neither a hazard nor a collision — options live in their own table, keyed
 * per attribute. The transliteration is shared, so "Größe" is `groesse` in both places.
 */
export function optionKey(label: string, taken: readonly string[]): string {
  const base = transliterateForSlug(label)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
  const seed = base === '' ? 'option' : base
  if (!taken.includes(seed)) return seed
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${seed}_${String(n)}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${seed}_${String(Date.now())}`
}

/** The `config` object for the current type, or `undefined` for the types that have none. */
export function configOf(draft: AttributeDraft): Record<string, unknown> | undefined {
  if (draft.type === 'number') {
    const unit = draft.number.unit.trim()
    const decimals = Number.parseInt(draft.number.decimals, 10)
    return {
      ...(unit === '' ? {} : { unit }),
      ...(Number.isNaN(decimals) ? {} : { decimals }),
    }
  }
  if (draft.type === 'relation') {
    return {
      targetObjectType: draft.relation.targetObjectType,
      cardinality: draft.relation.cardinality,
      // §4.3: only a link to an organization carries a job title, a from, a to and "primary".
      // It is not a question the dialog asks, because "does this link have dates?" means nothing
      // to a person who is inventing a field called "Employer".
      hasLinkMetadata: draft.relation.targetObjectType === 'organization',
    }
  }
  return undefined
}

export function createBody(draft: AttributeDraft): Record<string, unknown> {
  const config = configOf(draft)
  return {
    objectType: draft.objectType,
    title: draft.title.trim(),
    slug: draft.slug.trim(),
    type: draft.type,
    ...(config === undefined ? {} : { config }),
    group: blankToNull(draft.group),
    description: blankToNull(draft.description),
    ...(hasOptions(draft.type)
      ? { options: draft.options.map((option, index) => write(option, index)) }
      : {}),
  }
}

/**
 * The edit body.
 *
 * `slug` and `type` are absent because the API refuses them (§4.2). `config` is absent for
 * `relation` for a subtler reason: `PATCH` *merges* config and never recomputes `is_multi`, so
 * changing `cardinality` here would leave the stored `is_multi` disagreeing with the config and
 * the composite foreign key `(attribute_id, value_kind, is_multi)` would be enforcing the old
 * answer. The dialog therefore shows both relation fields disabled, with the reason.
 */
export function updateBody(draft: AttributeDraft): Record<string, unknown> {
  const config = draft.type === 'number' ? numberPatch(draft) : undefined
  return {
    title: draft.title.trim(),
    group: blankToNull(draft.group),
    description: blankToNull(draft.description),
    ...(config === undefined ? {} : { config }),
    ...(hasOptions(draft.type) ? { options: optionWrites(draft) } : {}),
  }
}

/**
 * `unit` is sent as `''` rather than omitted so clearing it actually clears it: `PATCH` merges the
 * config object, so an absent key means "leave it alone", not "remove it".
 */
function numberPatch(draft: AttributeDraft): Record<string, unknown> {
  const decimals = Number.parseInt(draft.number.decimals, 10)
  return {
    unit: draft.number.unit.trim(),
    ...(Number.isNaN(decimals) ? {} : { decimals }),
  }
}

/**
 * The option writes for one save, in the order the API must apply them.
 *
 * A straight list of final positions is rejected: `attribute_option` has a full UNIQUE on
 * `(attribute_id, position)` and the update route applies one option at a time, so swapping two
 * options collides on the first `UPDATE` — verified against the running API, which answers
 * `409 That value is already taken (ao_pos_uq)`. Parking every moved row above the current maximum
 * first, then writing the final positions, passes through no state where two rows share one.
 * New options have no id and are appended, so they never take part in the parking pass.
 */
export function optionWrites(draft: AttributeDraft): Record<string, unknown>[] {
  // Live options first, so §4.2's option order is the position order; archived ones keep their
  // relative order behind them, out of the way of the numbers the picker sorts by.
  const target = [...draft.options, ...draft.archived]
  const finals = target.map((option, index) => write(option, index))
  if (
    !target.some(
      (option, index) => option.savedPosition !== undefined && option.savedPosition !== index,
    )
  ) {
    return finals
  }

  const park = target.reduce((high, option) => Math.max(high, option.savedPosition ?? 0), 0) + 1
  const parking = target.flatMap((option, index) =>
    option.id === undefined ? [] : [write(option, park + index)],
  )
  return [...parking, ...finals]
}

function write(option: OptionRow, position: number): Record<string, unknown> {
  return {
    ...(option.id === undefined ? {} : { id: option.id }),
    key: option.key === '' ? optionKey(option.label, []) : option.key,
    label: option.label.trim(),
    color: option.color,
    position,
  }
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function readString(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

function readNumberText(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'number' ? String(value) : ''
}

const OBJECT_TYPE_KEYS = ['targetObjectType', 'target_object_type'] as const

function readObjectType(config: Record<string, unknown>): ObjectType | undefined {
  for (const key of OBJECT_TYPE_KEYS) {
    const value = config[key]
    if (value === 'contact' || value === 'organization' || value === 'interaction') return value
  }
  return undefined
}
