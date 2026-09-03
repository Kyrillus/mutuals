/**
 * Writes `docs/openapi.json` — the single generated artifact in the repository, and the single
 * generated-artifact CI gate (ADR-030).
 *
 * It builds the real app, so the document is what the server actually serves rather than a
 * hand-kept parallel description. No database connection is opened: route registration only reads
 * schemas, and the context is never touched until a request arrives.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { buildApp } from '../app.ts'
import { EnvSchema } from '../env.ts'

const OUTPUT = fileURLToPath(new URL('../../../../docs/openapi.json', import.meta.url))

/**
 * A context with no database. Emitting the document must work on a machine with no Postgres — it
 * runs in CI before any service is up — and `buildApp` only reads `env` while registering.
 */
const context = {
  db: undefined as never,
  env: EnvSchema.parse({
    DATABASE_URL: 'postgres://openapi@localhost:5432/openapi',
    NODE_ENV: 'test',
  }),
  now: () => new Date(0),
}

const app = await buildApp(context, { logger: false })
const document = app.swagger()
await app.close()

await writeFile(OUTPUT, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
console.log(`Wrote ${OUTPUT}`)
