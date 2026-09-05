/**
 * The application surface itself: the docs, the auth slot, the boot check, and the Stage-6 501s.
 *
 * It is an integration test rather than a unit test because two of the four claims — that the boot
 * check passes against a migrated database, and that it *fails* against one that is behind — are
 * only meaningful with a real schema in front of them.
 */
import { assertSchemaCurrent, SchemaBehindError } from '@mutuals/db'
import { testDb } from '@mutuals/db/test-support'
import { describe, expect, it } from 'vitest'

import { OPENAPI_ROUTE } from './app.ts'
import { DOCS_PREFIX } from './plugins/auth.ts'
import { api, getTestApp } from './test-support/app.ts'
import { OPERATIONS } from './routes/operations.ts'

describe('the documentation', () => {
  it('serves the raw OpenAPI 3.1 document', async () => {
    const { status, body } = await api.get<{
      openapi: string
      paths: Record<string, Record<string, { operationId?: string }>>
    }>(OPENAPI_ROUTE)
    expect(status).toBe(200)
    expect(body.openapi).toBe('3.1.0')
    const ids = Object.values(body.paths).flatMap((methods) =>
      Object.values(methods).flatMap((operation) => operation.operationId ?? []),
    )
    expect([...ids].sort()).toEqual([...OPERATIONS].sort())
  })

  it('serves the browsable docs at /api/docs', async () => {
    const app = await getTestApp()
    const response = await app.inject({ method: 'GET', url: `${DOCS_PREFIX}/` })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
  })

  it('does not serve the document from an unversioned path', async () => {
    expect((await api.get('/openapi.json')).status).toBe(404)
  })
})

describe('the middleware slot', () => {
  it('refuses nothing yet, so every route still answers with it installed', async () => {
    // §7 asks for a slot, not for auth. That the hook actually reaches a route registered in a
    // child plugin is proved in `plugins/auth.test.ts`; here it only has to stay out of the way.
    expect((await api.get('/api/v1/stats')).status).toBe(200)
    expect((await api.get('/api/v1/contacts')).status).toBe(200)
  })
})

describe('the Stage-6 operations', () => {
  /**
   * `ask` is built (§4.8) and has its own suite in `routes/ask.db.test.ts`. These two are the
   * second half's, and they keep answering the documented 501 they have answered since Stage 1 —
   * which is the point of ADR-031's list: the surface is reviewable before the engine is fitted.
   */
  for (const [method, url, payload] of [
    ['GET', '/api/v1/search?q=anna', undefined],
    ['POST', '/api/v1/quick-capture', { text: 'Met Anna at Bits & Pretzels' }],
  ] as const) {
    it(`answers a documented 501 for ${method} ${url}`, async () => {
      const app = await getTestApp()
      const response = await app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      })
      expect(response.statusCode).toBe(501)
      expect(response.headers['content-type']).toContain('application/problem+json')
      const problem = JSON.parse(response.body) as { type: string; detail: string }
      expect(problem.type).toContain('#not_implemented')
      expect(problem.detail).toContain('Stage 6')
    })
  }

  it('validates an ask before spending anything on it', async () => {
    // A 400 from the schema, not a model call: an empty question costs nothing to refuse.
    const { status } = await api.post('/api/v1/ask', { question: '' })
    expect(status).toBe(400)
  })
})

describe('unknown routes and methods', () => {
  it('answers problem+json for an unknown path', async () => {
    const { status, body, contentType } = await api.get<{ type: string; detail: string }>(
      '/api/v1/nope',
    )
    expect(status).toBe(404)
    expect(contentType).toContain('application/problem+json')
    expect(body.detail).toContain('No route for GET /api/v1/nope')
  })

  it('answers problem+json for a body that is not JSON', async () => {
    const app = await getTestApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/contacts',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })
    expect(response.statusCode).toBe(400)
    expect(response.headers['content-type']).toContain('application/problem+json')
  })
})

/** Aborts a transaction that only existed to observe a failure. */
class RollBack extends Error {
  override readonly name = 'RollBack'
}

describe('the boot check', () => {
  it('passes against a migrated database', async () => {
    await expect(assertSchemaCurrent(testDb())).resolves.toBeUndefined()
  })

  it('refuses to serve a database that is behind, and says which migration is missing', async () => {
    // ADR-028: a check, never a mutation. Deleting the newest ledger row is the cheapest way to
    // make the database *look* behind without touching the schema, and the transaction is rolled
    // back afterwards so the worker's clone is untouched.
    let thrown: unknown
    let missing = ''
    await testDb()
      .transaction()
      .execute(async (trx) => {
        const newest = await trx
          .selectFrom('kysely_migration')
          .select('name')
          .orderBy('name', 'desc')
          .limit(1)
          .executeTakeFirstOrThrow()
        missing = newest.name
        await trx.deleteFrom('kysely_migration').where('name', '=', newest.name).execute()
        try {
          await assertSchemaCurrent(trx)
        } catch (error) {
          thrown = error
        }
        // Roll back, so nothing here is visible to the next test in this worker.
        throw new RollBack()
      })
      .catch((error: unknown) => {
        if (!(error instanceof RollBack)) throw error
      })

    expect(thrown).toBeInstanceOf(SchemaBehindError)
    expect((thrown as SchemaBehindError).missing).toEqual([missing])
    // The message is an instruction, not a stack trace.
    expect((thrown as Error).message).toContain('Run: pnpm db:migrate')
  })
})
