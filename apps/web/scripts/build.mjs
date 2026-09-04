#!/usr/bin/env node
/**
 * `vite build` on its own ships React's DEVELOPMENT JSX runtime.
 *
 * Measured: 96 `jsxDEV` calls in the production bundle. @vitejs/plugin-react chooses between
 * `jsx-runtime` and `jsx-dev-runtime` from `NODE_ENV`, and it reads that when the plugin module is
 * IMPORTED -- not from Vite's build mode, and not when the config function runs. pnpm leaves
 * NODE_ENV unset, so the plugin saw no production signal and picked the development runtime.
 *
 * Setting it inside vite.config.ts is too late, and prefixing the package script
 * (`NODE_ENV=production vite build`) does not work on Windows. So: set it, then import Vite.
 */
process.env.NODE_ENV = 'production'

const { build } = await import('vite')
await build()

// The failure this file exists to prevent is silent: the bundle still works, it is just 200 kB
// larger and slower. So the build asserts its own output rather than trusting that the line above
// kept working across a Vite or plugin upgrade.
const { readdirSync, readFileSync } = await import('node:fs')
const { join } = await import('node:path')

const assets = join(import.meta.dirname, '..', 'dist', 'assets')
const offenders = readdirSync(assets)
  .filter((name) => name.endsWith('.js'))
  .filter((name) => readFileSync(join(assets, name), 'utf8').includes('jsxDEV'))

if (offenders.length > 0) {
  console.error(
    `\nBuild produced React's DEVELOPMENT JSX runtime in: ${offenders.join(', ')}\n` +
      'NODE_ENV was not seen as "production" when @vitejs/plugin-react was imported.\n',
  )
  process.exit(1)
}
