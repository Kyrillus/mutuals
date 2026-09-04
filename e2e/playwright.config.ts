/**
 * Playwright, per ADR-079 and ADR-082.
 *
 * Two servers, not one: `apps/api` has no static plugin, so Fastify does not serve the SPA. The web
 * side is `vite preview` over the build `pnpm build` produced, and `vite.config.ts` gained a
 * `preview.proxy` so /api reaches Fastify from the same origin — ADR-011 rules out CORS.
 *
 * The ports are 3200/3201 rather than 3000/3001, and `reuseExistingServer` is off. A developer with
 * `pnpm dev` running would otherwise have Playwright quietly adopt those servers and drive the whole
 * suite — truncating between tests as it goes — against `mutuals_dev`.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const WEB_PORT = Number(process.env.PREVIEW_PORT ?? 3200)
const API_PORT = Number(process.env.API_PORT ?? 3201)

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://mutuals:mutuals@localhost:5432/mutuals_e2e'

export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',

  // ADR-079: one worker, no parallelism. Every spec truncates the one e2e database between tests,
  // so a second worker would be resetting the database out from under the first.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  timeout: 30_000,
  expect: { timeout: 10_000 },

  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]]
    : [['list']],

  globalSetup: './global-setup.ts',

  use: {
    baseURL: `http://127.0.0.1:${String(WEB_PORT)}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      // The built API, the same artefact `pnpm start` runs in production — not `tsx src/main.ts`.
      command: 'pnpm start',
      cwd: ROOT,
      url: `http://127.0.0.1:${String(API_PORT)}/api/docs`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PORT: String(API_PORT),
        DATABASE_URL: E2E_DATABASE_URL,
        NODE_ENV: 'production',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: 'pnpm --filter @mutuals/web exec vite preview',
      cwd: ROOT,
      url: `http://127.0.0.1:${String(WEB_PORT)}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PREVIEW_PORT: String(WEB_PORT),
        API_PORT: String(API_PORT),
        // Serving a production build. Without this the react plugin warns about NODE_ENV on every
        // run, which is noise in a CI log that people are supposed to read when something breaks.
        NODE_ENV: 'production',
      },
    },
  ],
})
