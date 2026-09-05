/**
 * The Fastify application: one schema object per route feeding three consumers at once — the
 * validator, the serialiser and the OpenAPI document (ADR-029).
 *
 * OpenAPI **3.1**, not 3.0, because 3.1 *is* JSON Schema — the same dialect the LLM structured
 * -output path and the future MCP tool definitions want, so the document generated here is
 * directly reusable rather than a near-miss that needs converting.
 *
 * Nothing in this file opens a connection or reads the environment. `main.ts` does that and hands
 * the result in, which is what lets an integration test drive the real app over the test database
 * with `app.inject()` (ADR-075).
 */
import multipart from '@fastify/multipart'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'

import type { AppContext } from './context.ts'
import { PROBLEM_CONTENT_TYPE, asApiError, toProblem } from './errors.ts'
import { registerOpenApiSchemas } from './http/registry.ts'
import { DOCS_PREFIX, registerAuth } from './plugins/auth.ts'
import { attributeDefinitionRoutes } from './routes/attribute-definitions.ts'
import { contactRoutes } from './routes/contacts.ts'
import { followUpRoutes } from './routes/follow-ups.ts'
import { importBatchRoutes } from './routes/import-batches.ts'
import { interactionRoutes } from './routes/interactions.ts'
import { organizationRoutes } from './routes/organizations.ts'
import { recordRoutes } from './routes/records.ts'
import { settingsRoutes } from './routes/settings.ts'
import { stageSixRoutes } from './routes/stage-six.ts'
import { viewRoutes } from './routes/views.ts'

export const API_PREFIX = '/api/v1'
export const OPENAPI_ROUTE = `${API_PREFIX}/openapi.json`

/** What `operations.test.ts` reads to prove route↔list parity. */
export interface RouteRecord {
  readonly method: string
  readonly url: string
  readonly operationId: string | undefined
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route this instance registered, in registration order. */
    readonly routeOperations: readonly RouteRecord[]
  }
}

export type App = FastifyInstance

export interface BuildOptions {
  /** Off in tests; pino-pretty in development. */
  readonly logger?: boolean
}

export async function buildApp(ctx: AppContext, options: BuildOptions = {}): Promise<App> {
  const app = Fastify({
    logger:
      options.logger === false || ctx.env.NODE_ENV === 'test'
        ? false
        : ctx.env.NODE_ENV === 'development'
          ? { level: ctx.env.LOG_LEVEL, transport: { target: 'pino-pretty' } }
          : { level: ctx.env.LOG_LEVEL },
    // A filter set is a JSON array in one parameter, so the 1 MB default is generous already;
    // this only bounds a create with a very long `long_text` value.
    bodyLimit: 4 * 1024 * 1024,
  })

  const routes: RouteRecord[] = []
  app.decorate('routeOperations', routes)
  app.addHook('onRoute', (route) => {
    routes.push({
      method: Array.isArray(route.method) ? route.method.join(',') : route.method,
      url: route.url,
      operationId: route.schema?.operationId,
    })
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  app.setErrorHandler((error, request, reply) => {
    const api = asApiError(error)
    // The 500s are the ones nobody will reproduce from a problem body, so the whole error goes to
    // the log while the client gets the sanitised form.
    if (api.status >= 500) request.log.error({ err: error }, 'request failed')
    else request.log.info({ err: error, status: api.status }, 'request rejected')
    void reply.status(api.status).type(PROBLEM_CONTENT_TYPE).send(toProblem(error, request))
  })

  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .type(PROBLEM_CONTENT_TYPE)
      .send(
        toProblem(
          asApiError({
            statusCode: 404,
            code: 'not_found',
            message: `No route for ${request.method} ${request.url}.`,
          }),
          request,
        ),
      )
  })

  /**
   * §6.8's upload. Registered before the routes so `request.parts()` exists on the one route that
   * uses it; every other route stays JSON.
   *
   * The per-file limit is enforced in the route rather than here, because a rejection from this
   * plugin is a generic 413 with no detail, and the person hitting it is mid-import and deserves to
   * be told what the limit is.
   */
  await app.register(multipart, { limits: { files: 1, fields: 8 } })

  registerOpenApiSchemas()

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Mutuals API',
        version: '0.1.0',
        description:
          'The personal people CRM for the agentic era. Every operation the UI performs is one ' +
          'operation here; the web app, a CLI and an MCP server are all clients of this surface.\n\n' +
          'Lists take the filter model in `?filter=` as one URL-encoded JSON array. Errors are ' +
          'RFC 9457 `application/problem+json` with a per-field `errors` array.',
      },
      servers: [{ url: '/' }],
      tags: [
        { name: 'contacts', description: 'People (§6.2, §6.5)' },
        {
          name: 'organizations',
          description: 'Companies, funds, universities, communities (§6.3)',
        },
        { name: 'interactions', description: 'Touchpoints — the raw material for warmth (§4.1)' },
        { name: 'follow-ups', description: 'Reminders, with recurrence (§6.4)' },
        { name: 'attributes', description: 'User-defined fields (§4.2, §6.7)' },
        { name: 'views', description: 'Saved table views (§6.6)' },
        { name: 'imports', description: 'The import wizard: upload, map, review, commit (§6.8)' },
        { name: 'dashboard', description: 'Counts and the profile (§6.1, §6.6)' },
        { name: 'agent', description: 'Search, ask and quick capture — Stage 6 (§4.8)' },
      ],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  })

  await app.register(swaggerUi, {
    routePrefix: DOCS_PREFIX,
    uiConfig: { docExpansion: 'list', deepLinking: true },
  })

  // The slot, on the root instance, so every route registered below inherits it.
  registerAuth(app)

  app.get(OPENAPI_ROUTE, { schema: { hide: true } }, () => app.swagger())

  const typed = app.withTypeProvider<ZodTypeProvider>()
  await typed.register(
    async (instance) => {
      await instance.register(contactRoutes, { ctx })
      await instance.register(organizationRoutes, { ctx })
      await instance.register(recordRoutes, { ctx })
      await instance.register(interactionRoutes, { ctx })
      await instance.register(followUpRoutes, { ctx })
      await instance.register(importBatchRoutes, { ctx })
      await instance.register(attributeDefinitionRoutes, { ctx })
      await instance.register(settingsRoutes, { ctx })
      await instance.register(viewRoutes, { ctx })
      await instance.register(stageSixRoutes, { ctx })
    },
    { prefix: API_PREFIX },
  )

  await app.ready()
  return app
}
