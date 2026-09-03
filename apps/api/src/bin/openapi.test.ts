/**
 * `docs/openapi.json` is the one committed generated artifact (ADR-030), so it gets the one
 * generated-artifact gate: what the app emits today must equal what is on disk.
 *
 * A failure here is not a bug, it is a reminder — run `pnpm openapi` and commit the diff. Keeping
 * the document in the repository is what lets a reviewer see an API change as a diff, and what
 * lets the future MCP server, a CLI and a Python client be generated from a file rather than from
 * a running server.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildApp } from '../app.ts'
import { parseEnv } from '../env.ts'

const COMMITTED = fileURLToPath(new URL('../../../../docs/openapi.json', import.meta.url))

async function emitted(): Promise<unknown> {
  const app = await buildApp(
    {
      db: undefined as never,
      env: parseEnv({
        DATABASE_URL: 'postgres://openapi@localhost:5432/openapi',
        NODE_ENV: 'test',
      }),
      now: () => new Date(0),
    },
    { logger: false },
  )
  const document = app.swagger()
  await app.close()
  return document
}

describe('docs/openapi.json', () => {
  it('is what the app emits right now', async () => {
    const onDisk: unknown = JSON.parse(await readFile(COMMITTED, 'utf8'))
    expect(onDisk).toEqual(await emitted())
  })

  it('is committed exactly as `pnpm openapi` writes it, two-space indented with a final newline', async () => {
    const text = await readFile(COMMITTED, 'utf8')
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toBe(`${JSON.stringify(await emitted(), null, 2)}\n`)
  })
})
