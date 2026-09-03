import { describe, expect, it } from 'vitest'

import { VALUE_KINDS } from './kinds.ts'
import {
  ALL_SLOT_COLUMNS,
  SLOT_COLUMNS,
  VALUE_KEY_COLUMN,
  isSlotColumn,
  normColumn,
  sortColumn,
  valueColumn,
} from './slots.ts'

/**
 * The source of every file in this package, read through Vite's `import.meta.glob` rather than
 * `node:fs`: `packages/core` ships to the browser and may not import a Node builtin, and that
 * restriction is exactly what the test below exists to protect. Typed locally because the package
 * compiles with `types: []`.
 */
interface GlobbingImportMeta {
  glob(
    pattern: string,
    options: { readonly query: '?raw'; readonly import: 'default'; readonly eager: true },
  ): Record<string, string>
}

const SOURCES = (import.meta as unknown as GlobbingImportMeta).glob('../**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

// Keys come back relative to this directory, e.g. `./slots.ts` and `../fields/system.ts`.
const OWNED_BY_THIS_FILE = ['./slots.ts', './slots.test.ts']

describe('slot columns', () => {
  it('names the value column of every value kind, and no two share one', () => {
    for (const kind of VALUE_KINDS) expect(valueColumn(kind)).toBe(SLOT_COLUMNS[kind].value)
    expect(new Set(VALUE_KINDS.map(valueColumn)).size).toBe(VALUE_KINDS.length)
  })

  it('offers a sort column for every kind that sorts on a slot, and none for the others', () => {
    expect(sortColumn('text')).toBe(SLOT_COLUMNS.text.sort)
    expect(sortColumn('number')).toBe(SLOT_COLUMNS.number.sort)
    expect(sortColumn('date')).toBe(SLOT_COLUMNS.date.sort)
    expect(sortColumn('bool')).toBe(SLOT_COLUMNS.bool.sort)
    // `option` sorts by the option's position; `relation` does not sort at all.
    expect(sortColumn('option')).toBeUndefined()
    expect(sortColumn('relation')).toBeUndefined()
  })

  it('offers a normalised column for text only', () => {
    expect(normColumn('text')).toBe(SLOT_COLUMNS.text.norm)
    for (const kind of VALUE_KINDS.filter((k) => k !== 'text')) {
      expect(normColumn(kind)).toBeUndefined()
    }
  })

  it('lists every physical column exactly once', () => {
    expect(new Set(ALL_SLOT_COLUMNS).size).toBe(ALL_SLOT_COLUMNS.length)
    for (const kind of VALUE_KINDS) expect(ALL_SLOT_COLUMNS).toContain(valueColumn(kind))
    expect(ALL_SLOT_COLUMNS).toContain(VALUE_KEY_COLUMN)
    expect(isSlotColumn(VALUE_KEY_COLUMN)).toBe(true)
    expect(isSlotColumn('display_name')).toBe(false)
  })

  it('is frozen, so nothing can rewrite the allowlist at runtime', () => {
    expect(Object.isFrozen(ALL_SLOT_COLUMNS)).toBe(true)
  })
})

describe('no hard-coded columns', () => {
  // CLAUDE.md states this rule in prose. A comment is not a mechanism; this is.
  const BANNED =
    /\b(text_value|text_norm|text_sort|num_value|date_value|bool_value|option_id|target_record_id|value_key)\b/

  it('scans the package it is supposed to be scanning', () => {
    // Without this the grep below would pass vacuously if the glob ever stopped matching.
    const paths = Object.keys(SOURCES)
    expect(paths.length).toBeGreaterThan(10)
    expect(paths).toContain('./registry.ts')
    expect(paths).toContain('../fields/system.ts')
  })

  it('mentions a physical value column nowhere else in packages/core', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !OWNED_BY_THIS_FILE.includes(path))
      .flatMap(([path, source]) =>
        source
          .split('\n')
          .map((text, index) => ({ text, line: index + 1 }))
          .filter((entry) => BANNED.test(entry.text))
          .map((entry) => `${path}:${String(entry.line)}`),
      )

    expect(offenders).toEqual([])
  })
})
