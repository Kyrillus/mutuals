/**
 * The middleware slot (§7, ADR-029).
 *
 * The claim is not "auth works" — there is none. It is that adding a bearer check later touches no
 * handler, and that rests on one Fastify property: a hook added to the *root* instance runs for
 * routes registered afterwards inside child plugins. That property is what this file proves, with a
 * second hook standing in for the check that does not exist yet.
 */
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import { authenticate, registerAuth } from './auth.ts'

describe('registerAuth', () => {
  it('reaches a route registered later, inside a prefixed child plugin', async () => {
    const app = Fastify({ logger: false })
    registerAuth(app)

    const seen: string[] = []
    app.addHook('onRequest', (request, _reply, done) => {
      seen.push(request.url)
      done()
    })

    await app.register(
      // eslint-disable-next-line @typescript-eslint/require-await -- a plugin is async by contract.
      async (child) => {
        child.get('/contacts', () => ({ ok: true }))
      },
      { prefix: '/api/v1' },
    )

    const response = await app.inject({ method: 'GET', url: '/api/v1/contacts' })
    expect(response.statusCode).toBe(200)
    expect(seen).toEqual(['/api/v1/contacts'])
    await app.close()
  })

  it('lets every request through, because Phase 1 has no authentication', async () => {
    await expect(
      authenticate(
        {} as Parameters<typeof authenticate>[0],
        {} as Parameters<typeof authenticate>[1],
      ),
    ).resolves.toBeUndefined()
  })
})
