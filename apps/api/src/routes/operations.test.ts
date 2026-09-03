/**
 * Route ↔ operation-list parity (ADR-031).
 *
 * This is the machine half of §7's "every operation the UI performs is one well-named API
 * operation". No test can prove the human half — that a UI action exists for which no operation
 * does — so `operations.ts` stays the reviewable artifact, and this file proves the two things a
 * machine can: nothing is registered without a name, and no name is left behind by a deleted route.
 *
 * It needs no database. `buildApp` only reads schemas while registering; the context is not touched
 * until a request arrives.
 */
import { describe, expect, it } from 'vitest'

import { API_PREFIX, OPENAPI_ROUTE, buildApp, type App } from '../app.ts'
import { DOCS_PREFIX } from '../plugins/auth.ts'
import { parseEnv } from '../env.ts'
import { OPERATIONS, PLANNED_OPERATIONS } from './operations.ts'

/**
 * The only routes allowed to carry no operation id: the raw document, and everything
 * `@fastify/swagger-ui` mounts to serve the docs page (its static assets included).
 */
function isDocumentationRoute(url: string): boolean {
  return url === OPENAPI_ROUTE || url === DOCS_PREFIX || url.startsWith(`${DOCS_PREFIX}/`)
}

let cached: Promise<App> | undefined

function app(): Promise<App> {
  cached ??= buildApp(
    {
      db: undefined as never,
      env: parseEnv({
        DATABASE_URL: 'postgres://unused@localhost:5432/unused',
        NODE_ENV: 'test',
      }),
      now: () => new Date(0),
    },
    { logger: false },
  )
  return cached
}

async function registered(): Promise<{ named: string[]; unnamed: string[] }> {
  const instance = await app()
  const named: string[] = []
  const unnamed: string[] = []
  for (const route of instance.routeOperations) {
    // Fastify registers a HEAD twin for every GET; it shares the schema and is not a second
    // operation.
    if (route.method === 'HEAD') continue
    if (route.operationId === undefined) unnamed.push(`${route.method} ${route.url}`)
    else named.push(route.operationId)
  }
  return { named, unnamed }
}

describe('the operation list', () => {
  it('has no duplicates and no empty names', () => {
    expect(new Set(OPERATIONS).size).toBe(OPERATIONS.length)
    for (const name of OPERATIONS) expect(name.trim()).not.toBe('')
  })

  it('is disjoint from the operations later stages will register', () => {
    const planned = new Set<string>(PLANNED_OPERATIONS)
    expect(OPERATIONS.filter((name) => planned.has(name))).toEqual([])
  })

  it('names every registered route, and every name is registered', async () => {
    const { named } = await registered()
    expect([...named].sort()).toEqual([...OPERATIONS].sort())
  })

  it('leaves only the documentation routes unnamed', async () => {
    const { unnamed } = await registered()
    for (const route of unnamed) {
      const url = route.slice(route.indexOf(' ') + 1)
      expect(isDocumentationRoute(url), `${route} has no operationId`).toBe(true)
    }
  })

  it('serves every operation under the versioned prefix', async () => {
    const instance = await app()
    for (const route of instance.routeOperations) {
      if (route.operationId === undefined) continue
      expect(route.url.startsWith(API_PREFIX), `${route.url} is not under ${API_PREFIX}`).toBe(true)
    }
  })
})

describe('the OpenAPI document', () => {
  it('is OpenAPI 3.1, because 3.1 is JSON Schema (ADR-029)', async () => {
    const document = (await app()).swagger() as { openapi: string }
    expect(document.openapi).toBe('3.1.0')
  })

  it('publishes no security scheme, because no operation enforces one (ADR-029)', async () => {
    const document = (await app()).swagger() as {
      components?: { securitySchemes?: unknown }
      security?: unknown
    }
    expect(document.components?.securitySchemes).toBeUndefined()
    expect(document.security).toBeUndefined()
  })

  it('carries every operation id exactly once', async () => {
    const document = (await app()).swagger() as {
      paths: Record<string, Record<string, { operationId?: string }>>
    }
    const ids = Object.values(document.paths).flatMap((methods) =>
      Object.values(methods).flatMap((operation) => operation.operationId ?? []),
    )
    expect([...ids].sort()).toEqual([...OPERATIONS].sort())
  })

  it('references the shared schemas instead of inlining them', async () => {
    const document = (await app()).swagger() as {
      paths: Record<string, Record<string, unknown>>
      components: { schemas: Record<string, unknown> }
    }
    expect(Object.keys(document.components.schemas)).toContain('Contact')
    expect(Object.keys(document.components.schemas)).toContain('Problem')
    const contactGet = JSON.stringify(document.paths['/api/v1/contacts/{id}']?.['get'])
    expect(contactGet).toContain('#/components/schemas/Contact')
  })
})
