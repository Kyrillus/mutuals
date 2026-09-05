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
/** The stand-in model provider (`support/model-stub.mjs`); 3202 for the same reason 3200/3201 are. */
const MODEL_STUB_PORT = Number(process.env.MODEL_STUB_PORT ?? 3202)

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
      /**
       * The model, faked one HTTP hop out (`support/model-stub.mjs`).
       *
       * Started before the API so `LLM_BASE_URL` resolves on the first question. Everything below
       * the socket stays real: the transport, the strict `response_format`, the Zod re-validation,
       * the filter compiler and the `llm_call` trace.
       */
      command: 'node support/model-stub.mjs',
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      url: `http://127.0.0.1:${String(MODEL_STUB_PORT)}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { MODEL_STUB_PORT: String(MODEL_STUB_PORT) },
    },
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
        // §4.8's routes, pointed at the stub. The key is required by `availability()` and is never
        // sent anywhere real — the base URL is a loopback address.
        LLM_MODE: 'live',
        LLM_BASE_URL: `http://127.0.0.1:${String(MODEL_STUB_PORT)}`,
        OPENROUTER_API_KEY: 'e2e-not-a-real-key',
        // The cap is exercised by its own integration test. Leaving it on here would make the
        // suite's greenness depend on how many questions previous specs happened to ask.
        LLM_DAILY_COST_LIMIT_USD: '0',
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
