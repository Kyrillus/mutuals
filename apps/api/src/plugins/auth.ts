/**
 * The authentication slot (§7, ADR-029).
 *
 * Phase 1 has no auth: each person runs their own instance and §1 says so. What §7 asks for is that
 * adding a bearer check later touches no handler — so the hook exists now, on the root instance,
 * where Fastify's inheritance makes it run for every route registered afterwards.
 *
 * Deliberately **no `bearerAuth` security scheme is published** in the OpenAPI document. Declaring
 * a scheme no operation enforces tells every generated client to send credentials that are
 * ignored, which is worse than saying nothing.
 *
 * When the day comes, the body of {@link authenticate} is the only thing that changes: read the
 * `Authorization` header, compare it, and `throw new ApiError({status: 401, …})`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

export const DOCS_PREFIX = '/api/docs'

/**
 * The check itself. Async on purpose: a real one will await a token lookup, and a signature change
 * later would be a change to every route rather than to this file.
 */
export function authenticate(_request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  return Promise.resolve()
}

export function registerAuth(app: FastifyInstance): void {
  app.addHook('onRequest', authenticate)
}
