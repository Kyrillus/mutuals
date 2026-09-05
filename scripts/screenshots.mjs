#!/usr/bin/env node
/**
 * Regenerates the README screenshots into `docs/screenshots/`.
 *
 * They are committed rather than generated on demand, because a README on GitHub cannot run
 * anything — but they go stale silently, which is the usual fate of screenshots in a repository.
 * So this exists: `pnpm screenshots` against a seeded database reproduces the whole set, and the
 * git diff shows what actually changed.
 *
 * Needs `pnpm dev` running and the database seeded. Both themes are captured, because both ship.
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = join(root, 'docs', 'screenshots')

// Playwright is a dependency of the `e2e` workspace package, not of the root, so resolve it from
// there rather than adding a second copy to the root just to take pictures.
const require = createRequire(join(root, 'e2e', 'package.json'))
const { chromium } = require('@playwright/test')

const WEB = process.env.WEB_URL ?? 'http://localhost:3000'
const API = process.env.API_URL ?? 'http://localhost:3001'

const shots = [
  { name: 'contacts', path: '/contacts', theme: 'light' },
  { name: 'contact-detail', path: null, theme: 'light' },
  { name: 'attributes', path: '/settings/contacts/attributes', theme: 'light' },
  { name: 'dashboard', path: '/', theme: 'dark' },
  { name: 'follow-ups', path: '/follow-ups', theme: 'dark' },
]

async function main() {
  const response = await fetch(`${API}/api/v1/contacts?limit=60`).catch(() => null)
  if (!response?.ok) {
    console.error(`\nCannot reach the API at ${API}. Run \`pnpm dev\` first.\n`)
    process.exit(1)
  }
  const { data } = await response.json()

  // The fullest contact rather than the first one with a pulse. A detail page whose right column is
  // mostly em-dashes is an honest screenshot and a bad advertisement, and the reader cannot tell the
  // difference between "this field is empty" and "this product has nothing to show".
  const score = (c) =>
    Object.values(c.attributes ?? {}).filter((v) => v != null).length +
    (c.interactionCount12m ?? 0) * 2 +
    (c.openFollowups ?? 0) * 3
  const subject = [...data].sort((a, b) => score(b) - score(a))[0]
  const detail = shots.find((s) => s.name === 'contact-detail')
  if (detail) detail.path = `/contacts/${subject.id}`

  mkdirSync(out, { recursive: true })
  const browser = await chromium.launch()

  for (const shot of shots) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: shot.theme,
    })
    // The app reads its own stored preference before first paint, so setting the OS-level scheme
    // alone would leave it on whatever the last run wrote.
    await context.addInitScript((theme) => {
      try {
        localStorage.setItem('mutuals.theme', theme)
      } catch {
        /* private mode: the colorScheme above still applies */
      }
    }, shot.theme)

    const page = await context.newPage()
    await page.goto(`${WEB}${shot.path}`, { waitUntil: 'networkidle' })
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: join(out, `${shot.name}.png`) })
    console.log(`  ${shot.name}.png  ${shot.theme.padEnd(5)} ${shot.path}`)
    await context.close()
  }

  await browser.close()
  console.log(`\nWrote ${shots.length} screenshots to docs/screenshots/\n`)
}

await main()
