/**
 * `@mutuals/core/contracts` — every request and response schema the API speaks.
 *
 * ADR-030 deleted client codegen: these schemas are the single declaration. `apps/api` implements
 * them and emits `docs/openapi.json` from them; `apps/web` imports the inferred types and parses
 * responses with the same objects. There is no generated file in the frontend's build path and no
 * second copy of the shapes to drift.
 *
 * A pure re-export barrel: nothing is defined here.
 */

export * from './primitives.ts'
export * from './shared.ts'
export * from './problem.ts'
export * from './envelope.ts'
export * from './list-query.ts'
export * from './attributes.ts'
export * from './records.ts'
export * from './interactions.ts'
export * from './follow-ups.ts'
export * from './imports.ts'
export * from './merge.ts'
export * from './misc.ts'
