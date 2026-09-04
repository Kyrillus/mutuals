/**
 * `@mutuals/db` — the schema, the migrations, the filter compiler, the write path and every
 * repository. The only package that talks to Postgres.
 *
 * `apps/api` imports from here and from `@mutuals/core`, and from nothing else. The dependency
 * graph runs one way: core knows nothing about this package, and ESLint enforces it.
 *
 * A pure re-export barrel: nothing is defined here.
 */

// The pool, the Kysely instance and the two settings that make a plan deterministic.
export * from './client.ts'

// Migrations: the provider, the runner, and the boot check that refuses to serve a database the
// checkout disagrees with.
export * from './migrate.ts'

// The Kysely interface, the enums and the closed sets, all derived from one declaration.
export * from './schema.ts'

// `db:reproject` and the per-record digest that is the whole safety argument for keeping a
// projection at all (ADR-025).
export * from './reproject.ts'

// The filter model compiled to SQL. The model itself lives in `@mutuals/core`; only the compiler
// is here (ADR-033).
export * from './filter/compile.ts'
export * from './filter/list.ts'
export * from './filter/sort.ts'

// The write path. Every mutation goes through these; nothing writes `attribute_value` by hand.
export * from './write/facts.ts'
export * from './write/identifiers.ts'
export * from './write/organizations.ts'
export * from './write/records.ts'
export * from './write/value-key.ts'
export * from './write/workspace.ts'
// `FactSource` is re-exported by `write/types.ts` for the write path's own callers and by
// `schema.ts` as part of the database interface. One star export of each would be ambiguous, so
// the vocabulary types are named here and the enum comes from `schema.ts` above.
export { WriteError } from './write/types.ts'
export type { AttributeShape, Executor, Provenance } from './write/types.ts'

// Background jobs: the three-method port (ADR-058) and its only implementation. Nothing outside
// `jobs/pg-boss.ts` imports pg-boss, which is what makes R7's mitigation real.
export * from './jobs/queue.ts'
export * from './jobs/pg-boss.ts'

// Repositories: a database row in, a domain object out.
export * from './repositories/attributes.ts'
export * from './repositories/coerce.ts'
export * from './repositories/interactions.ts'
export * from './repositories/duplicates.ts'
export * from './repositories/imports.ts'
export * from './repositories/records.ts'
export * from './repositories/views.ts'

// The derived columns of §4.7. `apps/api` recomputes them, scoped, whenever an interaction moves
// them; the seed and the eventual nightly sweep call the same function unscoped (ADR-092).
export { recomputeMetrics } from './seed/metrics.ts'
export { sweepIfStale } from './seed/stale-sweep.ts'
export type { StaleSweepOptions, StaleSweepResult } from './seed/stale-sweep.ts'
export type { MetricsOptions, MetricsResult } from './seed/metrics.ts'
