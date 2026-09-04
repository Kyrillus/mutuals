/**
 * `@mutuals/core` — the domain, and the vocabulary every other package speaks.
 *
 * This package ships to the browser, so it depends on `zod` and
 * `libphonenumber-js` and nothing else. No Node builtins, no database, no HTTP.
 * ESLint enforces that; it is not a convention.
 *
 * A pure re-export barrel: nothing is defined here.
 */

// The attribute system. Everything the product does with user-defined fields
// starts here, and `slots.ts` is the only place physical column names exist.
export * from './attributes/definition.ts'
export * from './attributes/kinds.ts'
export * from './attributes/operators.ts'
export * from './attributes/option.ts'
export * from './attributes/registry.ts'
export * from './attributes/reserved.ts'
export * from './attributes/slots.ts'
export * from './attributes/slug.ts'
export * from './attributes/types/def.ts'

// System columns, derived columns and the resolver that tells them apart from
// a user-defined attribute.
export * from './fields/resolve.ts'
export * from './fields/system.ts'

// The filter model: one vocabulary shared by the table UI, the URL, the API
// query string and, from Stage 6, the LLM's structured output.
export * from './filters/model.ts'
export * from './filters/operators.ts'
export * from './filters/query.ts'
export * from './filters/relative.ts'

// Identity: the four normalisers that feed the identifier table, and duplicate
// matching. Identifiers decide first; names are only ever the fallback.
export * from './identity/duplicates.ts'
export * from './identity/email.ts'
export * from './identity/linkedin.ts'
export * from './identity/website.ts'

export * from './followups/recurrence.ts'
export * from './followups/state.ts'

// §6.8's import wizard: the CSV reader, the auto-mapping cascade and the date-format inference.
// The XLSX reader is not here — exceljs is a Node library, so it lives in `apps/api` and produces
// the same `string[][]` this module consumes (ADR-096).
export * from './import/automap.ts'
export * from './import/csv.ts'
export * from './import/dates.ts'
export * from './import/duplicates.ts'
export * from './import/header.ts'
export * from './import/presets.ts'
export * from './import/synonyms.ts'
export * from './import/targets.ts'

// The API contract. Request and response schemas live here, not in `apps/api`, because the
// frontend imports them instead of generating a client (ADR-030).
export * from './contracts/index.ts'

export * from './decimal.ts'
export * from './result.ts'
export * from './text/casefold.ts'
export * from './time/civil.ts'
export * from './warmth.ts'

// `identity/phone.ts` is deliberately NOT re-exported here. It pulls in
// libphonenumber-js metadata, which is the single largest thing this package
// can drag into a browser bundle, so it stays behind the `@mutuals/core/phone`
// subpath and is imported only where a phone number is actually normalised.
