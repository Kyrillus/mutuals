# DECISION: API style, type flow, query layer, migrations and the wire contract

**Status:** Proposed (Stage 0). Load-bearing for `apps/api`, `packages/contracts`, `packages/db`,
`packages/api-client` and every list view in `apps/web`.
**Consistent with:** `storage-DECISION.md` (typed EAV over an append-only fact log). Where that
document already decided something — `is empty` semantics, `ne` excludes empties, `is not one of`
includes empties, AND-only filters, opaque cursor, separate cached count, 400 for an unknown slug —
this document *implements* it and does not re-litigate it.
**Environment as measured:** macOS, Node v24.20.0, **no Docker**, **no local Postgres**, no pnpm.

---

## 0. The five decisions in one page

| # | Question | Decision | Rejected |
|---|---|---|---|
| a | API style | **REST, OpenAPI 3.1, generated from Zod 4 schemas by `fastify-type-provider-zod@7.0.0`** | tRPC (+`trpc-to-openapi`); hand-written OpenAPI YAML |
| b | Frontend types | **Generated from the emitted `openapi.json` (`openapi-typescript` → `openapi-fetch` → `openapi-react-query`); domain *runtime* schemas imported from `@mutuals/contracts`** | Import Zod schemas only and hand-write a client; a custom route-manifest client |
| c | Query layer | **Kysely 0.29.5 on `pg` 8.23.0**, schema types generated from the live database by `kysely-codegen` | Drizzle ORM 0.45.2 + drizzle-kit; raw `pg` with hand-written mappers |
| d | Migrations | **Plain numbered `.sql` files** run by Kysely's `Migrator` with a 30-line `SqlFileMigrationProvider`; **explicit `pnpm db:migrate`**, never automatic on API boot; the API **fails fast on boot** if the DB is behind | drizzle-kit generate/migrate; `node-pg-migrate`; migrate-on-boot |
| e | Wire contract | Bare object for a single resource, `{data, page, meta}` envelope for lists, opaque cursor, **RFC 9457 `application/problem+json`** errors with a per-field `errors[]` array, and **one JSON filter model** serialised into a single `?filter=` parameter | JSON:API; `{error:{…}}` bespoke shape; RSQL/FIQL grammar; `filter[0][op]=…` bracket syntax |

Plus one cross-cutting decision the above depends on:

| f | TypeScript version | **Pin `typescript@5.9.3`, not `7.0.2`** | TS 7.0.2 (`latest`); TS 6.0.3 |

---

## 1. Version pins (all checked against the live npm registry on 2026-09-03)

```jsonc
// exact versions, no ranges, in the root package.json — see §7 for why "no ranges"
{
  "fastify":                     "5.12.1",
  "fastify-type-provider-zod":   "7.0.0",
  "@fastify/swagger":            "9.8.1",
  "@fastify/swagger-ui":         "6.1.1",
  "zod":                         "4.5.4",
  "kysely":                      "0.29.5",
  "pg":                          "8.23.0",
  "pg-boss":                     "12.29.0",
  "openapi-typescript":          "7.13.0",   // devDependency
  "openapi-fetch":               "0.17.0",
  "openapi-react-query":         "0.5.4",
  "@tanstack/react-query":       "5.102.8",
  "kysely-codegen":              "0.20.0",   // devDependency
  "typescript":                  "5.9.3",    // NOT 7.0.2 — see ADR-API-07
  "vitest":                      "4.1.11",
  "@playwright/test":            "1.62.1"
}
```

Registry facts behind those pins:

- `fastify-type-provider-zod@7.0.0` (published 2026-06-24) declares peers `zod >=4.1.5`,
  `fastify ^5.5.0`, `@fastify/swagger >=9.5.1`, `openapi-types ^12.1.3`. Its README states the
  compatibility matrix explicitly: `<=4.x → zod v3`, `>=5.x <7.x → zod v4`, `>=7.x → zod v4.2+`.
  **v7 uses Zod's `.encode()`/`.decode()`, so response serialization is based on `z.output<T>`, not
  `z.input<T>`.** That is a real behavioural change if a response schema carries a transform.
- `kysely@0.29.5` (2026-08-10) requires **Node >= 22** and **TypeScript >= 5.4**, ships **ESM only**
  (no CJS), moved its ES modules from `/dist/esm/` to `/dist/`, and moved `Migrator` /
  `FileMigrationProvider` to the `kysely/migration` subpath. Node 24.20.0 satisfies this.
- `drizzle-orm@0.45.2` — the `latest` tag — was published **2026-03-27** and has not moved since,
  while the `1.0.0-rc.5` line is publishing weekly. `drizzle-kit@0.31.10` is from 2026-03-17. See
  ADR-API-03.
- `openapi-typescript@7.13.0` declares peer `typescript: ^5.x`. `typescript-eslint@8.69.0` declares
  peer `typescript: >=4.8.4 <6.1.0`. Neither admits `typescript@7.0.2`. See ADR-API-07.
- `openapi-react-query@0.5.4` declares peers `@tanstack/react-query ^5.80.0` and
  `openapi-fetch ^0.17.0` — the exact versions pinned above.

---

## ADR-API-01 — REST with OpenAPI 3.1 generated from Zod 4

### Context

§3.2 of the brief makes REST-with-generated-OpenAPI the default and demands that any tRPC proposal
explain how a REST surface still exists for the MCP server and Python scripts. §7 requires
`/api/v1`, OpenAPI at `/api/docs`, a middleware slot for a future bearer token, and — the sentence
that actually constrains the design — *"every operation the UI performs must be a single,
well-named API operation, not a sequence of UI-only calls."*

### Options

**Option 1 — REST + Zod + `fastify-type-provider-zod` (chosen).** One schema object per route feeds
three consumers at once: Fastify's validator, Fastify's serializer, and `@fastify/swagger`'s
document generator.

**Option 2 — tRPC 11.18.0 with `trpc-to-openapi@3.3.0` for a REST facade.** Real and maintained
(271k weekly downloads), but: every procedure needs `.meta({ openapi: … })` duplicating the HTTP
shape it was designed to hide; the REST facade is a *second* router with its own path/method/status
mapping that nothing forces you to keep complete; `trpc-to-openapi` adds `zod-openapi` as a third
schema-to-JSON-Schema path alongside Zod 4's own `z.toJSONSchema`; and tRPC's value — end-to-end
inference without codegen — is worth little in a monorepo where the web app can import the schema
package directly anyway. The MCP server and the Python scripts would consume the *derived* surface,
so the surface every non-TypeScript client sees would be the one with the least test coverage.

**Option 3 — hand-written `openapi.yaml` as the source, with server and client generated from it.**
The most "contract-first" option and the one that gives non-TS clients the best guarantees. Rejected
because it needs a second validation runtime (ajv against the spec) that will drift from the Zod
schemas `packages/core` needs anyway for the LLM structured-output path (§4.8 of the brief), and
because it hand-writes hundreds of lines of YAML that Zod already expresses.

### Decision

REST. One `packages/contracts` package exports Zod 4 schemas. `apps/api` registers routes with
those schemas; `@fastify/swagger` emits **OpenAPI 3.1.0**; `@fastify/swagger-ui` serves it at
`/api/docs`; the raw document is also at `/api/v1/openapi.json`.

OpenAPI **3.1**, not 3.0, deliberately: `fastify-type-provider-zod` selects the
`draft-2020-12` JSON-Schema target automatically for a document whose `openapi` field is `3.1.x`
(and `openapi-3.0` for `3.0.x`). 3.1 is the version that is actual JSON Schema, which is what the
LLM layer (§4.8) and the MCP tool definitions want — one schema dialect for the whole product
instead of OpenAPI 3.0's "almost JSON Schema" subset.

### Real bootstrap

```ts
// apps/api/src/app.ts
import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';                        // zod@4.5.4: the root export IS v4
import { ContactSchema, FilterSetSchema, ProblemSchema } from '@mutuals/contracts';

export async function buildApp() {
  const app = Fastify({
    logger: true,
    genReqId: () => crypto.randomUUID(),        // becomes `requestId` in every error body
    // Fastify 5's default query parser (fast-querystring) is FLAT: no nested objects, repeated
    // keys become arrays. That is exactly what the filter serialisation in ADR-API-06 assumes.
    // No `qs` dependency, no `querystringParser` override.
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Named components in the spec — this is what makes openapi-typescript emit
  // `components["schemas"]["Contact"]` instead of an anonymous inline blob per route.
  z.globalRegistry.add(ContactSchema,   { id: 'Contact' });
  z.globalRegistry.add(FilterSetSchema, { id: 'FilterSet' });
  z.globalRegistry.add(ProblemSchema,   { id: 'Problem' });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Mutuals API',
        version: '1.0.0',
        description:
          'The personal people CRM for the agentic era. Every operation the UI performs is a ' +
          'single named operation here. See the FilterSet schema for the filter model.',
        license: { name: 'MIT', identifier: 'MIT' },
      },
      servers: [{ url: 'http://localhost:3001', description: 'local' }],
      // §7: "leave a middleware slot so a bearer token check can be added later".
      // The scheme is DECLARED now and required by NOTHING, so adding auth later is one line here
      // plus one line in the preHandler, and zero changes in handlers or clients.
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', description: 'Not enforced in Phase 1.' },
        },
      },
      security: [],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,   // emits components/schemas from globalRegistry
  });

  await app.register(fastifySwaggerUI, { routePrefix: '/api/docs' });

  await app.register(authSlot);                   // §7 middleware slot — a no-op today
  await app.register(v1Routes, { prefix: '/api/v1' });

  app.setErrorHandler(problemErrorHandler);       // ADR-API-05
  return app;
}
```

```ts
// apps/api/src/plugins/auth-slot.ts — §7's "middleware slot", built and empty.
import fp from 'fastify-plugin';

export const authSlot = fp(async (app) => {
  app.decorateRequest('principal', null);
  app.addHook('preHandler', async (req) => {
    // Phase 1: single user, no auth. The single default workspace comes from config, never from
    // a global singleton (§9 of the brief).
    req.principal = { workspaceId: app.config.WORKSPACE_ID, kind: 'local' };
  });
});
```

### A route, in full

```ts
// apps/api/src/routes/v1/contacts.ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ContactSchema, ContactListQuerySchema, ContactListResponseSchema,
  ProblemSchema, PatchContactBodySchema,
} from '@mutuals/contracts';

export const contactRoutes: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: 'GET',
    url: '/contacts',
    schema: {
      // operationId is MANDATORY on every route (asserted in CI, see §8). It is the name the MCP
      // server, the CLI and the generated client all use. "listContacts", not "get_/contacts".
      operationId: 'listContacts',
      tags: ['contacts'],
      summary: 'List contacts with the shared filter model',
      querystring: ContactListQuerySchema,
      response: {
        200: ContactListResponseSchema,
        400: ProblemSchema.describe('Invalid filter, unknown attribute slug, or stale cursor'),
      },
    },
    handler: async (req) => listContacts(req.principal.workspaceId, req.query),
  });

  app.route({
    method: 'PATCH',
    url: '/contacts/:id',
    schema: {
      operationId: 'updateContact',
      tags: ['contacts'],
      params: z.object({ id: z.uuid() }),
      body: PatchContactBodySchema,
      response: { 200: ContactSchema, 400: ProblemSchema, 404: ProblemSchema, 409: ProblemSchema },
    },
    handler: async (req) => updateContact(req.principal.workspaceId, req.params.id, req.body),
  });
};
```

### Consequences

- One source of truth per route. A schema change is a validator change, a serializer change, a
  spec change and a client-type change in one edit.
- **Response schemas are enforced at runtime.** `isResponseSerializationError` turns "the handler
  returned the wrong shape" into a 500 with the offending issues in the log, in development *and*
  in production. That is worth more than it sounds for an app whose response shape is dynamic
  (attributes keyed by user-defined slug).
- The `z.output<T>` change in v7 is a trap for anyone adding a `.transform()` to a response schema.
  House rule, in `CLAUDE.md`: **response schemas contain no transforms** — do the transformation in
  the handler and let the schema describe the wire bytes.
- Cost: `@fastify/swagger` + `swagger-ui` is ~1.5 MB of dependencies in the API. Acceptable; it is
  the documented Fastify path and the brief asks for `/api/docs`.

### The MCP answer, concretely

The MCP server (§9, later stage) is `apps/mcp`, a thin adapter that imports
`@mutuals/api-client` and exposes one MCP tool per `operationId`, with the tool's input schema
taken from `components.schemas` in the same `openapi.json` the web app compiles against. It needs
no new endpoints because of the CI check in §8 that every UI action maps to exactly one
`operationId`. A Python client does `pip install openapi-python-client` against
`/api/v1/openapi.json` and gets the same surface.

---

## ADR-API-02 — The frontend gets its types from the generated OpenAPI document

### Context

The brief: *"Typed end-to-end (the frontend should get types from the API without hand-writing
them)."* In a TypeScript monorepo there are two honest ways to do that, and they are not the same
thing.

### Options

**Option 1 — `apps/web` imports the Zod schemas from `@mutuals/contracts` and uses `z.infer`, with
a hand-written fetch wrapper.** Zero codegen, instant feedback, runtime validation for free.
But: nothing types the *routes*. `fetch('/api/v1/contacts/' + id)` has no idea that path exists,
that it takes a `filter` query parameter, or that it can return 404. You end up hand-writing ~30
client functions — i.e. hand-writing the part the brief asked you not to hand-write — and the
OpenAPI document becomes a build artifact nobody reads, which is exactly how it rots.

**Option 2 — a route manifest in `@mutuals/contracts`** (a plain object mapping `operationId` →
`{method, path, query, body, response}`) that the Fastify app registers *from* and a ~60-line
generic client consumes. No codegen, full path/param typing, one source. Genuinely attractive.
Rejected because it is ~150 lines of bespoke type-level machinery that a new contributor has to
learn, it is a third representation of the route table alongside Fastify's and OpenAPI's, and it
does nothing to prove the emitted OpenAPI is correct.

**Option 3 — generate types from the emitted spec (chosen).**
`app.swagger()` → `openapi.json` → `openapi-typescript@7.13.0` → `packages/api-client/src/schema.d.ts`
→ `openapi-fetch@0.17.0` client → `openapi-react-query@0.5.4` hooks.

### Decision

Option 3, with one deliberate split that is worth stating precisely:

- **Transport types come from the spec.** Paths, path params, query params, request bodies,
  response bodies and status codes in `apps/web` are all typed by `paths` from
  `packages/api-client/src/schema.d.ts`.
- **Domain runtime schemas come from `@mutuals/contracts`.** `apps/web` imports the *runtime*
  `FilterSetSchema` (to build, validate and URL-serialise filters in the DataTable), the operator
  tables, and `computeWarmth` — because those are shared *logic*, not shared *transport*.

The decisive argument for Option 3 over Option 1: **the web app dogfoods the OpenAPI document.**
If the spec is wrong, incomplete, or missing a route, the web app stops compiling. The MCP server
and the Python client consume the same artifact, so their surface is verified by the app the user
actually clicks on, every day. With Option 1 the spec is only as correct as someone's diligence.

### Real wiring

```jsonc
// package.json (root) — the whole type flow, four scripts
{
  "scripts": {
    "api:spec":   "tsx apps/api/scripts/dump-openapi.ts > packages/api-client/openapi.json",
    "api:types":  "openapi-typescript packages/api-client/openapi.json -o packages/api-client/src/schema.d.ts",
    "api:check":  "pnpm api:spec && git diff --exit-code packages/api-client/openapi.json packages/api-client/src/schema.d.ts",
    "dev":        "pnpm db:migrate && pnpm api:spec && pnpm api:types && turbo run dev"
  }
}
```

```ts
// apps/api/scripts/dump-openapi.ts — no server started, no port bound
import { buildApp } from '../src/app.js';
const app = await buildApp();
await app.ready();                     // @fastify/swagger builds the document on ready()
process.stdout.write(JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
```

`fastify.swagger()` is the decorator `@fastify/swagger` adds; it returns the document as a JS
object (`{ yaml: true }` returns a YAML string instead). Both `openapi.json` and the generated
`schema.d.ts` are **committed**, so a reviewer sees the API surface change in the diff of the PR
that changes it — which is the single most useful review artifact this project can have.

```ts
// packages/api-client/src/index.ts
import createClient from 'openapi-fetch';
import createQueryClient from 'openapi-react-query';
import type { paths, components } from './schema.js';

export type Contact   = components['schemas']['Contact'];
export type FilterSet = components['schemas']['FilterSet'];
export type Problem   = components['schemas']['Problem'];

export const api = createClient<paths>({ baseUrl: import.meta.env.VITE_API_URL ?? '/' });
export const $api = createQueryClient(api);
```

```tsx
// apps/web/src/features/contacts/use-contacts.ts
import { $api } from '@mutuals/api-client';
import { serialiseFilters } from '@mutuals/contracts';   // runtime, shared with the API

export function useContacts(filters: FilterSet, sort: string, cursor?: string) {
  return $api.useQuery('get', '/api/v1/contacts', {
    params: { query: { filter: serialiseFilters(filters), sort, cursor, limit: 50 } },
  });
  // data is components['schemas']['ContactList'] | undefined
  // error is components['schemas']['Problem'] | undefined
}
```

Verified detail: `openapi-fetch@0.17.0` defaults `parseAs: "json"` and calls `response.json()`
regardless of the response `Content-Type`, so the `application/problem+json` error bodies from
ADR-API-05 deserialise correctly with no configuration. (Read from `dist/index.mjs`, lines
~179–192.)

### Consequences

- Two build steps (`api:spec`, `api:types`) sit between "change a route" and "the web app sees it".
  `pnpm dev` runs both; a watcher is not worth it for a two-person project.
- `openapi-typescript` needs the TypeScript compiler API → it pins us to TS 5.x (ADR-API-07).
- The DataTable's filter chips, the URL and the LLM all use the *same* runtime `FilterSetSchema`
  object from `@mutuals/contracts`; only its *type* also happens to appear in the spec as
  `components.schemas.FilterSet`. The two are asserted identical by a contract test:
  `expect(z.toJSONSchema(FilterSetSchema, {target:'draft-2020-12'})).toEqual(spec.components.schemas.FilterSet)`.

### Note on the DataTable (not this ADR's decision, but it lands here)

`@tanstack/react-table@9.2.4` is a breaking rewrite of v8: `useReactTable` → `useTable({features, …})`,
row models registered through `tableFeatures()` slots, `data`/`columns` readonly, renamed
pinning/sizing/sorting APIs, `column.getAggregationFn()` → `getAggregationFns()`. shadcn's
data-table docs are tracked as **not yet updated for v9** (shadcn-ui/ui issue #11389), and v9 ships
`useLegacyTable` from `@tanstack/react-table/legacy` as a v8-shaped compatibility layer. That is a
frontend decision, but it interacts with this ADR because the filter model must drive the table:
whichever is chosen, the filter state lives in `@mutuals/contracts` and is passed *into* the table,
never derived from TanStack's internal `columnFilters` state. Flagged for the frontend ADR.

---

## ADR-API-03 — Kysely 0.29.5 as the query layer, not Drizzle

### Context

This is the decision the brief flags hardest ("Drizzle is the leading candidate; justify your
pick"), and the one where `storage-DECISION.md` most constrains the answer. That document commits
to a schema containing:

- a composite foreign key `(attribute_id, value_kind, is_multi) REFERENCES attribute_definition
  (id, value_kind, is_multi)` — an FK to a **non-primary-key** unique constraint,
- `UNIQUE NULLS NOT DISTINCT` (PG15+) on five tables,
- six **partial** indexes and one **partial unique** index,
- a multicolumn GIN mixing a `btree_gin` uuid opclass with `gin_trgm_ops`,
- a `text COLLATE "C"` column,
- a `tsvector GENERATED ALWAYS AS (...) STORED` column and a `vector(1536)` column,
- a `plpgsql` projector function and four triggers,
- and a read path that is three hand-shaped queries with one correlated `EXISTS` per filter chip.

And a hard requirement from §3.2: *"Migrations must be versioned, in the repo and reproducible."*

### Options

**Option 1 — Drizzle ORM 0.45.2 + drizzle-kit 0.31.10.** The brief's default.

**Option 2 — Kysely 0.29.5 on `pg` 8.23.0 (chosen).**

**Option 3 — raw `pg` with hand-written SQL strings and hand-written row mappers.**

### Why not Drizzle

Not because Drizzle is bad — it is excellent, 20.3M weekly downloads, and it would work. Because of
a structural mismatch with the schema that has already been decided:

1. **The TS schema would be a partial lie.** `storage-DECISION.md` already concedes the point:
   *"Anything drizzle-kit 0.31.x cannot express … is a hand-authored `.sql` file under drizzle-kit's
   numbering."* By my count that is the composite FK, the `NULLS NOT DISTINCT` constraints, the
   partial unique index, the mixed-opclass GIN, the generated tsvector column, the projector
   function and all four triggers — i.e. **the constraints that make the design safe**. Those are
   invisible in `schema.ts`. And an object drizzle-kit does not know about is an object
   `drizzle-kit generate` will happily propose to drop on the next diff, so you must also stop
   trusting `generate` and maintain an ignore discipline. The tool's main feature is then off.
2. **The direction of truth is backwards for this project.** With Drizzle, TS is the source and SQL
   is generated — except for the half that isn't, which must be kept in sync by hand forever. With
   `kysely-codegen`, **SQL is the source and TS is generated from the migrated database**, so
   drift is not a discipline problem, it is impossible: CI runs the migrations on an empty
   Postgres, regenerates, and fails on `git diff`.
3. **Maintenance signal.** `drizzle-orm@0.45.2` (`latest`) has not moved since **2026-03-27**, five
   months, while `1.0.0-rc.5` publishes weekly. Adopting `0.45.x` today means adopting a line whose
   successor is a major rewrite in RC — a known, scheduled migration cost in Phase 2, on the package
   that touches every file in `packages/db`. Kysely 0.29.5 shipped 2026-08-10 and its API is the
   same query builder it has been for years. (Both are 0.x. Kysely's 0.29 was itself breaking —
   ESM-only, `kysely/migration` subpath, TS 5.4 floor — so this is a difference of degree.)
4. **The hot path is `EXISTS` composition, not ORM.** The filter compiler builds one correlated
   semi-join per chip. Kysely's expression builder does this as a first-class, typed operation;
   Drizzle does it with `exists(db.select()…)` inside `sql` fragments, which works but loses
   typing at exactly the point where the compiler is most error-prone.

### Why not raw `pg`

`storage-DECISION.md` has ~15 tables, and the non-dynamic 80% of the API is ordinary CRUD:
follow-ups, interactions, saved views, import batches, attribute definitions, options, identifiers,
metrics. Writing and maintaining `SELECT` column lists and row mappers for those by hand is the
part of raw SQL that is pure cost with no upside — a typo in a column name becomes a runtime error
in a code path someone tests once. Kysely catches it at compile time and costs nothing at runtime
(it is a string builder; there is no ORM, no unit of work, no lazy loading, no N+1 surprises).

### Decision

Kysely 0.29.5. The `DB` interface is **generated from the live database** by `kysely-codegen@0.20.0`
into `packages/db/src/schema.generated.ts`, committed, and asserted unchanged in CI.

### The filter compiler, for real

The compiler is the pure function `storage-DECISION.md` §5.3 specifies:
`(AttributeDefinition, Operator, Value[]) → predicate`. In Kysely it returns an
`Expression<SqlBool>`, which composes with `eb.and([...])` and compiles with `.compile()` to
`{ sql, parameters }` — exactly the golden-file test the brief's §8.1 asks for, with no database.

```ts
// packages/core/src/filter/compile.ts
import { sql, type ExpressionBuilder, type Expression, type SqlBool } from 'kysely';
import type { DB } from '@mutuals/db';
import type { AttributeDefinition, Condition } from '../types.js';
import { normaliseText, esc } from '../text.js';

type EB = ExpressionBuilder<DB & { r: DB['record'] }, 'r'>;

/**
 * One filter chip -> one correlated semi-join, per storage-DECISION.md §5.2.
 * EXISTS (not JOIN) so a contact with five tags is returned once and the footer count is honest,
 * and so Postgres can pull the sublink up and choose its own driving index per chip.
 */
export function attributePredicate(eb: EB, def: AttributeDefinition, c: Condition): Expression<SqlBool> {
  const scoped = (pred: (v: ExpressionBuilder<DB, 'v'>) => Expression<SqlBool>) =>
    eb.exists(
      eb.selectFrom('attribute_value as v')
        .select(sql.lit(1).as('one'))
        .whereRef('v.record_id', '=', 'r.id')
        .where('v.attribute_id', '=', def.id)      // ALWAYS the leading key of every av index
        .where(pred as never),
    );

  switch (c.op) {
    // --- one definition of "empty" for all twelve types (storage §3.3) -> av_attr_rec_idx
    case 'is_empty':
      return eb.not(scoped(() => sql<SqlBool>`true`));

    // --- text ------------------------------------------------------------------------------
    case 'contains': {                                            // -> av_trgm_idx
      const q = normaliseText(String(c.value));
      return scoped((v) => sql<SqlBool>`${v.ref('v.text_norm')} LIKE ${'%' + esc(q) + '%'}`);
    }
    case 'equals': {                                              // -> av_attr_text_idx + recheck
      const q = normaliseText(String(c.value));
      return scoped((v) =>
        v.and([
          v('v.text_sort', '=', q.slice(0, 256)),   // indexed, truncated prefix
          v('v.text_norm', '=', q),                 // exact recheck at full length
        ]));
    }

    // --- number ----------------------------------------------------------------------------
    case 'eq': return scoped((v) => v('v.num_value', '=',  c.value as number));
    case 'ne': return scoped((v) => v('v.num_value', '!=', c.value as number));  // §3.4: EXCLUDES empty
    case 'lt': return scoped((v) => v('v.num_value', '<',  c.value as number));
    case 'gt': return scoped((v) => v('v.num_value', '>',  c.value as number));

    // --- between is inclusive on both ends; slot chosen by value_kind, never by the client ---
    case 'between': {
      const col = def.valueKind === 'date' ? 'v.date_value' : 'v.num_value';
      return scoped((v) => v.and([v(col as never, '>=', c.from as never),
                                  v(col as never, '<=', c.to   as never)]));
    }

    // --- date ------------------------------------------------------------------------------
    case 'before': return scoped((v) => v('v.date_value', '<', c.value as string));
    case 'after':  return scoped((v) => v('v.date_value', '>', c.value as string));

    // --- yes_no ----------------------------------------------------------------------------
    case 'is_yes': return scoped((v) => v('v.bool_value', '=', true));
    case 'is_no':  return scoped((v) => v('v.bool_value', '=', false));

    // --- options: the WIRE carries stable option KEYS; uuids are resolved here, never sent ---
    case 'is_any_of':                                             // single_select -> av_attr_opt_idx
    case 'has_any_of':                                            // multi_select / tags / relation
      if (def.valueKind === 'option')
        return scoped((v) => v('v.option_id', 'in', resolveOptionIds(def, c.values)));
      if (def.valueKind === 'relation')
        return eb.exists(
          eb.selectFrom('record_link as l')
            .select(sql.lit(1).as('one'))
            .whereRef('l.from_record_id', '=', 'r.id')
            .where('l.attribute_id', '=', def.id)
            .where('l.to_record_id', 'in', c.values as string[]));
      // tags: exact normalised value_key, no truncation -> av_attr_key_idx
      return scoped((v) => v('v.value_key', 'in', c.values.map((x) => normaliseText(String(x)).slice(0, 512))));

    case 'is_none_of':                                            // §3.4: INCLUDES empty
      return eb.not(scoped((v) => v('v.option_id', 'in', resolveOptionIds(def, c.values))));

    case 'has_all_of': {
      const ids = resolveOptionIds(def, c.values);
      return eb(
        eb.selectFrom('attribute_value as v2')
          .select(({ fn }) => fn.count<number>('v2.option_id').distinct().as('n'))
          .whereRef('v2.record_id', '=', 'r.id')
          .where('v2.attribute_id', '=', def.id)
          .where('v2.option_id', 'in', ids),
        '=', ids.length);
    }
    default:
      throw new UnsupportedOperator(def.slug, c.op);              // -> 400, never a silent no-op
  }
}
```

Three things that fall out of this and are worth naming:

- **No user input ever reaches a SQL identifier.** The only identifiers the compiler emits come
  from a closed set of eight column-name literals selected by `def.valueKind`. Every value is a
  bind parameter. Kysely gives that structurally; a raw-string compiler gives it by discipline.
- `.compile()` returns `{ sql, parameters }`, so the ≥45 unit tests in `storage-DECISION.md` §10.8
  assert the exact SQL string and parameter array with no database in the loop.
- The three query shapes (`Q1` narrow sort/filter, `Q2` hydrate ≤50 ids, `Q3` cached count) are
  three separate Kysely builders that share `buildWhere(filters)`. Q1's sort join is a plain
  `LEFT JOIN attribute_value` on `value_key = ''`, exactly as §5.2 specifies, not a LATERAL.

### pgvector

Drizzle wins here on paper: `drizzle-orm/pg-core` ships first-class `vector`, `halfvec`,
`sparsevec` and `bit` column builders (verified in
`drizzle-orm@0.45.2/pg-core/columns/vector_extension/`). Kysely has no vector type. The honest
weight of that: the `vector(1536)` column lives on **one** table (`search_document`), is **NULL for
all of Phase 1**, and is written by a single backfill job and read by a single query. In Kysely
that is:

```ts
// packages/db/src/vector.ts
import { sql, type RawBuilder } from 'kysely';
export const toVector = (v: number[]): RawBuilder<string> => sql`${JSON.stringify(v)}::vector`;
export const cosineDistance = (col: string, v: number[]) =>
  sql<number>`${sql.ref(col)} <=> ${toVector(v)}`;
```

Eight lines against a whole-ORM decision. Recorded as a genuine point in Drizzle's favour that was
outweighed.

### Consequences

- `packages/db` exports the generated `DB` interface, the `Kysely<DB>` instance factory, and the
  migration runner. Nothing else.
- `pg-boss@12.29.0` brings its own `pg@^8.23.0` and manages its own schema; it shares the same
  database and is untouched by Kysely. Same `DATABASE_URL`, separate pool.
- Kysely is ESM-only. `apps/api` is ESM (`"type": "module"`), Node 24 native. Fine.
- **This is the most reversible decision in the stack**, and that is a deliberate property: the
  migrations are plain `.sql`, the schema types are generated from the database, and Kysely emits
  SQL strings. Swapping to Drizzle later touches only query call sites — no data migration, no
  schema change, no API change. If drizzle 1.0 lands and the co-founder prefers it, the cost is a
  mechanical refactor of one package.

---

## ADR-API-04 — Plain numbered `.sql` migrations, run explicitly, checked on boot

### Context

§3.2: *"Migrations must be versioned, in the repo and reproducible."* `storage-DECISION.md` §10.1
adds: *"Migrations create every object in §2 and are reproducible from empty (`pnpm db:migrate` on
a fresh database, asserted in CI)."*

Given ADR-API-03, there is no TS schema DSL to diff against, so migration *generation* is not a
requirement. Migration *ordering*, *locking*, *atomicity* and *reproducibility* are.

### Options

**Option 1 — drizzle-kit `generate` + `migrate`.** Ruled out with Drizzle in ADR-API-03.
**Option 2 — `node-pg-migrate@9.0.0`.** A mature dedicated migration tool (669k weekly downloads)
that natively runs `.sql` files, takes an advisory lock, and has a CLI. A real contender. Rejected
only because it is a *second* database dependency and connection path alongside Kysely, for
something Kysely already does in 30 lines — and because its JS migration format tempts people to
write DDL in JavaScript, which is exactly what this project must not do.
**Option 3 — Kysely `Migrator` with a custom `.sql` file provider (chosen).**

### Decision

`packages/db/migrations/NNNN_name.sql`, plain SQL, immutable once merged, run by Kysely's
`Migrator`. Verified properties of that `Migrator` (read from `kysely@0.29.5/dist/migration/`):

- it creates and uses a **lock table** (`kysely_migration_lock`, one row, `is_locked`), so two
  processes cannot migrate concurrently;
- it runs each migration **inside a transaction** by default (`disableTransactions: false`), which
  on Postgres means transactional DDL — a failed migration leaves nothing behind;
- it **enforces alpha-numeric order against the migrations already recorded**
  (`allowUnorderedMigrations: false` by default), so a migration merged out of order fails loudly
  instead of applying;
- it never throws; it returns `{ error, results }`, so the runner controls the exit code and the
  message.

Table names stay at the defaults `kysely_migration` / `kysely_migration_lock`, because Kysely's own
docs warn — twice, in capitals — that changing them later requires a manual migration of the
migration tables.

### The provider, in full

```ts
// packages/db/src/migrate/sql-file-provider.ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sql, type Kysely } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely/migration';

/**
 * Runs each `NNNN_name.sql` file as ONE multi-statement simple query.
 *
 * VERIFIED (pg@8.23.0/lib/query.js): `requiresPreparation()` returns `this.values.length > 0`, so
 * an EMPTY parameter array selects the *simple* query protocol (`connection.query(this.text)`),
 * which permits multiple statements per message — and `_checkForMultirow()` exists precisely to
 * collect their results. Kysely's PostgresDriver calls
 * `client.query(compiledQuery.sql, compiledQuery.parameters)`, and `sql.raw(text)` compiles to
 * zero parameters. So a whole DDL file — dollar-quoted plpgsql function bodies included — runs as
 * written, with no statement splitter to get wrong.
 *
 * A file needing CREATE INDEX CONCURRENTLY (none in Phase 1 — storage-DECISION.md forbids runtime
 * DDL) must be named `NNNN_name.notx.sql` and is skipped by the transactional runner; see run.ts.
 */
export class SqlFileMigrationProvider implements MigrationProvider {
  constructor(private readonly dir: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.sql')).sort();
    const out: Record<string, Migration> = {};
    for (const file of files) {
      const body = await fs.readFile(path.join(this.dir, file), 'utf8');
      out[path.basename(file, '.sql')] = {
        async up(db: Kysely<unknown>) { await sql.raw(body).execute(db); },
        // No `down`. Rolling a schema back on a single-user CRM is a restore, not a migration.
        // `migrateTo(NO_MIGRATIONS)` stays available for the test harness, which drops the DB.
      };
    }
    return out;
  }
}
```

```ts
// packages/db/src/migrate/run.ts  — `pnpm db:migrate`
import { Migrator } from 'kysely/migration';
import { makeDb } from '../client.js';
import { SqlFileMigrationProvider } from './sql-file-provider.js';
import { MIGRATIONS_DIR } from './dir.js';

export async function runMigrations(): Promise<void> {
  const db = makeDb();
  const migrator = new Migrator({ db, provider: new SqlFileMigrationProvider(MIGRATIONS_DIR) });
  const { error, results } = await migrator.migrateToLatest();

  for (const r of results ?? []) {
    console.log(`${r.status === 'Success' ? '✓' : '✗'} ${r.migrationName}`);
  }
  if (error) { console.error(error); await db.destroy(); process.exit(1); }
  await db.destroy();
}
```

### How migrations run — the part people get wrong

**Never automatically on API boot.** Two processes will exist from Stage 4 (`apps/api` and the
pg-boss worker); both booting into `migrateToLatest()` means one blocks on the lock table on every
restart, and a failed migration takes down the API rather than a script. Instead:

| Where | What runs |
|---|---|
| `pnpm dev` | `db:migrate` → `api:spec` → `api:types` → start api + web + worker (§3.2's "one command") |
| API boot | **drift check only**: compare the filenames in `packages/db/migrations/` to the rows in `kysely_migration`; on a mismatch, log the missing names and `process.exit(1)` with `Database schema is behind. Run: pnpm db:migrate` |
| CI | `db:migrate` on an empty database, then `db:codegen` + `git diff --exit-code`, then tests |
| Deploy | `pnpm db:migrate` as an explicit pre-deploy step |

```ts
// apps/api/src/boot/assert-schema.ts
export async function assertSchemaCurrent(db: Kysely<DB>) {
  const applied = new Set(
    (await db.selectFrom('kysely_migration').select('name').execute()).map((r) => r.name));
  const onDisk = (await fs.readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql'))
                   .map(f => path.basename(f, '.sql')).sort();
  const missing = onDisk.filter((n) => !applied.has(n));
  if (missing.length) {
    throw new Error(
      `Database schema is behind by ${missing.length} migration(s): ${missing.join(', ')}\n` +
      `Run: pnpm db:migrate`);
  }
}
```

### CI, in full

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    services:
      postgres:
        # The official pgvector image from pgvector 0.6.0 onward. pg_trgm, btree_gin and unaccent
        # are contrib modules and ship in it; `vector` is the whole point of the image.
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: mutuals_test
        options: >-
          --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5
        ports: ['5432:5432']
    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/mutuals_test
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with: { node-version: '24.20.0', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile

      # 1. migrations are reproducible from empty  (storage-DECISION.md §10.1)
      - run: pnpm db:migrate

      # 2. the generated DB types match the real database — drift is impossible, not discouraged
      - run: pnpm db:codegen
      - run: git diff --exit-code packages/db/src/schema.generated.ts

      # 3. the committed OpenAPI document and client types match the code
      - run: pnpm api:check

      # 4. every route has a unique operationId (protects the MCP story, §7)
      - run: pnpm api:lint-operations

      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test            # vitest: unit + integration against the service Postgres
      - run: pnpm test:e2e        # playwright
```

```jsonc
// package.json scripts for the database
{
  "db:migrate": "tsx packages/db/src/migrate/cli.ts",
  "db:codegen": "kysely-codegen --dialect postgres --out-file packages/db/src/schema.generated.ts --camel-case",
  "db:reproject": "tsx packages/db/src/reproject.ts",   // storage-DECISION.md §10.3
  "db:new":     "tsx packages/db/src/migrate/new.ts"    // creates NNNN_name.sql with the next number
}
```

### Consequences

- Reviewers read SQL, which is the language the schema is actually in. No third representation.
- No migration *generation*: every migration is written by a person. At ~15 tables and a schema
  that is 80% written in Stage 1, that is a feature, not a cost.
- The `.notx.sql` suffix is the built-in escape hatch for a future `CREATE INDEX CONCURRENTLY`,
  documented before it is needed.
- **Local Postgres is unsolved and needs a human** (see Open Questions): there is no Docker and no
  Postgres on this machine, and `embedded-postgres` is at `18.4.0-beta.17` and carries no pgvector.

---

## ADR-API-05 — Wire contract: envelopes, cursors, and RFC 9457 errors

### Options for the response shape

**Option 1 — JSON:API.** Standard, well-specified, and enormous: `type`/`id`/`attributes`/
`relationships`/`included` for a product whose *own* domain word for a field is already
"attribute". Rejected as ceremony.
**Option 2 — envelope everywhere, `{data: …}` for single resources too.** Consistent, but makes
every client write `res.data.data`.
**Option 3 (chosen) — Stripe-shaped: a bare object for a single resource, an envelope for a list.**
Boring, universally recognised, and it reads well through `openapi-fetch` (`data.id` vs
`data.data`).

### Options for the error shape

**Option 1 — bespoke `{error: {code, message, fields}}`.** Fine, and one more thing to document.
**Option 2 (chosen) — RFC 9457 Problem Details** (`application/problem+json`), which obsoletes
RFC 7807 and explicitly permits extension members. It costs nothing over a bespoke shape, it is
already understood by generated Python clients, and `openapi-fetch` parses it because it calls
`response.json()` regardless of content type (verified above).

### The shapes

```ts
// packages/contracts/src/envelope.ts
import { z } from 'zod';

export const PageSchema = z.object({
  limit:      z.int().min(1).max(200),
  nextCursor: z.string().nullable().describe('Opaque. Pass back as ?cursor= for the next page.'),
  hasMore:    z.boolean(),
});

export const ListMetaSchema = z.object({
  total: z.int().nullable()
    .describe('Row count for the footer. null when count=none was requested.'),
  totalIsEstimate: z.boolean()
    .describe('true when the count came from reltuples rather than an exact COUNT(*).'),
});

export const listOf = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), page: PageSchema, meta: ListMetaSchema });
```

```jsonc
// GET /api/v1/contacts?limit=2  ->  200 application/json
{
  "data": [
    {
      "id": "0d7f1a2e-2b31-4a10-9f0e-6d5a1c9b8e77",
      "objectType": "contact",
      "displayName": "Anna Berger",
      "createdAt": "2026-03-12T09:14:22.001Z",
      "updatedAt": "2026-08-30T17:02:10.442Z",
      "provenance": {
        "createdVia": "import",
        "importBatchId": "6d1e…", "importedAt": "2026-03-12T09:14:22.001Z",
        "fileName": "linkedin_connections.csv",
        "lastEnrichedAt": null, "enrichedBy": null
      },
      "attributes": {
        "email":    { "type": "email",         "value": "anna@northstar.vc" },
        "city":     { "type": "short_text",    "value": "München" },
        "job_role": { "type": "single_select", "value": { "key": "investor", "label": "Investor", "color": "violet" } },
        "areas_of_interest": { "type": "tags", "values": ["climate", "hardware"] },
        "organization": {
          "type": "relation",
          "values": [{
            "id": "b41c…", "objectType": "organization", "label": "Northstar Ventures",
            "link": { "title": "Partner", "from": "2023-01-01", "to": null, "isPrimary": true }
          }]
        }
      },
      "derived": {
        "lastInteractionAt": "2026-07-18T18:00:00.000Z",
        "interactionCount12m": 4, "openFollowups": 1,
        "nextFollowupAt": "2026-09-20", "warmth": 68
      }
    }
  ],
  "page": { "limit": 2, "nextCursor": "eyJrIjoia3MiLCJjIjoiMjAyNi0wMy0xMlQwOToxNDoyMi4wMDFaIiwiaSI6IjBkN2Y…", "hasMore": true },
  "meta": { "total": 2236, "totalIsEstimate": false }
}
```

Four load-bearing choices inside that body:

1. **`attributes` is a map keyed by slug, and every entry carries its `type`.** A generic client
   (the DataTable, the MCP server, a Python script) can render a cell without a second lookup, and
   a `single_select` carries its `label` and `color` so the table does not N+1 into the option list.
2. **An empty attribute is an absent key.** That is the same definition as
   `storage-DECISION.md` §3.3 ("no live value row"), all the way out to the wire. There is no
   `null`, no `[]`, no `""` — one definition of empty, in the database, in the compiler and in JSON.
3. **The wire carries option `key`s, not option uuids.** `attribute_option.key` is the stable
   machine name; `label` is renameable and `id` is a uuid that differs between a developer's seed
   and Simon's laptop. A saved view, a bookmarked URL and an LLM-produced filter therefore all
   survive a re-seed and are readable by a human. Relations are the exception — a record has no
   stable key other than its id — so relation filters carry uuids, and that is stated in the docs.
4. **`derived` is a separate object from `attributes`.** They are filterable and sortable like any
   other column (they appear in the same `/attribute-definitions` response with
   `"isDerived": true`), but they have no provenance, no history and no confidence, so putting them
   in the same bag would invite a client to try to write one.

### Errors

```ts
// packages/contracts/src/problem.ts — RFC 9457 + three extension members
export const FieldErrorSchema = z.object({
  field:   z.string().describe('Dotted path into the request: body.first_name, query.filter[1].field'),
  code:    z.string().describe('Stable machine code from the catalogue below'),
  message: z.string().describe('Human-readable English'),
});

export const ProblemSchema = z.object({
  type:     z.url().describe('https://getmutuals.ai/probs/<code>'),
  title:    z.string(),
  status:   z.int(),
  detail:   z.string(),
  instance: z.string().describe('The request path'),
  // extension members (RFC 9457 §3.2 permits these)
  code:      z.string(),
  requestId: z.string(),
  errors:    z.array(FieldErrorSchema).optional(),
});
```

```jsonc
// POST /api/v1/contacts  ->  400 application/problem+json
{
  "type": "https://getmutuals.ai/probs/validation-failed",
  "title": "Validation failed",
  "status": 400,
  "detail": "2 fields are invalid.",
  "instance": "/api/v1/contacts",
  "code": "validation_failed",
  "requestId": "0193f6c1-2f0a-7a1b-9c33-4a2f1e0b77de",
  "errors": [
    { "field": "body.first_name",       "code": "required",          "message": "First name is required." },
    { "field": "body.attributes.email", "code": "invalid_format",    "message": "Must be a valid email address." }
  ]
}
```

```jsonc
// GET /api/v1/contacts?filter=[{"field":"citty","op":"contains","value":"m"}]  ->  400
{
  "type": "https://getmutuals.ai/probs/unknown-attribute",
  "title": "Unknown attribute",
  "status": 400,
  "detail": "No attribute with slug \"citty\" exists on contact.",
  "instance": "/api/v1/contacts",
  "code": "unknown_attribute",
  "requestId": "0193f6c1-…",
  "errors": [
    { "field": "query.filter[0].field", "code": "unknown_attribute",
      "message": "No attribute \"citty\" on contact. Did you mean \"city\"?" }
  ]
}
```

The "did you mean" is a Levenshtein pass over the object type's slugs. It costs ten lines and it is
the difference between the Ask-the-network LLM self-correcting on the next turn and it giving up.

**Status codes — 400 everywhere for request problems, no 422.** `storage-DECISION.md` already
fixed "an unknown slug is a 400 before any SQL is built" and "asking to sort by a non-sortable type
is a 400". Introducing 422 for semantic-but-well-formed errors would put `unknown_attribute` at 422
and contradict that. One code, matching Fastify's own default for schema failures. 422 is recorded
here as the considered-and-rejected alternative so nobody re-opens it.

| Status | `code` values |
|---|---|
| 400 | `validation_failed`, `unknown_attribute`, `operator_not_allowed`, `not_sortable`, `invalid_filter_json`, `invalid_cursor`, `stale_cursor`, `attribute_type_immutable`, `slug_immutable` |
| 404 | `not_found` |
| 409 | `duplicate_identifier`, `slug_taken`, `option_in_use` |
| 500 | `internal_error`, `response_serialization_failed` |

```ts
// apps/api/src/errors/handler.ts
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';

export const problemErrorHandler: FastifyErrorHandler = (err, req, reply) => {
  const base = { instance: req.url, requestId: req.id as string };

  if (hasZodFastifySchemaValidationErrors(err)) {
    // err.validation carries the Zod issues; issue.path is PropertyKey[] in Zod 4.
    const errors = err.validation.map((v) => ({
      field:   `${v.instancePath ? partOf(v) : ''}${jsonPath(v)}`,
      code:    zodCodeToApiCode(v),              // invalid_type -> invalid_type, too_small -> too_small, …
      message: v.message ?? 'Invalid value.',
    }));
    return reply.status(400).type('application/problem+json').send({
      ...base, type: prob('validation-failed'), title: 'Validation failed', status: 400,
      code: 'validation_failed', detail: `${errors.length} field(s) are invalid.`, errors,
    });
  }

  if (err instanceof ApiError) {                 // unknown_attribute, not_sortable, conflict, …
    return reply.status(err.status).type('application/problem+json')
      .send({ ...base, ...err.toProblem() });
  }

  if (isResponseSerializationError(err)) {
    req.log.error({ issues: err.cause.issues, url: err.url }, 'response does not match its schema');
    return reply.status(500).type('application/problem+json').send({
      ...base, type: prob('internal-error'), title: 'Internal Server Error', status: 500,
      code: 'response_serialization_failed', detail: 'The server produced a malformed response.',
    });
  }

  req.log.error({ err }, 'unhandled');
  return reply.status(500).type('application/problem+json').send({
    ...base, type: prob('internal-error'), title: 'Internal Server Error', status: 500,
    code: 'internal_error', detail: 'Something went wrong.',
  });
};
```

### Pagination

```
?limit=50&cursor=<opaque base64url>
```

The cursor is `base64url(JSON.stringify({ k, s, ... }))`:

- `k: "ks"` — keyset, used for the default sort (`-created_at`), carrying `c` (the `created_at`) and
  `i` (the id). `WHERE (r.created_at, r.id) < ($c, $i)` against `record_list_idx`.
- `k: "off"` — offset, used for custom-attribute sorts, carrying `o`.
- `s` — a short hash of the compiled `(filter, sort)` signature in **both** shapes. A cursor
  presented with a different filter or sort is `400 stale_cursor` instead of returning wrong rows.

Opaque because `storage-DECISION.md` §6.6 wants to switch custom-attribute sorts from `OFFSET` to
keyset later without an API or UI change. Clients must treat it as a string; the OpenAPI
description says so.

### Counts

`?count=auto|exact|none`, default `auto`. `auto` runs the exact narrow `COUNT(*)` below a
configured threshold and falls back to a `reltuples` estimate above it, and reports which it did in
`meta.totalIsEstimate`. Never `count(*) OVER ()` (§5.1 of the storage decision explains why).

### Writes, and how provenance reaches the fact log

```jsonc
// PATCH /api/v1/contacts/{id}
{
  "attributes": {
    "city":              { "value": "Berlin" },
    "areas_of_interest": { "values": ["climate", "hardware", "biotech"] },   // full set; server diffs
    "birthday":          null                                                // clear = tombstone fact
  },
  "provenance": { "source": "quick_capture", "confidence": 0.9, "validFrom": "2026-06-01",
                  "sourceRef": "interaction:6d1e…" }
}
```

One endpoint, one transaction, mapping straight onto `storage-DECISION.md` §4.1–§4.3: single-valued
attributes supersede-then-insert; multi-valued attributes are diffed against the current live set
and emit per-element adds and tombstones. `provenance` defaults to `{source:"manual",
confidence:1.0}`, so the UI sends nothing, and the agent and the MCP server send
`{"source":"agent","confidence":0.85}` — which is precisely the §4.5 extension point, exposed on
the wire from day one and costing nothing today.

---

## ADR-API-06 — The filter model, and how it is serialised into a URL

This is the piece the brief singles out: *the same filter model in the DataTable, the URL, the API
and later the LLM.* Four consumers, one model.

### Options for the serialisation

| | Example | Verdict |
|---|---|---|
| RSQL / FIQL grammar | `filter=job_role=in=(investor,angel);city==*munich*` | Compact and readable, but needs an escaping scheme for commas, semicolons and parentheses inside values, plus a hand-written parser on both sides. A grammar is a liability when the values are user-typed free text. **Rejected.** |
| Bracket syntax | `filter[0][field]=job_role&filter[0][op]=is_any_of&filter[0][values][]=investor` | Needs `qs` as a `querystringParser` on Fastify, produces an OpenAPI parameter that no generator renders well, and is verbose. **Rejected.** |
| One JSON parameter | `filter=[{"field":"job_role","op":"is_any_of","values":["investor","angel"]}]` | Zero grammar, zero escaping beyond `encodeURIComponent`, byte-identical to `saved_view.filters` jsonb and to what the LLM emits. **Chosen.** |
| Repeated JSON parameter | `filter={"field":…}&filter={"field":…}` | Marginally nicer to eyeball; two encodings (one chip vs many) to handle. **Rejected.** |

The decisive point: the LLM path (§4.8) needs a JSON Schema it can be constrained to, saved views
already store `filters jsonb`, and the DataTable holds the filter set in React state as objects.
Three of the four consumers are already JSON. Inventing a string grammar means writing a serialiser
*and* a parser and keeping them in agreement forever, for no benefit the brief asks for.

### The model

```ts
// packages/contracts/src/filter.ts — the whole model, ~40 lines
import { z } from 'zod';

export const SlugSchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const Scalar = z.union([z.string(), z.number(), z.boolean()]);
const Unit   = z.enum(['day', 'week', 'month', 'quarter', 'year']);

export const ConditionSchema = z.discriminatedUnion('op', [
  // A. no value
  z.object({ field: SlugSchema, op: z.literal('is_empty') }),
  z.object({ field: SlugSchema, op: z.literal('is_yes') }),
  z.object({ field: SlugSchema, op: z.literal('is_no') }),
  // B. one scalar
  z.object({ field: SlugSchema,
             op: z.enum(['contains','equals','eq','ne','lt','gt','before','after']),
             value: Scalar }),
  // C. inclusive range (numbers or ISO dates; the attribute's type decides which is legal)
  z.object({ field: SlugSchema, op: z.literal('between'), from: Scalar, to: Scalar }),
  // D. a set. Selects carry option KEYS; relations carry record uuids.
  z.object({ field: SlugSchema,
             op: z.enum(['is_any_of','is_none_of','has_any_of','has_all_of']),
             values: z.array(Scalar).min(1).max(200) }),
  // E. relative window
  z.object({ field: SlugSchema, op: z.enum(['in_last','older_than']),
             n: z.int().positive().max(3650), unit: Unit }),
  // F. calendar-aligned window ("this year")
  z.object({ field: SlugSchema, op: z.literal('in_current'), unit: Unit }),
]);

/** AND-only, per storage-DECISION.md §1.5 — an OR between two EXISTS defeats the semi-join pull-up,
 *  and §5.2 of the brief already guarantees AND-only for the UI. */
export const FilterSetSchema = z.array(ConditionSchema).max(20);

export type Condition = z.infer<typeof ConditionSchema>;
export type FilterSet = z.infer<typeof FilterSetSchema>;
```

**The wire schema is a syntax; the attribute definition is the type system.** `between` accepts
`Scalar` for `from`/`to` because it serves both `number` and `date`; which one is legal for a given
field is decided by `assertOperatorAllowed(def, condition)` in `packages/core`, against the table
below. That keeps the JSON Schema small enough for a model to hit reliably (8 variants, not 40) and
puts type-checking where the attribute definition lives.

**The API publishes the table.** `GET /api/v1/attribute-definitions?objectType=contact` returns, per
definition, `{ slug, title, type, isDerived, sortable, operators: [...], options: [{key,label,color}] }`.
The DataTable's filter picker, the LLM's prompt and any third-party client all read the legal
operators from the API instead of hard-coding them. That is the brief's "attribute definitions drive
everything — never hard-code a column", applied to operators.

### The operator matrix

| Attribute type | Legal operators |
|---|---|
| `short_text` | `contains`, `equals`, `is_empty` |
| `long_text` | `contains`, `is_empty` |
| `number` | `eq`, `ne`, `lt`, `gt`, `between`, `is_empty` |
| `date` | `before`, `after`, `between`, `in_last`, `in_current`, `is_empty` |
| `yes_no` | `is_yes`, `is_no`, `is_empty` |
| `single_select` | `is_any_of`, `is_none_of`, `is_empty` |
| `multi_select` | `has_any_of`, `has_all_of`, `is_empty` |
| `tags` | `has_any_of`, `is_empty` |
| `url` / `email` / `phone` | `contains`, `is_empty` |
| `relation` | `has_any_of`, `is_empty` |
| derived `last_interaction_at` | `older_than`, `in_last`, `before`, `after`, `between`, `is_empty` |
| derived `interaction_count_12m`, `warmth`, `people_count` | `eq`, `ne`, `lt`, `gt`, `between` |
| derived `open_followups` | `eq`, `lt`, `gt` |
| system `created_at` | `before`, `after`, `between`, `in_last`, `in_current` |
| system `display_name` | `contains`, `equals` |
| system `import_batch_id` | `is_any_of` |

Two semantics that differ from each other on purpose, taken verbatim from
`storage-DECISION.md` §3.4 and shown in the chip's tooltip so the user is never guessing:

- **`ne` excludes records with no value** ("has a value, and it differs").
- **`is_none_of` includes records with no value** (it is `NOT (is_any_of)`, which is how a person
  reads "is not an Investor").
- **`between` is inclusive at both ends** (it compiles to SQL `BETWEEN`).

### Every operator, as a URL

Decoded for readability; the real URL is `encodeURIComponent` of the JSON array.

| Operator | Condition JSON | Reads as |
|---|---|---|
| `is_empty` | `{"field":"city","op":"is_empty"}` | City is empty |
| `contains` | `{"field":"city","op":"contains","value":"munich"}` | City contains "munich" |
| `equals` | `{"field":"city","op":"equals","value":"München"}` | City is exactly "München" |
| `eq` | `{"field":"check_size","op":"eq","value":250000}` | Check size = 250,000 |
| `ne` | `{"field":"check_size","op":"ne","value":0}` | Check size ≠ 0 (**and is set**) |
| `lt` | `{"field":"check_size","op":"lt","value":100000}` | Check size < 100,000 |
| `gt` | `{"field":"check_size","op":"gt","value":500000}` | Check size > 500,000 |
| `between` (number) | `{"field":"check_size","op":"between","from":100000,"to":500000}` | Check size 100k–500k inclusive |
| `before` | `{"field":"birthday","op":"before","value":"1990-01-01"}` | Birthday before 1 Jan 1990 |
| `after` | `{"field":"birthday","op":"after","value":"1990-01-01"}` | Birthday after 1 Jan 1990 |
| `between` (date) | `{"field":"birthday","op":"between","from":"1985-01-01","to":"1995-12-31"}` | Birthday in 1985–1995 |
| `in_last` | `{"field":"created_at","op":"in_last","n":30,"unit":"day"}` | Created in the last 30 days |
| `in_current` | `{"field":"created_at","op":"in_current","unit":"year"}` | Created this calendar year |
| `older_than` | `{"field":"last_interaction_at","op":"older_than","n":90,"unit":"day"}` | No interaction in 90 days |
| `is_yes` | `{"field":"is_mentor","op":"is_yes"}` | Is a mentor |
| `is_no` | `{"field":"is_mentor","op":"is_no"}` | Is not a mentor |
| `is_any_of` | `{"field":"job_role","op":"is_any_of","values":["investor","angel"]}` | Job role is one of Investor, Angel |
| `is_none_of` | `{"field":"job_role","op":"is_none_of","values":["student"]}` | Job role is not Student (**includes empty**) |
| `has_any_of` (tags) | `{"field":"areas_of_interest","op":"has_any_of","values":["climate","biotech"]}` | Interested in climate or biotech |
| `has_all_of` (multi_select) | `{"field":"languages","op":"has_all_of","values":["de","en"]}` | Speaks German **and** English |
| `has_any_of` (relation) | `{"field":"organization","op":"has_any_of","values":["b41c8d2e-…"]}` | Works at Northstar Ventures |

Note `values` carries option **keys** (`"investor"`), not uuids — which is why these URLs are
readable and survive a re-seed — and record **uuids** for `relation`, which have no alternative.

### The brief's headline query, end to end

Decoded:

```
GET /api/v1/contacts
  ?filter=[{"field":"job_role","op":"is_any_of","values":["investor","angel"]},
           {"field":"city","op":"contains","value":"munich"},
           {"field":"areas_of_interest","op":"has_any_of","values":["climate"]},
           {"field":"last_interaction_at","op":"older_than","n":90,"unit":"day"}]
  &sort=-check_size
  &q=berg
  &columns=email,city,job_role,areas_of_interest,last_interaction_at
  &limit=50
  &count=auto
```

Actually on the wire:

```
GET /api/v1/contacts?filter=%5B%7B%22field%22%3A%22job_role%22%2C%22op%22%3A%22is_any_of%22%2C%22values%22%3A%5B%22investor%22%2C%22angel%22%5D%7D%2C%7B%22field%22%3A%22city%22%2C%22op%22%3A%22contains%22%2C%22value%22%3A%22munich%22%7D%2C%7B%22field%22%3A%22areas_of_interest%22%2C%22op%22%3A%22has_any_of%22%2C%22values%22%3A%5B%22climate%22%5D%7D%2C%7B%22field%22%3A%22last_interaction_at%22%2C%22op%22%3A%22older_than%22%2C%22n%22%3A90%2C%22unit%22%3A%22day%22%7D%5D&sort=-check_size&q=berg&limit=50&count=auto
```

which compiles to exactly the Q1 in `storage-DECISION.md` §5.2.

### The rest of the query string

```ts
// packages/contracts/src/list-query.ts
export const ListQuerySchema = z.object({
  filter: z.string().optional()
    .describe('URL-encoded JSON array of FilterSet conditions. Combined with AND. See FilterSet.')
    .transform(parseFilterOr400)          // JSON.parse -> FilterSetSchema; failure -> invalid_filter_json
    .pipe(FilterSetSchema).default([]),

  sort: z.string().regex(/^-?[a-z][a-z0-9_]{0,62}$/).default('-created_at')
    .describe('Attribute slug; a leading "-" means descending. Single sort only (§5.2). ' +
              'A non-sortable type is 400 not_sortable, never a silent no-op.'),

  q: z.string().min(1).max(200).optional()
    .describe('Substring search over the visible text columns and the display label.'),

  columns: z.string().optional()
    .describe('Comma-separated attribute slugs to hydrate. Omitted = all.'),

  limit:  z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional().describe('Opaque. From page.nextCursor.'),
  count:  z.enum(['auto', 'exact', 'none']).default('auto'),
});
```

`sort` uses a leading `-` for descending rather than a second `order` parameter, and that is
unambiguous *because* the slug regex in `storage-DECISION.md` §2.3 forbids a leading `-`. Multi-sort
is not supported; §5.2 of the brief says it is not required.

Fastify 5's default query parser is flat (repeated keys become arrays, no nesting), which is exactly
what this schema assumes — so **no `qs`, no `querystringParser` override.**

### The LLM path, which is the reason all of this is one model

```ts
// packages/core/src/llm/ask.ts (Stage 6)
import { z } from 'zod';
import { FilterSetSchema } from '@mutuals/contracts';

const AskAnswerSchema = z.object({
  objectType: z.enum(['contact', 'organization']),
  filter: FilterSetSchema,                   // the SAME schema the DataTable and the URL use
  sort: z.string().optional(),
  explanation: z.string().describe('One sentence, shown in "How I searched".'),
});

// OpenRouter structured output — the JSON Schema comes from Zod 4 natively, no third library.
const responseFormat = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'ask_answer',
    strict: true,
    schema: z.toJSONSchema(AskAnswerSchema, { target: 'draft-2020-12' }),
  },
};
```

`z.toJSONSchema` is a first-party export of `zod@4.5.4` (verified in
`zod/v4/classic/external.d.ts`), so there is no `zod-to-json-schema` dependency and no second
conversion path that could disagree with the one `@fastify/swagger` uses. `draft-2020-12` is the
same target the OpenAPI 3.1 document uses, so **the schema the model is constrained to is
byte-identical to the schema published at `/api/docs`** — which is what makes the "How I searched"
panel trustworthy, and what makes the LLM's output valid input to the very same endpoint the UI
calls. A contract test asserts that equality.

---

## ADR-API-07 — Pin `typescript@5.9.3`, not `7.0.2` (cross-cutting)

### Context

The registry's `latest` for `typescript` is **7.0.2** — the first stable release built on the Go
native compiler, roughly 8–12× faster on full builds. It is tempting and it is wrong for this
project right now.

### Evidence (from the registry, not from memory)

- `typescript-eslint@8.69.0` declares peer `typescript: ">=4.8.4 <6.1.0"`.
- `openapi-typescript@7.13.0` declares peer `typescript: "^5.x"`.
- TypeScript 7.0 ships **without a stable programmatic compiler API** (expected in 7.1), which is
  why typescript-eslint and the framework tooling for Vue/Svelte/Astro/Angular cannot use it yet.

Both of those packages are load-bearing here: typescript-eslint is the brief's §3.2 lint
requirement, and `openapi-typescript` is the entire mechanism of ADR-API-02.

### Options

1. **TS 7.0.2** — fast `tsc`, no type-aware lint, no `openapi-typescript`. Would force replacing
   the client codegen (defeating ADR-API-02) and dropping to `oxlint@1.81.0` for lint-only rules.
2. **TS 6.0.3** — stable (2026-04-16), inside typescript-eslint's range, but outside
   `openapi-typescript`'s `^5.x` peer. Half a solution.
3. **TS 5.9.3 (chosen)** — inside every peer range in the dependency graph; also above Kysely's 5.4
   floor, Zod 4's requirement, and tRPC-if-we-ever-want-it's 5.7.2.

### Decision

`typescript@5.9.3`, exact. Revisit when TypeScript 7.1 ships the programmatic API and
typescript-eslint publishes a compatible major. Recorded in `docs/DECISIONS.md` with the two peer
ranges quoted, so the next person who runs `pnpm outdated` does not "helpfully" bump it.

### Consequences

- Slower typechecks than TS 7 would give. On a codebase this size, irrelevant.
- The upgrade path is a single ADR revision and one version bump, gated on two upstream releases.

---

## 8. What CI must assert for these decisions

Beyond `storage-DECISION.md` §10:

1. `pnpm db:migrate` from empty succeeds; `kysely-codegen` output is byte-identical to the
   committed `schema.generated.ts`.
2. `packages/api-client/openapi.json` and `schema.d.ts` are byte-identical to what the app emits.
3. **Every route has an `operationId`, and they are unique.** Ten lines over `app.swagger()`; it is
   the only mechanical guard on §7's "every UI operation is one named API operation" and therefore
   on the MCP story.
4. `z.toJSONSchema(FilterSetSchema, {target:'draft-2020-12'})` deep-equals
   `spec.components.schemas.FilterSet` — one filter model, proven, not asserted in prose.
5. Round-trip property test: `parseFilters(serialiseFilters(f)) === f` for a generated corpus of
   filter sets, including values containing `&`, `%`, `=`, `"`, emoji and CJK.
6. Golden-file tests of the compiler's emitted `{sql, parameters}` for all ~45 (type, operator)
   pairs, no database.
7. `openapi-typescript` and `typescript-eslint` peer ranges are checked by
   `pnpm ls typescript` in CI, so a TS bump that breaks ADR-API-07 fails there rather than
   in someone's editor.

---

## 9. Verified vs assumed

**Verified against the npm registry and package sources on 2026-09-03:**

- Versions and publish dates for every pin in §1, including `drizzle-orm@0.45.2`'s `latest` tag
  being five months stale against an active `1.0.0-rc.5` line.
- `fastify-type-provider-zod@7.0.0`'s peer ranges, its Zod-version matrix, the
  `z.output<T>` serialization change in v7, `jsonSchemaTransform` / `jsonSchemaTransformObject`,
  `z.globalRegistry.add(schema, {id})` for `$ref`s, and automatic `openapi-3.0` vs `draft-2020-12`
  target selection from the document's `openapi` field. (Read from the published README.)
- `@fastify/swagger@9.8.1` decorates the instance with `fastify.swagger()` returning the document
  object, `{yaml:true}` for YAML. (README lines 981–982.)
- `zod@4.5.4` exports `toJSONSchema`, `fromJSONSchema`, `treeifyError`, `flattenError`,
  `prettifyError`, `globalRegistry`, and `encode`/`decode`/`safeEncode`/`safeDecode`; the issue
  shape is `{code, path: PropertyKey[], message, input?}`; the package root export is v4.
  (Read from `v4/classic/external.d.ts`, `v4/classic/parse.d.ts`, `v4/core/errors.d.ts`.)
- `kysely@0.29.5`: Node ≥22, TS ≥5.4, ESM-only, `kysely/migration` subpath, `dist/` layout;
  `$if`, `$call`, `$castTo`, `$narrowType`, `compile(): CompiledQuery`; `eb.exists` / `not(exists)`;
  `sql` with `val`/`ref`/`id`/`lit`/`raw`/`join`; `jsonArrayFrom`/`jsonObjectFrom`/`jsonBuildObject`
  in `kysely/helpers/postgres`; `Migrator` with a lock table, per-migration transactions and
  enforced alpha-numeric ordering.
- **`pg@8.23.0` runs a multi-statement SQL file when the parameter array is empty**:
  `requiresPreparation()` returns `this.values.length > 0`, and the `false` branch calls
  `connection.query(this.text)` (simple protocol); `_checkForMultirow()` exists to collect the
  results. Kysely's PostgresDriver passes `compiledQuery.parameters`, which is empty for
  `sql.raw(...)`. This is what makes the 30-line `SqlFileMigrationProvider` correct.
- `openapi-fetch@0.17.0` defaults `parseAs: "json"` and calls `response.json()` irrespective of
  response `Content-Type`, so `application/problem+json` bodies deserialise.
- `drizzle-orm@0.45.2` ships `vector`, `halfvec`, `sparsevec`, `bit` in
  `pg-core/columns/vector_extension/`, plus `exists()`, `and/or/not`, `inArray`, `toSQL()` and
  `$dynamic()`. (The point in Drizzle's favour, checked rather than assumed.)
- `typescript-eslint@8.69.0` peer `typescript >=4.8.4 <6.1.0`; `openapi-typescript@7.13.0` peer
  `typescript ^5.x`; TypeScript 7.0 has no stable programmatic API until 7.1.
- `openapi-react-query@0.5.4` peers `@tanstack/react-query ^5.80.0`, `openapi-fetch ^0.17.0`.
- `@tanstack/react-table@9.2.4` is a breaking rewrite (`useTable({features})`, `tableFeatures()`
  slots, readonly `data`/`columns`, `getAggregationFns()`), with `useLegacyTable` in
  `@tanstack/react-table/legacy`; shadcn's data-table docs are tracked as not yet updated.
- No Docker, no Postgres, no `psql` on this machine; Node v24.20.0.
- `pgvector/pgvector:pg16` is the official image from pgvector 0.6.0 onward and works as a GitHub
  Actions service container.

**Assumed, with a stated fallback:**

- **`@fastify/swagger` renders a `z.discriminatedUnion` as a clean `oneOf` with a `discriminator`,
  and `openapi-typescript` turns that into a usable TS union.** Highly likely (this is the standard
  path) but not executed here — there is no Postgres and no install in this environment.
  *First task of Stage 1: build the app skeleton with exactly the `FilterSetSchema` above, dump the
  spec, generate the types, and paste the result into `docs/API.md`.* Fallback if the union renders
  badly: flatten `ConditionSchema` to a single object with optional `value`/`values`/`from`/`to`/
  `n`/`unit` and enforce the shape in `packages/core` — one file changes, the URL format does not.
- **`kysely-codegen@0.20.0` introspects this schema faithfully** — in particular that it maps the
  `value_kind`/`object_type`/`attribute_type` enums to string unions, `numeric` to `string` (pg's
  default, which is correct for money-like values and must be handled deliberately), `text COLLATE
  "C"` to `string`, and `vector(1536)` to something inert. Fallback: a hand-maintained
  `schema.overrides.ts` merged into `DB`, which is the documented kysely-codegen pattern.
- **Kysely's typed expression builder handles the correlated `EXISTS` against the aliased outer
  `record as r` without `as never` casts.** The sketch above uses two casts; whether they survive
  contact with the real generated `DB` type is a Stage-1 finding. Fallback: `sql<SqlBool>` fragments
  for the two or three predicates that resist, which costs typing on those predicates only.
- **`fastify.swagger()` is stable across `app.ready()` without binding a port**, so
  `dump-openapi.ts` needs no running server. Standard usage; fallback is `app.listen({port:0})`.
- **Estimated size of the whole API layer**: ~30 routes, ~1,200 lines of route code, ~400 lines of
  contracts, ~500 lines of compiler. Not measured.

---

## 10. ADRs to write into `docs/DECISIONS.md`

1. REST with OpenAPI **3.1** generated from Zod 4 via `fastify-type-provider-zod@7.0.0`; tRPC
   rejected because the REST surface the brief requires would be the less-tested one.
2. Response schemas contain no `.transform()` (v7 serialises `z.output<T>`).
3. The frontend's transport types are generated from the emitted `openapi.json`; domain runtime
   schemas are imported from `@mutuals/contracts`. The web app dogfoods the spec.
4. `openapi.json` and `schema.d.ts` are committed and asserted in CI.
5. **Kysely, not Drizzle** — because the schema's load-bearing constraints are inexpressible in a TS
   schema DSL, so types are generated *from* the database instead of the reverse. Reversible by
   design.
6. Plain numbered `.sql` migrations, run by Kysely's `Migrator` with a `SqlFileMigrationProvider`;
   default table names kept forever.
7. Migrations run **only** via `pnpm db:migrate`; the API refuses to boot against a stale schema.
8. `.notx.sql` suffix reserved for future `CREATE INDEX CONCURRENTLY` migrations.
9. Bare object for a single resource, `{data, page, meta}` for lists.
10. RFC 9457 `application/problem+json` with `code`, `requestId` and `errors[]` extension members.
11. **400 for every request-level error; no 422** — consistent with the storage decision's
    "unknown slug is a 400".
12. Opaque cursor carrying a filter/sort signature; a mismatched cursor is `400 stale_cursor`.
13. `?count=auto|exact|none`, `meta.totalIsEstimate` reports which ran.
14. One filter model, serialised as a single URL-encoded JSON array in `?filter=`; AND-only.
15. The wire carries option **keys**, never option uuids; relations carry record uuids.
16. An empty attribute is an **absent key** in `attributes` — the same definition as the database's.
17. `sort=-slug` for descending; single sort only; a non-sortable type is `400 not_sortable`.
18. Every route has a unique `operationId`, asserted in CI, because the MCP server depends on it.
19. The LLM is constrained to `z.toJSONSchema(FilterSetSchema, {target:'draft-2020-12'})`, asserted
    equal to `components.schemas.FilterSet`.
20. **Pin `typescript@5.9.3`, not 7.0.2**, because typescript-eslint (`<6.1.0`) and
    `openapi-typescript` (`^5.x`) do not support it and TS 7 has no programmatic API until 7.1.

---

## 11. Open questions for humans

Only two, and both are things the brief genuinely does not decide.

1. **How does Postgres 16 with `pgvector` get onto Simon's Mac?** The brief says "a Postgres
   container (docker compose) or the Supabase CLI — your call", and both need Docker. This machine
   has neither Docker nor Postgres, and `embedded-postgres` is at `18.4.0-beta.17` with no pgvector.
   This blocks "runs locally with one command" and blocks Stage 1's `EXPLAIN` work.
   Recommendation: **install OrbStack or Docker Desktop and use `pgvector/pgvector:pg16` in
   `docker-compose.yml`** — it is the same image CI uses, so local and CI are provably identical.
   Alternative if Docker is unwanted: Homebrew `postgresql@16` plus building pgvector from source
   (a `make install` against `pg_config`), which works but diverges from CI. Third option: point
   local dev at a free Supabase project — no local install at all, but then nothing runs offline
   and the tests share one database.
2. **Where should `getmutuals.ai` error `type` URIs point?** The RFC 9457 `type` field is
   `https://getmutuals.ai/probs/<code>`. Those URLs should eventually resolve to a page per error
   code. Is that domain available to serve a static page now, or should Phase 1 point at the GitHub
   repo's docs (`https://github.com/<org>/mutuals/blob/main/docs/API.md#<code>`) instead?
   Recommendation: **use the GitHub docs anchor in Phase 1**; switching later is one constant.
