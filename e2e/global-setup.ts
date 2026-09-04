/**
 * Runs once, before any spec: prove the two things whose absence produces a baffling failure later,
 * then read the migrated database's baseline so the per-test reset has something to restore.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { captureE2eBaseline, requireE2eDatabaseUrl } from '@mutuals/db/test-support'

const DIST_INDEX = fileURLToPath(new URL('../apps/web/dist/index.html', import.meta.url))

export default async function globalSetup(): Promise<void> {
  if (!existsSync(DIST_INDEX)) {
    throw new Error(
      'apps/web/dist/index.html is missing, so `vite preview` would serve an empty directory ' +
        'and every spec would fail on a blank page.\n' +
        'Run `pnpm verify:e2e`, which builds first — or `pnpm build` then `pnpm test:e2e`.',
    )
  }

  // Reading it here rather than letting the first spec fail: "E2E_DATABASE_URL is not set" is a
  // sentence somebody can act on, and a Playwright timeout on a blank page is not.
  requireE2eDatabaseUrl()

  await captureE2eBaseline()
}
