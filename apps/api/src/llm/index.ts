/**
 * The LLM module's public face (ADR-064).
 *
 * ESLint enforces who may import from here: `packages/core` and `packages/db` never, and among the
 * routes only the ones listed by exact path in `eslint.config.js` (ADR-071). That rule is the
 * reason §4.8's "the LLM extracts, code decides" stays true in a repository future sessions will
 * edit — duplicate matching, filter compilation and warmth *cannot* reach a model, so their
 * decisions are unit-testable with no network and no fixtures.
 */
export * from './client.ts'
export * from './budget.ts'
export * from './embeddings.ts'
export * from './errors.ts'
export * from './json-schema.ts'
export * from './prompts/index.ts'
export * from './replay.ts'
export * from './settings.ts'
export * from './tasks/ask.ts'
export * from './tasks/quick-capture.ts'
export * from './tasks/summary.ts'
export * from './trace.ts'
export * from './transport.ts'
export * from './types.ts'
