import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// Relative, not `@/`: the root `vitest.config.ts` resolves no alias, and this test has to run
// under `pnpm test:unit` like every other one.
import { CHIP_COLORS } from '../ui/chip-colors.ts'
import { contrastRatio, oklchToSrgb, parseOklch, toHex } from './oklch.ts'

// Read, not imported. Vitest replaces a CSS import with an empty string unless `css` is enabled,
// so `./globals.css?raw` compiles and then silently asserts nothing at all.
const globalsCss = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8')

/**
 * The test ADR-056 said it was not writing.
 *
 * ADR-056 claimed its pairs had been contrast-checked — light 6.06:1 to 8.20:1, dark 7.55:1 to
 * 8.62:1 — and in the same breath recorded that no automated check existed. Re-deriving those
 * numbers reproduced the chip figures exactly and found a real failure in the semantic set:
 * `--muted-foreground` cleared white at 4.85:1 but only reached 4.45:1 on `--muted`, which is the
 * surface it is most often read on (a zebra row, a disabled input, the sidebar). It has been
 * darkened, and now this file is what keeps the claim honest.
 *
 * It parses the shipped stylesheet rather than a table of values copied out of it, because a
 * duplicated table is a table that drifts: the only palette that matters is the one in the file
 * the browser loads.
 */

/**
 * One top-level block, by the exact text that opens it. None of the four blocks this file reads
 * nests another, so the first `}` in column one ends it.
 */
function readBlock(opener: string): string {
  const start = globalsCss.indexOf(`\n${opener} {`)
  expect(start, `globals.css has no top-level "${opener}" block`).toBeGreaterThan(-1)
  const end = globalsCss.indexOf('\n}', start)
  expect(end, `the "${opener}" block is not closed`).toBeGreaterThan(start)
  return globalsCss.slice(start, end)
}

const DECLARATION = /--([\w-]+):\s*([^;]+);/g

function colorTokens(block: string): Map<string, string> {
  const tokens = new Map<string, string>()
  for (const [, name, value] of block.matchAll(DECLARATION)) {
    if (name === undefined || value === undefined) continue
    if (parseOklch(value) !== null) tokens.set(name, value.trim())
  }
  return tokens
}

const light = colorTokens(readBlock(':root'))
const dark = colorTokens(readBlock('.dark'))

function ratio(tokens: Map<string, string>, foreground: string, background: string): number {
  const fg = tokens.get(foreground)
  const bg = tokens.get(background)
  expect(fg, `--${foreground} is missing or is not an oklch() value`).toBeDefined()
  expect(bg, `--${background} is missing or is not an oklch() value`).toBeDefined()

  const parsedFg = parseOklch(fg ?? '')
  const parsedBg = parseOklch(bg ?? '')
  if (parsedFg === null || parsedBg === null) throw new Error('unreachable: filtered above')

  return contrastRatio(oklchToSrgb(parsedFg), oklchToSrgb(parsedBg))
}

/**
 * Every pair a person actually reads text through, named by what renders it. This is the list the
 * palette is designed against; adding a surface to the app means adding its pair here.
 */
const TEXT_PAIRS: readonly (readonly [foreground: string, background: string])[] = [
  ['foreground', 'background'], // body copy
  ['muted-foreground', 'background'], // labels, placeholders, empty cells
  ['card-foreground', 'card'], // stat cards, the dashboard grid
  ['popover-foreground', 'popover'], // menus, combobox lists, toasts
  ['primary-foreground', 'primary'], // the black "+ Add new" button
  ['secondary-foreground', 'secondary'], // secondary buttons
  ['muted-foreground', 'muted'], // a placeholder on a zebra row — the one that failed
  ['accent-foreground', 'accent'], // hovered and selected menu rows
  ['destructive-foreground', 'destructive'], // the confirm button of a delete dialog
  ['sidebar-foreground', 'sidebar'], // navigation
  ['sidebar-accent-foreground', 'sidebar-accent'], // the active nav item
  ['sidebar-primary-foreground', 'sidebar-primary'],
  ['primary', 'background'], // links, and the accent used as text
  ['primary', 'card'],
  ['destructive', 'background'], // §6.4 renders an overdue date as red text, not as a button
  ['destructive', 'card'],
  ['foreground', 'card'],
  ['foreground', 'muted'],
  ['foreground', 'sidebar'],
  ['muted-foreground', 'sidebar'], // section headings in the navigation
  ['muted-foreground', 'card'],
]

/** WCAG AA for body text. Chips and table cells are 11–13px, so the large-text 3:1 never applies. */
const MINIMUM_RATIO = 4.5

describe.each([
  ['light', light],
  ['dark', dark],
])('%s theme', (theme, tokens) => {
  it.each(TEXT_PAIRS)(`--%s on --%s clears ${MINIMUM_RATIO}:1`, (foreground, background) => {
    const measured = ratio(tokens, foreground, background)
    expect(
      measured,
      `--${foreground} on --${background} is ${measured.toFixed(2)}:1 in ${theme}`,
    ).toBeGreaterThanOrEqual(MINIMUM_RATIO)
  })

  it.each(CHIP_COLORS)(`the %s chip clears ${MINIMUM_RATIO}:1`, (color) => {
    const measured = ratio(tokens, `chip-${color}-fg`, `chip-${color}-bg`)
    expect(
      measured,
      `the ${color} chip is ${measured.toFixed(2)}:1 in ${theme}`,
    ).toBeGreaterThanOrEqual(MINIMUM_RATIO)
  })
})

describe('the palette itself', () => {
  it('defines a dark value for every colour the light theme declares', () => {
    const missing = [...light.keys()].filter((name) => !dark.has(name))
    expect(missing, 'these tokens would keep their light value in dark mode').toEqual([])
  })

  it('gives every chip colour both halves of its pair, and invents no twelfth', () => {
    const declared = [...light.keys()]
      .filter((name) => name.startsWith('chip-'))
      .map((name) => name.replace(/^chip-/, '').replace(/-(?:bg|fg)$/, ''))

    expect(new Set(declared)).toEqual(new Set(CHIP_COLORS))
    // Two halves each, and nothing that is neither a -bg nor an -fg.
    expect(declared).toHaveLength(CHIP_COLORS.length * 2)
  })

  it('resolves every var() the theme block forwards', () => {
    // `@theme inline` is what makes a utility read through a var the `.dark` block can rewrite.
    // A misspelt name there does not error: the utility resolves to nothing and the element
    // renders transparent, which is a bug you find by looking rather than by building.
    const declared = new Set(
      [':root', '@theme'].flatMap((block) =>
        [...readBlock(block).matchAll(DECLARATION)].map(([, name]) => name),
      ),
    )

    const unresolved = [...readBlock('@theme inline').matchAll(/var\(--([\w-]+)\)/g)]
      .map(([, name]) => name)
      .filter((name) => name !== undefined && !declared.has(name))

    expect([...new Set(unresolved)]).toEqual([])
  })
})

/**
 * Not an assertion — a receipt. `vitest --reporter=verbose` prints the table so the numbers in the
 * ADR can be checked against the palette that shipped rather than the palette that was proposed.
 */
describe('measured ratios', () => {
  it('reports the full table', () => {
    const rows: string[] = []
    for (const [theme, tokens] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      for (const [fg, bg] of TEXT_PAIRS) {
        rows.push(`${theme} --${fg} on --${bg}: ${ratio(tokens, fg, bg).toFixed(2)}:1`)
      }
      for (const color of CHIP_COLORS) {
        const parsed = parseOklch(tokens.get(`chip-${color}-fg`) ?? '')
        const hex = parsed === null ? '?' : toHex(oklchToSrgb(parsed))
        rows.push(
          `${theme} chip ${color} (${hex}): ${ratio(
            tokens,
            `chip-${color}-fg`,
            `chip-${color}-bg`,
          ).toFixed(2)}:1`,
        )
      }
    }
    expect(rows).toHaveLength((TEXT_PAIRS.length + CHIP_COLORS.length) * 2)
  })
})
