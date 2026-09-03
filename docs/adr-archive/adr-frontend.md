# DECISION: Frontend architecture for Mutuals

**Status:** Proposed (Stage 0). Load-bearing for `apps/web`, `packages/ui` and the shape of every list endpoint's query string.
**Consistent with:** `storage-DECISION.md` (typed EAV over an append-only fact log; three-query read path; opaque cursor; derived columns as pseudo attribute definitions; AND-only filter grammar).
**Date of version research:** 2026-09-03. Every version below was read from the live npm registry or the library's own current docs on that date; §16 separates what I verified from what I assumed.

---

## 0. The decision in one paragraph

**Vite 8 SPA, TanStack Router for typed URLs, TanStack Query for server state, one Zod schema package shared with the API, shadcn/ui in a `packages/ui` workspace on Tailwind 4 CSS-first tokens, and one `RecordTable` built on TanStack Table v9 whose columns are *manufactured at runtime from attribute definitions*.** The frontend holds no derived state: the URL is the state (filters, sort, columns, cursor, wizard step), TanStack Query is the cache, and the server is the truth. The table does **no** client-side filtering, sorting or pagination — those are the storage decision's Q1/Q2/Q3 — so TanStack Table is used purely as a headless column/header/cell engine, which is exactly the ~15 % of its surface that is stable across v8 and v9. Rows are virtualised over an infinite-scrolled cursor list, so 10k rows is ~30 DOM rows and ~100 rows per network round trip. Nothing about a column is hard-coded: `AttributeDefinition[]` → `ColumnDef[]` through one factory and one renderer registry keyed by `value_kind`, which is the single rule that makes §4.2 work.

---

## 1. Context that constrains everything below

From the brief, non-negotiable: React + Tailwind + shadcn/ui; shadcn's TanStack-Table data-table pattern as the base for all tables; TypeScript everywhere; monorepo; the web app talks **only** to the public API; one command to run; MIT.

From the brief, load-bearing but easy to miss:

- §5.2 "Filters are reflected in the URL so views can be shared/bookmarked." Plus saved views, record detail pages, and a 5-step import wizard. **The URL is a first-class data structure, not an afterthought.** This single sentence is what decides the router.
- §5.2 "Virtualised rows; must stay smooth at 10k rows" *and* §5.2 "Row count in the footer (`Rows: 2,236`)" *and* §4.2 "filtering and sorting on any custom attribute across thousands of records must feel instant". The storage decision already answered the last one server-side (Q1 in single-digit ms); the frontend's job is to not squander it.
- §5.2 "Inline editing of cells … Save on blur; optimistic update; error toast on failure." Optimistic writes against an append-only fact log, where the server may return a *different* value than the one typed (normalisation, E.164 phone, tag canonicalisation). That asymmetry decides the mutation design.
- §5.2 "Define them [derived columns] in code next to the system attributes so they appear in the Columns picker like any other attribute." The storage decision already does this (`is_derived: true` pseudo definitions in `packages/core`). The frontend must therefore have **exactly one** notion of "column", not two.
- §3.1 "Structure components so animate-ui (built on shadcn + Motion) can be added later without rewriting." Concretely: keep shadcn components unmodified in shape and props; no bespoke primitives.
- §0 the co-founder reviews architecture; §8.3 `CLAUDE.md` is written for *future AI sessions*. A pattern that a future model will mis-copy is a real cost, not a stylistic one.

**One environmental note before anything else.** The current working directory `/Users/simonfuhrbach/code/crm` already contains a *different* implementation of Mutuals: Next.js 16.3.3 + `better-sqlite3` + a single-app layout, with `AGENTS.md` auto-written by `next dev`. That prototype contradicts three of the brief's fixed decisions (SQLite is ruled out; Fastify is the HTTP framework; monorepo with `apps/web` / `apps/api`). Nothing in this ADR assumes that tree; §17 asks the one question the brief itself tells us to ask.

---

## 2. ADR-F1 — Build tool and dev server: Vite 8.2.2 with Rolldown

### Options

1. **Vite 8.2.2** — Rolldown (Rust) as the single bundler for dev and build.
2. **Vite 7.3.6** — the previous major; esbuild for dev, Rollup for build. The devil we know.
3. **Next.js 16** — as the prototype in the working directory already uses.
4. **Rsbuild / Parcel / plain esbuild.**

### Choice

**Vite 8.2.2** + `@vitejs/plugin-react` 6.1.1, as a pure client-rendered SPA served by `vite preview` in prod-mode-local, and by Fastify's static handler when the API serves the built assets.

### Reasoning

Next.js is out on architecture, not taste. The brief says the web app talks to the backend **only through the public API** (§3.1) and that the same API later serves an MCP server, a CLI and integrations (§7). Next.js's value is server components, route handlers and its own data layer — every one of which is a second place to put business logic and a second server to run. Adopting it would mean either (a) not using the parts that make it Next.js, which is all cost and no benefit, or (b) using them and growing a shadow backend beside Fastify. It also breaks "runs locally with one command" into two Node servers where one suffices. A Vite SPA is a folder of static files; that is the correct shape for a client of an API-first backend.

Vite 8 over Vite 7 is the less obvious half. Vite 8.0.0 shipped 2026-03-12 and 8.2.2 on 2026-08-20 — nearly six months and two minors of production exposure, which clears the "boring" bar the brief sets. Rolldown replaces *both* esbuild (dev transform, dep pre-bundling) and Rollup (build) with one Rust bundler, and Vite ships a compatibility layer that translates `optimizeDeps.esbuildOptions` → `optimizeDeps.rolldownOptions` and `build.rollupOptions` → the Rolldown equivalents. The honest risk is that the compat layer is *lossy for exotic configs* — the widely reported failure mode is a config key that silently no-ops. Our mitigation is that our config is deliberately tiny (four plugins, one alias, no manual chunks, no custom Rollup plugins), so there is nothing exotic for the layer to mistranslate. Staying on Vite 7 to avoid a risk we have already engineered away would mean starting a greenfield repo one major behind on the thing we rebuild most often.

`@vitejs/plugin-react` 6.1.1 declares `oxc-transform-react`, `@rolldown/plugin-babel` and `babel-plugin-react-compiler` as **optional** peers — verified from the registry. Default path is Oxc (Rust); Babel is only pulled in if you opt into the React Compiler. **We do not enable the React Compiler in Phase 1.** It is a memoisation optimiser for render-heavy trees; ours renders ~30 virtualised rows. Adding it means adding Babel back into a Rust pipeline for no measured win — that is precisely the over-engineering §2.2 forbids. It stays a one-line opt-in if the Stage 7 performance pass finds a reason.

Node engine requirement, verified: `vite@8.2.2` needs `^20.19.0 || >=22.12.0`. Local Node is v24.20.0. Fine.

### Real config

```ts
// apps/web/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [
    // must precede react(): it generates routeTree.gen.ts that the app imports
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // The browser only ever talks to /api/v1 on its own origin. No CORS config,
    // no VITE_API_URL, no "which environment am I in" branch in the client.
    proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: true } },
  },
  build: { sourcemap: true },
})
```

The dev proxy is a small decision with a large consequence: because the API is same-origin in every environment, the fetch client has **no base-URL configuration at all** — it calls `/api/v1/...`. That removes the entire class of "works locally, 404s in the deployed instance" bugs and removes CORS from Fastify's surface.

### Consequences

- Build and HMR are Rust-fast; no measured baseline yet, so no number is claimed.
- If a Rolldown-specific breakage appears, the documented fallback is `vite@7.3.6` + `@vitejs/plugin-react@5`, a two-line `package.json` change, because we use no bundler-specific API.
- `vite preview` is *not* a production server. When the API serves the SPA it does so via `@fastify/static` over `apps/web/dist` with an SPA fallback — one Fastify plugin, and it keeps "one command" literal.

---

## 3. ADR-F2 — TypeScript and lint toolchain: `typescript@6.0.3`, not 7.0.2

This is repo-wide, not web-only, but it materialises first in the frontend (the `tsc --noEmit` script, the ESLint config, the editor experience) so it is decided here and must be applied to every workspace.

### Options

1. **`typescript@7.0.2`** everywhere — the Go-native compiler, 8–12× faster.
2. **`typescript@7.0.2`** for `tsc`, plus `@typescript/typescript6@6.0.2` aliased under the `typescript` name so typescript-eslint can still load a JS API.
3. **`typescript@6.0.3`** everywhere; adopt 7 when 7.1 ships the stable programmatic API.

### Choice

**`typescript@6.0.3`** across every workspace, with a one-line upgrade note in `docs/DECISIONS.md` naming TS 7.1 + a typescript-eslint release that widens its peer range as the trigger.

### Reasoning

This is not a preference; it is a hard dependency conflict I verified directly against the registry:

```
typescript-eslint@8.69.0  peerDependencies:
  eslint      ^8.57.0 || ^9.0.0 || ^10.0.0
  typescript  >=4.8.4 <6.1.0        ← excludes 7.x
```

TypeScript 7.0 ships **without a stable programmatic API** (targeted for 7.1), so every tool that walks the AST or asks the compiler for types — typescript-eslint, and with it every type-aware rule — cannot run on it. §3.2 mandates ESLint; §8.1 leans on type-aware correctness. Option 1 therefore means dropping type-aware linting on day one.

Option 2 works and is what larger teams are doing: keep `typescript@7` for the `tsc` binary and install `@typescript/typescript6@6.0.2` (verified to exist) under an alias so ESLint resolves a 6.x API. But it means two compilers in the lockfile, two versions of the type system that can disagree about a diagnostic, an aliasing trick every contributor must understand, and an editor that may load a third. For a repo whose stated audience includes "future AI-assisted sessions" (§8.3) and outside open-source contributors, that is a trap with a 10× compile-speed prize that is worth roughly *two seconds* on a monorepo this size.

Option 3 costs nothing real. `typescript@6.0.3` is a published stable release. TS 6's own defaults are already the modern ones; the upgrade to 7 is then a version bump plus a peer-range check, and it will happen in Stage 7 or shortly after.

**One thing to inherit from TS 7 now, because it costs nothing:** TS 7 makes `baseUrl` a hard error and requires `paths` to be project-relative. shadcn's Vite install page still prints the old `baseUrl` + `paths` pair. We write `paths` project-relative from the start, so the eventual bump is a no-op:

```jsonc
// apps/web/tsconfig.json  — no baseUrl anywhere in the repo
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["vite/client"],          // TS7 defaults `types` to []; be explicit now
    "paths": { "@/*": ["./src/*"] },   // project-relative, valid in TS6 and TS7
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src", "vite.config.ts"]
}
```

```jsonc
// tsconfig.base.json
{
  "compilerOptions": {
    "strict": true,
    "target": "es2023",
    "module": "esnext",
    "moduleResolution": "bundler",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true
  }
}
```

`noUncheckedIndexedAccess` matters more than usual here: the attribute value map is a `Record<slug, AttributeValue>` indexed by runtime-defined keys, and this flag is what forces every read of it through a null check.

### Consequences

- Typecheck stays a few seconds. Nobody notices.
- Type-aware ESLint rules work from day one.
- A dated line in `docs/DECISIONS.md`: *"Revisit when typescript-eslint's peer range admits ≥7.1."*

---

## 4. ADR-F3 — Routing: TanStack Router 1.170.32

### Options

1. **TanStack Router 1.170.32** — file-based routes, typed params *and typed search params* validated by a schema.
2. **React Router 8.3.1** (+ `nuqs@2.10.1` for typed search params).
3. **React Router 7.18.3** — the conservative previous major.
4. **`wouter` / hand-rolled** — too little for a 5-step wizard with shareable filtered views.

### Choice

**TanStack Router 1.170.32** in file-based mode via `@tanstack/router-plugin@1.168.35` (peer `vite >=8.0.0`, verified), SPA only — no TanStack Start, no SSR.

### Reasoning

Every router can do `/contacts/:id`. The brief's actual routing problem is **search params**, and they are not a side dish here — they carry the filter model, the sort, the visible column set and order, the pagination cursor, the wizard step, and the active saved view. §5.2 requires them to be shareable and bookmarkable; §6.6 requires a saved view to round-trip through them; §6.8 requires a 5-step wizard that survives a refresh.

TanStack Router treats search params as **typed, validated, structured state**, which is the exact thing we need:

- `validateSearch` accepts a Zod schema directly, so the *same* `listQuerySchema` that the Fastify route parses is the thing that parses the URL. One schema, two ends of the wire, zero drift. That is not available in React Router; `nuqs` gives per-key parsers but not one schema for the whole search object, and it does not validate the object as a unit.
- Reading is `Route.useSearch()` and it is fully typed — `search.filters[0].operator` autocompletes to the operator union for that attribute type.
- Writing is a functional updater — `navigate({ search: (prev) => ({ ...prev, cursor: undefined, sort }) })` — which is precisely how "changing a filter resets the cursor" should be expressed.
- `stripSearchParams` removes values equal to defaults from the URL, so `/contacts` stays `/contacts` until the user actually filters. This is the difference between a shareable link and a 900-character monster.
- `retainSearchParams` keeps chosen keys across navigations, which is how the ⌘K palette can jump around without dropping the user's view.

The counter-argument is real and worth stating: React Router is the boring choice by installed base, and §2.2 says prefer boring. But React Router **8.3.1** is itself only ~2.5 months old (8.0.0 on 2026-06-17), so "boring" would actually mean React Router 7.18.3 — deliberately starting one major behind — *and* bolting on a second library for the feature that matters most, *and* hand-writing the parse/serialise/validate layer that TanStack Router ships. TanStack Router has been 1.x-stable for over two years and is the same vendor as Query, Table and Virtual, which we are using anyway; that is one mental model and one release cadence, not four.

**SPA, not TanStack Start.** Start adds SSR, server functions and a Nitro server — a second place for logic, forbidden by §3.1's API-first rule. Not used, and worth writing down so nobody "upgrades" into it.

### Route tree

```
apps/web/src/routes/
  __root.tsx                        AppShell: sidebar, breadcrumb, ⌘K palette, Toaster
  index.tsx                         /                        → Dashboard (§6.1)
  contacts/
    index.tsx                       /contacts?…              → RecordTable (§6.2)
    $contactId.tsx                  /contacts/:id            → detail shell + tabs (§6.5)
    $contactId.index.tsx            /contacts/:id            → Overview
    $contactId.activities.tsx       /contacts/:id/activities
    $contactId.connections.tsx      /contacts/:id/connections
    $contactId.follow-ups.tsx       /contacts/:id/follow-ups
  organizations/
    index.tsx  $organizationId.tsx  …same shape
  follow-ups/index.tsx              /follow-ups?status=open  (§6.4 tabs are a search param)
  import/
    $objectType.tsx                 /import/contacts?step=map&batch=…   (§6.8)
  settings/
    profile.tsx
    objects.$objectType.attributes.tsx
    objects.$objectType.views.tsx
```

Tabs on the detail page are **child routes, not local state** — §6.5 lists four of them and a user must be able to send someone a link to the Activities tab. Follow-up quick-filter tabs are a search param, because they are a filter, and reusing the filter machinery is free.

### Router setup

```tsx
// apps/web/src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen'   // generated by @tanstack/router-plugin
import { queryClient } from './lib/query-client'
import '@mutuals/ui/globals.css'

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,          // let TanStack Query own staleness, not the router
  defaultNotFoundComponent: NotFound,
  defaultErrorComponent: RouteError,
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
```

`defaultPreloadStaleTime: 0` is deliberate: with both a router cache and a query cache, one of them must be the authority on freshness or you get two answers to "is this stale". Query wins; the router just triggers the fetch on hover.

### Consequences

- Every filtered table view is a URL that can be pasted into Slack. That is a product feature, delivered by the router choice.
- `routeTree.gen.ts` is generated; it is gitignored and regenerated by `pnpm dev`/`pnpm build`, and CI runs the generator before typecheck.
- Route-level code splitting is on (`autoCodeSplitting: true`), so the import wizard's parser UI and the settings screens do not sit in the contacts-table bundle.

---

## 5. ADR-F4 — What goes in the URL, and how it is encoded

### Options

1. **Flat, human-readable keys** — `?job_role=in:investor,angel&city=contains:munich&sort=-check_size`.
2. **One JSON blob** — `?q={"filters":[…],"sort":{…}}`, TanStack Router's default JSON-per-key serialisation.
3. **Opaque base64 / a server-side "view token"** — `?v=eyJ…`.

### Choice

**Option 2, with the schema shared with the API**: TanStack Router's default `parseSearchWith(JSON.parse)` / `stringifySearchWith(JSON.stringify)`, one Zod schema in `packages/core`, `stripSearchParams` to keep defaults out of the URL.

### Reasoning

Option 1 is prettier and is what I would pick for a fixed schema. It fails here for a specific reason: **attribute slugs are user-defined at runtime** (§4.2), so a flat scheme puts arbitrary user strings in search-param *keys*. Then `?city=…` collides with `?cursor=…` the day someone creates an attribute called `cursor`, and the reserved-word list has to be enforced twice — in `packages/core`'s slug validator *and* in the URL parser. Nesting the filters inside one `filters` key removes the entire collision class: user data is never a key, only a value.

Option 3 gives short URLs and destroys the property the brief actually asks for. §5.2's point is that a view can be *shared* and *inspected*; an opaque token also means the Ask-the-network flow's "How I searched" panel (§6.1) cannot simply render the URL's filter array back to the user. And a server-side token needs a table and a lifecycle. Rejected as both less useful and more work.

The decisive argument for Option 2 is that the filter model already exists exactly once, in `packages/core`, because the storage decision's compiler consumes it and §7 says the API's list endpoints use "the same filter model the DataTable uses". So:

```ts
// packages/core/src/filters/schema.ts   — imported by apps/api AND apps/web
import { z } from 'zod'

export const filterOperator = z.enum([
  'contains', 'equals', 'is_empty', 'is_not_empty',
  'eq', 'ne', 'lt', 'gt', 'between',
  'before', 'after',
  'is_yes', 'is_no',
  'is_one_of', 'is_not_one_of',
  'contains_any_of', 'contains_all_of',
  'has_any_of',
  'older_than_days', 'within_last_days',
])

/** `field` is an attribute slug OR a derived-column key (`metrics.warmth`, …). */
export const filterClause = z.object({
  field: z.string().min(1).max(64),
  op: filterOperator,
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]).optional(),
})

export const sortSpec = z.object({
  field: z.string().min(1).max(64),
  dir: z.enum(['asc', 'desc']),
})

/** The one query shape. §5.2 says filters combine with AND only — so this is a flat array. */
export const listQuerySchema = z.object({
  filters: z.array(filterClause).max(20).default([]),
  sort: sortSpec.optional(),
  q: z.string().max(200).optional(),        // §5.2 quick search box
  cursor: z.string().max(512).optional(),   // opaque, per storage-DECISION §5.1
  limit: z.number().int().min(1).max(200).default(100),
  view: z.uuid().optional(),                // §6.6 the saved view this page started from
  cols: z.array(z.string().max(64)).optional(),   // visible columns, in display order
})

export type ListQuery = z.output<typeof listQuerySchema>
```

Note the AND-only flat array: it is not a simplification for the UI's sake, it is the storage decision's §1.5 requirement (an `OR` between two `EXISTS` sublinks defeats the semi-join pull-up). The shape of the URL and the shape of the query plan agree by construction.

```tsx
// apps/web/src/routes/contacts/index.tsx
import { createFileRoute, stripSearchParams, retainSearchParams } from '@tanstack/react-router'
import { listQuerySchema } from '@mutuals/core/filters'

const defaults = { filters: [], limit: 100 } as const

export const Route = createFileRoute('/contacts/')({
  validateSearch: listQuerySchema,
  search: { middlewares: [stripSearchParams(defaults), retainSearchParams(['view'])] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureInfiniteQueryData(recordsQuery('contact', deps)),
  component: ContactsPage,
})
```

`stripSearchParams(defaults)` is what keeps `/contacts` clean. `loaderDeps` + `ensureInfiniteQueryData` is what makes the first page arrive during navigation instead of after it, without the router owning the cache.

### The unavoidable trade-off, stated

JSON-in-a-query-param is ugly: `?filters=%5B%7B%22field%22…`. A 6-chip filter is ~400 characters. It is under every practical URL limit, it round-trips exactly (which the router docs correctly insist on), and it is decodable by anyone with a browser console. Prettier alternatives (JSURL2, zipson) add a dependency and a custom codec for cosmetics. If it ever bothers Simon, the fix is one `createRouter` option, no schema change, no API change.

---

## 6. ADR-F5 — Server state: TanStack Query 5.102.8, and no client store

### Options

1. **TanStack Query 5.102.8.**
2. **SWR.**
3. **TanStack Router loaders alone** (the router does have a cache).
4. **Redux Toolkit / Zustand + RTK Query.**

### Choice

**TanStack Query 5.102.8**, and — the more important half — **no global client-state store at all**.

Verified: `@tanstack/react-query@5.102.8` is the current stable React release; v6 exists only as framework-specific adapters (Svelte/Solid) over the same v5 core. There is no v6 React upgrade to anticipate.

### Reasoning

The second half is the real decision. Reach for Zustand and you immediately have three homes for "the current filter set": the URL, the store, and Query's cache key. They drift, and the bug is always the same — the URL says one thing and the table shows another after a back-button press. So:

| State | Home |
|---|---|
| Filters, sort, visible columns, cursor, wizard step, active view | **The URL** (ADR-F4) |
| Everything fetched from the API | **TanStack Query** cache, keyed by the URL-derived query |
| Open dialog, focused cell, "is this row being edited" | **Local `useState`**, unlifted |
| Attribute definitions | A Query with `staleTime: Infinity`, invalidated by attribute mutations |

That table is the whole state architecture. It fits on a slide, and a future contributor cannot put something in the wrong place because there is no wrong place available.

Query over SWR because of three things we need on day one and would otherwise write: `useInfiniteQuery` with a cursor (the storage decision's opaque cursor, ADR-F8), first-class mutation lifecycle hooks for optimistic rollback, and query *cancellation* (`cancelQueries`) which is what makes optimistic cell edits safe. Query over router loaders alone because loaders are per-navigation, and inline cell editing needs to patch a cached list *without* navigating. Query over RTK Query because Redux's tooling exists to manage client state we have just decided not to have.

### Query keys and the fetch client

```ts
// apps/web/src/lib/query-keys.ts
export const qk = {
  attributes: (objectType: ObjectType) => ['attributes', objectType] as const,
  records:    (objectType: ObjectType, q: ListQuery) => ['records', objectType, q] as const,
  record:     (id: string) => ['record', id] as const,
  factHistory:(id: string, attributeId: string) => ['facts', id, attributeId] as const,
  views:      (objectType: ObjectType) => ['views', objectType] as const,
  stats:      () => ['stats'] as const,
}
```

The list key **is** the validated search object. Change a filter → the URL changes → the key changes → Query fetches. There is no `useEffect` anywhere in the data path.

```ts
// apps/web/src/lib/api.ts — thin, typed, no codegen (see ADR-F6)
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,     // shared shape from @mutuals/core
  ) { super(body.message) }
  /** §7: "validation errors per field" — drives RHF setError and inline cell errors. */
  fieldErrors(): Record<string, string> {
    return Object.fromEntries((this.body.issues ?? []).map((i) => [i.path, i.message]))
  }
}

export async function api<T>(
  path: string,
  init: RequestInit & { schema: z.ZodType<T> },
): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
  const json = res.status === 204 ? null : await res.json()
  if (!res.ok) throw new ApiError(res.status, apiErrorSchema.parse(json))
  // Parse, don't cast. The cost is microseconds; the benefit is that a backend
  // contract change surfaces as a loud error in dev instead of `undefined.map`.
  return init.schema.parse(json)
}
```

Parsing responses through the shared Zod schema rather than `as T` is a deliberate 20-line insurance policy. It is the mechanism that makes ADR-F6 (no codegen) safe.

### Optimistic inline cell edits — the actual design

§5.2: "Inline editing … Save on blur; optimistic update; error toast on failure." Two facts make the naive version wrong:

1. The server **normalises**. A phone becomes E.164, a tag becomes its canonical `value_key`, text gets trimmed. The optimistic value is a *guess*; the server's response is the truth.
2. A write is `POST /records/:id/facts` — appending a fact — and the response returns the projected current value. So the mutation's response is exactly the patch we want.

```tsx
// apps/web/src/features/records/use-set-attribute-value.ts
export function useSetAttributeValue(objectType: ObjectType) {
  const qc = useQueryClient()

  return useMutation({
    // One in-flight write per (record, attribute). Two edits to the same cell serialise;
    // edits to different cells run in parallel.
    scope: undefined,
    mutationFn: (v: SetValueInput) =>
      api(`/records/${v.recordId}/values/${v.slug}`, {
        method: 'PUT',
        body: JSON.stringify({ value: v.value, source: 'manual' }),
        schema: recordValueSchema,
      }),

    onMutate: async (v) => {
      // Without this, an in-flight list refetch can land AFTER the optimistic patch
      // and overwrite it with stale data. This is the single most-forgotten line.
      await qc.cancelQueries({ queryKey: ['records', objectType] })
      await qc.cancelQueries({ queryKey: qk.record(v.recordId) })

      const snapshot = qc.getQueriesData({ queryKey: ['records', objectType] })

      // Patch every cached page of every cached list that contains this record.
      qc.setQueriesData<InfiniteData<RecordPage>>(
        { queryKey: ['records', objectType] },
        (old) => old && {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            rows: p.rows.map((r) =>
              r.id === v.recordId
                ? { ...r, values: { ...r.values, [v.slug]: optimistic(v) }, _pending: v.slug }
                : r),
          })),
        },
      )
      qc.setQueryData<RecordDetail>(qk.record(v.recordId), (old) =>
        old && { ...old, values: { ...old.values, [v.slug]: optimistic(v) } })

      return { snapshot }
    },

    onError: (err, v, ctx) => {
      ctx?.snapshot.forEach(([key, data]) => qc.setQueryData(key, data))
      toast.error(
        err instanceof ApiError ? err.body.message : 'Could not save',
        { action: { label: 'Retry', onClick: () => mutate(v) } },
      )
    },

    // Write the SERVER's value back — normalised, with its new fact id — so the cell
    // shows what was actually stored, not what was typed.
    onSuccess: (serverValue, v) => {
      qc.setQueriesData<InfiniteData<RecordPage>>(
        { queryKey: ['records', objectType] },
        (old) => old && { ...old, pages: old.pages.map((p) => ({
          ...p,
          rows: p.rows.map((r) =>
            r.id === v.recordId
              ? { ...r, values: { ...r.values, [v.slug]: serverValue }, _pending: undefined }
              : r),
        })) },
      )
      qc.invalidateQueries({ queryKey: qk.factHistory(v.recordId, v.attributeId) })
    },

    // NO blanket invalidateQueries on settle. Re-running Q1+Q2+Q3 after every keystroke-
    // committed cell edit would make a 60-column table feel worse, not better, and can
    // yank a row out from under the user if the edit changed the sort key. Rows leave the
    // view on the next real refetch (navigation, window focus), not mid-edit.
  })
}
```

Three points a reviewer should push on, answered:

- **Why not React 19's `useOptimistic`?** It is scoped to a component's transition and evaporates when that component unmounts. Our optimistic value has to survive the cell unmounting (virtualisation scrolls it out of the DOM the instant the user scrolls) and has to be visible to the detail page's sidebar showing the same value. That is cache state, not render state. `useOptimistic` is right for a form submission; wrong for this.
- **Why not invalidate on settle?** Answered inline above; it is the difference between "instant" and "flickers and reorders".
- **What about a filter that the edited row no longer matches?** It stays visible until the next real refetch, and that is the correct product behaviour — Notion and Airtable both do this. Removing a row from under the cursor the moment you finish typing is hostile.

**Latency budget.** Query devtools + a Stage 7 assertion: p95 from blur to committed cell state under 150 ms locally. That is a real budget, not a hope, and it is measurable in the Playwright e2e.

---

## 7. ADR-F6 — Types across the API boundary: one Zod package, no codegen

### Options

1. **Shared Zod schemas** in `packages/core`, imported by both `apps/api` and `apps/web`; OpenAPI generated from those same schemas for non-TypeScript clients.
2. **OpenAPI codegen** — `openapi-typescript@7.13.0` + `openapi-fetch@0.17.0` reading the API's emitted spec.
3. **tRPC.**
4. **Hand-written types in the frontend.**

### Choice

**Option 1.** The web app imports `@mutuals/core`; the OpenAPI document is *emitted from* the same schemas by `fastify-type-provider-zod` and served at `/api/docs` for the MCP server, the CLI, and Python scripts (§3.2, §7).

### Reasoning

Option 4 is what §3.2 explicitly forbids. Option 3 is what §3.2 tells us to justify or avoid; it also makes the "everything the UI can do, the API can do" promise harder, since tRPC's surface is not the REST surface.

The real contest is 1 vs 2, and it turns on a detail: `openapi-typescript@7.13.0` declares `peerDependencies: { typescript: "^5.x" }` — verified. We are on TypeScript 6 (ADR-F2). pnpm would warn rather than fail, but adopting a codegen step whose declared peer range excludes our compiler is starting from a lie. On top of that, codegen adds a build-order dependency (API must run to emit the spec before the web app can typecheck), a generated file in the repo or in CI, and a drift window between the two.

Option 1 has none of that and gains something codegen cannot give: **the same schema object** — not the same *shape*, the same object — validates the HTTP request in Fastify, validates the URL in TanStack Router (ADR-F4), validates the form in React Hook Form (ADR-F7), and parses the response in the fetch client (ADR-F5). One definition, four uses. The typed-end-to-end requirement is satisfied by construction rather than by a pipeline.

The one thing codegen would give us — proof that the served OpenAPI matches the running server — we get more cheaply: the OpenAPI document is generated *from* the schemas, so it cannot describe anything the server does not implement.

**Zod 4 specifics I verified and that the code must respect:**

- `message:` → `error:` in every schema. `invalid_type_error` / `required_error` are gone.
- `z.string().email()` → `z.email()`, `z.string().uuid()` → `z.uuid()` (top-level, tree-shakable; the old forms are deprecated).
- `z.record(z.string(), z.string())` — the one-argument form is an error in v4. Our `values: Record<slug, Value>` map hits this.
- `.default()` now applies to the **output** type and short-circuits parsing; `.prefault()` is the v3 behaviour. Relevant to `listQuerySchema.filters.default([])`.
- `error.errors` is gone; use `error.issues`. `.format()` / `.flatten()` are deprecated in favour of `z.treeifyError()` / `z.flattenError()`.
- `z.toJSONSchema()` is built in, which is how the attribute-definition config schemas become the LLM's structured-output schemas in Stage 6 without a second library.

```ts
// packages/core/src/api/records.ts  — one schema, used at both ends
export const recordValueSchema = z.object({
  slug: z.string(),
  kind: z.enum(['text', 'number', 'date', 'bool', 'option', 'relation']),
  display: z.string(),                 // pre-rendered display string from the API
  raw: z.unknown(),                    // typed per-kind by the discriminated union below
  factId: z.uuid(),
  source: z.enum(['manual','import','quick_capture','agent','gmail','calendar','crawler']),
  updatedAt: z.iso.datetime(),
})

export const recordRowSchema = z.object({
  id: z.uuid(),
  displayLabel: z.string(),
  createdAt: z.iso.datetime(),
  values: z.record(z.string(), recordValueSchema),   // z.record needs BOTH args in Zod 4
  metrics: contactMetricsSchema.nullable(),          // LEFT JOIN — may be absent
})

export const recordPageSchema = z.object({
  rows: z.array(recordRowSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nullable(),   // null when the API returned an estimate; see §5.1 Q3
  totalIsEstimate: z.boolean(),
})
```

`total: number | null` + `totalIsEstimate` is not decoration: the storage decision caps exact counts and estimates above a threshold. The footer must be able to render `Rows: ~12,000` honestly rather than lying with a precise-looking number.

### Consequences

- `packages/core` must stay **runtime-dependency-free apart from Zod** — it is imported by the browser bundle. No `pg`, no Fastify, no Node built-ins. Enforced by an ESLint `no-restricted-imports` rule in that package and by a CI check that `packages/core` builds for the `browser` condition.
- If a non-TS consumer ever needs generated clients, `openapi-typescript` can be run against `/api/docs` at that point. Nothing about this decision blocks it.

---

## 8. ADR-F7 — Forms: React Hook Form 7.87.0 + `zodResolver`, plus a runtime schema builder

### Options

1. **React Hook Form 7.87.0** + `@hookform/resolvers@5.9.1` (`zodResolver`).
2. **TanStack Form 1.33.5.**
3. **Uncontrolled forms + manual validation.**
4. **React 19 Actions / `useActionState`.**

### Choice

**React Hook Form 7.87.0** with `zodResolver` from `@hookform/resolvers@5.9.1`, driven by schemas **built at runtime from attribute definitions**.

Verified: `@hookform/resolvers` 5.9.1 is current and its documented Zod entry point remains `import { zodResolver } from '@hookform/resolvers/zod'`. React Hook Form 8 exists only as `8.0.0-beta.3`; we stay on stable 7.87.0.

### Reasoning

TanStack Form is the coherent-vendor choice and I considered it seriously, since we already take Router/Query/Table/Virtual from TanStack. It loses on two counts: shadcn's `Form` component — which the brief mandates we use — is built on RHF's `FormProvider`/`Controller`/`useFormContext`, so `shadcn add form` produces RHF code; and RHF's uncontrolled-by-default model means a 40-field "Add contact" dialog re-renders on error state changes, not on every keystroke. React 19 Actions are for progressive-enhancement server submissions, which is not our shape (JSON API + optimistic cache).

The interesting problem is not which library. It is that **the form's shape is data**. §5.3: the create dialog shows system fields, then custom attributes grouped by `group`. §6.5: the detail sidebar is one inline-editable field per attribute. §6.7: the create-attribute dialog's *own* fields change based on the selected type. None of these can be a static Zod object.

So `packages/core` exports the builder, and both the API and the web app use it — meaning a custom attribute's validation rule exists exactly once:

```ts
// packages/core/src/attributes/build-schema.ts
import { z } from 'zod'
import type { AttributeDefinition } from './types'

export function fieldSchema(def: AttributeDefinition): z.ZodType {
  const base = (() => {
    switch (def.type) {
      case 'short_text': return z.string().trim().max(255)
      case 'long_text':  return z.string()
      case 'url':        return z.url()
      case 'email':      return z.email()
      case 'phone':      return z.string().trim().max(32)
      case 'number': {
        let n = z.number()
        if (def.config.min !== undefined) n = n.min(def.config.min)
        if (def.config.max !== undefined) n = n.max(def.config.max)
        return n
      }
      case 'date':       return z.iso.date()
      case 'yes_no':     return z.boolean()
      case 'single_select':
        return z.enum(def.options.map((o) => o.key) as [string, ...string[]])
      case 'multi_select':
        return z.array(z.enum(def.options.map((o) => o.key) as [string, ...string[]]))
      case 'tags':       return z.array(z.string().trim().min(1).max(512))
      case 'relation':   return def.isMulti ? z.array(z.uuid()) : z.uuid()
    }
  })()
  // "Empty" is one concept (storage-DECISION §3.3): no value. Never '' , never [].
  return def.required ? base : base.nullish()
}

export function recordFormSchema(defs: AttributeDefinition[]) {
  return z.object(Object.fromEntries(defs.map((d) => [d.slug, fieldSchema(d)])))
}
```

```tsx
// apps/web/src/features/records/record-form.tsx
export function RecordForm({ defs, defaults, onSubmit }: RecordFormProps) {
  const schema = React.useMemo(() => recordFormSchema(defs), [defs])
  const form = useForm({ resolver: zodResolver(schema), defaultValues: defaults })

  // §5.3 / §6.5: attributes render grouped by `group`, ungrouped under "Details".
  const groups = React.useMemo(() => groupBy(defs, (d) => d.group ?? 'Details'), [defs])

  const submit = form.handleSubmit(async (values) => {
    try { await onSubmit(values) }
    catch (e) {
      // §7 "validation errors per field" mapped straight onto the form
      if (e instanceof ApiError) {
        for (const [path, message] of Object.entries(e.fieldErrors()))
          form.setError(path as never, { message })
        return
      }
      throw e
    }
  })

  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-6">
        {Object.entries(groups).map(([group, groupDefs]) => (
          <FieldGroup key={group} title={group}>
            {groupDefs.map((def) => (
              <FormField
                key={def.slug}
                control={form.control}
                name={def.slug}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {def.title}
                      {def.required && <span className="text-destructive"> *</span>}
                    </FormLabel>
                    <FormControl>
                      {/* the ONE registry — see ADR-F10 */}
                      <AttributeInput def={def} {...field} />
                    </FormControl>
                    {def.description && <FormDescription>{def.description}</FormDescription>}
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
          </FieldGroup>
        ))}
      </form>
    </Form>
  )
}
```

The red asterisk in §5.3, the grouping in §5.3/§6.5, and the inline error style in §6.7's reference screenshot all fall out of this one component. There is no second form component for organizations.

### Consequences

- A new attribute type is: one case in `fieldSchema`, one entry in the `AttributeInput` registry, one entry in the cell-renderer registry. Three places, all adjacent, all covered by the same unit test table.
- The `zodResolver` + `.default()` interaction is a known sharp edge: with defaults, RHF's input and output types diverge and the three `useForm` generics must be given explicitly (`useForm<z.input<S>, unknown, z.output<S>>`). Noted here so nobody rediscovers it at 11 pm.

---

## 9. ADR-F8 — shadcn/ui in the monorepo, on Tailwind 4

### Options

1. **`packages/ui` as a shared workspace** (`@mutuals/ui`), the shadcn CLI's documented monorepo layout.
2. **Components directly in `apps/web/src/components/ui`**, no shared package.
3. **A published/pre-built component library.**

### Choice

**Option 1**, using the shadcn CLI's native monorepo support (`shadcn@4.20.1`, released 2026-09-02), Tailwind 4.3.3 with an empty `tailwind` block in `components.json`, and **Radix** primitives — not Base UI.

### Reasoning

Option 3 contradicts how shadcn works and §3.1's "components are copied into the repo and may be adapted". Option 2 is genuinely tempting — there is exactly one app — and I rejected it for a concrete reason rather than a speculative one: §7 and §9 promise a CLI and an MCP server, §6.8's import wizard is a full-page flow that is a plausible future standalone surface, and more immediately, **`packages/ui` is where the Tailwind theme lives**. Keeping tokens in a package that owns `globals.css` means the design tokens have one home and are importable by Storybook, by a future second surface, or by nothing at all — at a cost of one `package.json`. The CLI supports it natively, so the cost really is one file.

Verified from shadcn's own docs: each workspace needs its own `components.json`; `style`, `iconLibrary` and `baseColor` must match across them; **for Tailwind v4 the `tailwind` config block is left empty**; running `pnpm dlx shadcn@latest add <component>` from `apps/web` places base primitives in `packages/ui` and app-specific blocks in `apps/web`, rewriting imports. CLI v4 removed the `--style`, `--base-color`, `--src-dir`, `--no-base-style` and `--css-variables` flags (they now error), added `--monorepo`, `--base radix|base-ui`, `--dry-run`, `--diff` and a preset system.

**Radix, not Base UI.** CLI v4's `--base` flag offers both. `@base-ui-components/react` is at `1.0.0-rc.0` — verified. `radix-ui` is at 1.6.7 and stable. §2.2 says prefer boring; §3.1 says animate-ui must be droppable in later, and animate-ui is built on the shadcn+Radix baseline. Radix.

### Real files

```
packages/ui/
  package.json
  components.json
  src/
    styles/globals.css        ← the theme (ADR-F12). The ONLY place colours are defined.
    lib/utils.ts              ← cn()
    components/               ← button, dialog, table, command, popover, select, …
apps/web/
  components.json
  src/components/             ← app-specific composites (RecordTable, FilterBar, …)
```

```jsonc
// packages/ui/components.json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": { "config": "", "css": "src/styles/globals.css", "baseColor": "neutral", "cssVariables": true },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@mutuals/ui/components",
    "utils": "@mutuals/ui/lib/utils",
    "ui": "@mutuals/ui/components",
    "hooks": "@mutuals/ui/hooks",
    "lib": "@mutuals/ui/lib"
  }
}
```

```jsonc
// apps/web/components.json  — same style / iconLibrary / baseColor, different aliases
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": { "config": "", "css": "../../packages/ui/src/styles/globals.css", "baseColor": "neutral", "cssVariables": true },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "ui": "@mutuals/ui/components",
    "utils": "@mutuals/ui/lib/utils",
    "hooks": "@/hooks",
    "lib": "@/lib"
  }
}
```

```jsonc
// packages/ui/package.json — source exports; Vite compiles them, no build step
{
  "name": "@mutuals/ui",
  "type": "module",
  "exports": {
    "./globals.css": "./src/styles/globals.css",
    "./components/*": "./src/components/*.tsx",
    "./lib/*": "./src/lib/*.ts",
    "./hooks/*": "./src/hooks/*.ts"
  }
}
```

Shipping **source, not a build** from `packages/ui` is deliberate: it removes a build step from `pnpm dev`, keeps HMR working across the package boundary, and keeps Tailwind's class scanning simple. The cost — consumers must be able to compile TSX — is zero, because the only consumer is a Vite app.

Tailwind 4 scans `packages/ui` automatically via its heuristics; to be explicit and immune to that, `globals.css` declares the source:

```css
@import "tailwindcss";
@source "../../../../apps/web/src";
```

### Consequences

- `pnpm dlx shadcn@latest add table dialog command popover select checkbox …` from `apps/web` does the right thing without hand-editing imports.
- One rule for `CLAUDE.md`: **never hand-edit a file under `packages/ui/src/components` except to add a variant**; `shadcn diff` must stay meaningful so upstream fixes can be pulled in.
- `tw-animate-css@1.4.0` replaces `tailwindcss-animate` (v3-era). One import line.

---

## 10. ADR-F9 — The DataTable: TanStack Table 9.2.4, server-driven

### Options

1. **`@tanstack/react-table@9.2.4`** — current, and what shadcn's data-table docs now use.
2. **`@tanstack/react-table@8.21.3` pinned** — the last v8; every blog post and every pre-2026 example.
3. **`useLegacyTable`** from v9's `/legacy` entry point — v8 API on a v9 core.
4. **Hand-rolled table** — we use so little of the library that this is not absurd.

### Choice

**`@tanstack/react-table@9.2.4`**, native v9 API, with **no row models registered** and `manual*: true` everywhere.

### Reasoning — and a correction to the obvious first answer

My first instinct was Option 2. TanStack Table 9.0.0 shipped 2026-08-04 — **thirty days ago** — with nine releases since; shadcn issue #11389 (opened the same day) reported that shadcn's data-table examples were still on v8 while `@tanstack/react-table@latest` had begun resolving to v9, and recommended pinning `^8.21.3`. "Prefer boring" plus "use shadcn's data-table pattern" seemed to add up to v8.

I checked the live docs instead of trusting the issue, and the premise has expired: **`ui.shadcn.com/docs/components/data-table` now uses v9 verbatim** — `tableFeatures()`, `useTable`, `createColumnHelper<DataTableFeatures, Payment>()`, `<table.FlexRender header={header} />`. So the brief's fixed decision ("use shadcn's data-table pattern") *is* v9 as of today. Pinning v8 would mean deliberately diverging from the mandated pattern to chase a staleness that no longer exists, and every future `shadcn add` of a table-adjacent block would emit v9 code into a v8 codebase.

Option 3 is explicitly deprecated by its own authors and bundles every feature. Option 4 loses column ordering, pinning, visibility, sizing and header groups — three hundred lines of well-tested code — for nothing.

The residual risk of a 30-day-old major is real, and here is why it is small **for us specifically**: this table does **no client-side work**. Filtering, sorting and pagination are the storage decision's Q1/Q2/Q3. So we register no row models and touch none of the surface that changed most between v8 and v9 (row-model factories, sort/filter fns, faceting). What we use — `useTable`, `getHeaderGroups`, `getRowModel().rows`, `FlexRender`, column visibility/ordering/pinning/sizing, row selection — is a small, stable core, and it lives behind one component. If v9 churns, the blast radius is `record-table.tsx`.

**Verified v9 breaking changes that this code must obey:**

| v8 | v9 |
|---|---|
| `useReactTable(options)` | `useTable(options)`, `features` required |
| `getCoreRowModel()` passed as an option | core row model is implicit; never registered |
| `getSortedRowModel()` etc. | `sortedRowModel: createSortedRowModel()` inside `tableFeatures()` |
| `ColumnDef<TData, TValue>` | `ColumnDef<TFeatures, TData, TValue>` |
| `createColumnHelper<TData>()` | `createColumnHelper<TFeatures, TData>()` |
| `sortingFn` / `sortingFns` / `getSortingFn()` | `sortFn` / `sortFns` / `getSortFn()` |
| `columnPinning: { left, right }`, `pin('left')`, `getLeftHeaderGroups()` | `{ start, end }`, `pin('start')`, `getStartHeaderGroups()` |
| `enablePinning` | `enableColumnPinning` / `enableRowPinning` |
| sizing+resizing one feature; `columnSizingInfo` | `columnSizingFeature` + `columnResizingFeature`; state renamed `columnResizing` |
| `table.getState()` | `table.state`, `table.store.state`, or a selector passed to `useTable` |
| `onStateChange` | `table.store.subscribe()` |
| destructured `const { getValue } = row` | must call on the instance: `row.getValue()` |
| `flexRender(...)` | still works; `<table.FlexRender />` is the new component form |

The pinning rename is not cosmetic for us: §5.2 requires a **sticky first column** (the Name column), which is `columnPinning: { start: ['display_label'] }`.

### The feature set, and why each is there

```ts
// apps/web/src/features/table/table-features.ts
import {
  tableFeatures,
  columnVisibilityFeature,   // §5.2 "Columns 10/14" toggle
  columnOrderingFeature,     // §5.2 reorder by drag
  columnPinningFeature,      // §5.2 sticky first column  → { start: [...] }
  columnSizingFeature,       // per-column widths persisted in the saved view
  columnResizingFeature,     // v9 split this out of sizing
  rowSelectionFeature,       // §5.2 checkboxes + bulk action bar
  rowSortingFeature,         // header affordances only — see manualSorting below
} from '@tanstack/react-table'

/**
 * NO row models are registered. The server filters, sorts and paginates
 * (storage-DECISION §5). Registering a row model here would silently re-sort the
 * 100 rows of the current page and produce a table that is locally sorted and
 * globally wrong — the worst kind of bug, because it looks right on page 1.
 */
export const recordTableFeatures = tableFeatures({
  columnVisibilityFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  columnResizingFeature,
  rowSelectionFeature,
  rowSortingFeature,
})

export type RecordTableFeatures = typeof recordTableFeatures
```

That comment is the single most important line in the frontend. It is going in `CLAUDE.md` verbatim.

### The component

```tsx
// apps/web/src/features/table/record-table.tsx
export function RecordTable({ objectType, defs, query }: RecordTableProps) {
  const navigate = useNavigate({ from: Route.fullPath })

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery(recordsQuery(objectType, query))

  const rows = React.useMemo(() => data?.pages.flatMap((p) => p.rows) ?? [], [data])
  const columns = useRecordColumns(defs, query.cols)      // ADR-F10

  const table = useTable({
    features: recordTableFeatures,
    data: rows,
    columns,
    getRowId: (row) => row.id,

    // Every one of these says: the server already did it.
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,

    // Sorting state is URL state. The table renders it; the URL owns it.
    state: {
      sorting: query.sort ? [{ id: query.sort.field, desc: query.sort.dir === 'desc' }] : [],
      columnVisibility, columnOrder, columnSizing,
      columnPinning: { start: ['__select', 'display_label'], end: [] },
    },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function'
        ? updater(query.sort ? [{ id: query.sort.field, desc: query.sort.dir === 'desc' }] : [])
        : updater
      const s = next[0]
      // Changing the sort invalidates the cursor — the storage decision's cursor is
      // opaque and sort-specific. Dropping it here is what keeps that contract honest.
      navigate({
        search: (prev) => ({
          ...prev,
          sort: s ? { field: s.id, dir: s.desc ? 'desc' : 'asc' } : undefined,
          cursor: undefined,
        }),
      })
    },
    enableColumnPinning: true,
  })

  return (
    <TableShell
      table={table}
      rows={rows}
      total={data?.pages[0]?.total ?? null}
      totalIsEstimate={data?.pages[0]?.totalIsEstimate ?? false}
      onReachEnd={() => { if (hasNextPage && !isFetchingNextPage) void fetchNextPage() }}
    />
  )
}
```

Sorting a non-sortable type is a 400 from the API (storage-DECISION §3.1). The frontend must not rely on that: `enableSorting: def.sortable` on each column def means the header simply is not clickable, and the 400 stays a backstop for hand-edited URLs.

### Consequences

- Any table snippet found on the internet dated before ~August 2026 is v8 and will not compile. `CLAUDE.md` gets an explicit "we are on TanStack Table v9; `useReactTable` and `getCoreRowModel` do not exist here" line, because that is exactly the mistake a model with older training data will make.
- One `RecordTable` serves Contacts, Organizations, Follow-ups, Interactions, Attributes and the import Review grid, as §5.2 demands. The Attributes list and the Review grid pass *static* column arrays through the same component — the factory in ADR-F10 is just one producer of `ColumnDef[]`.

---

## 11. ADR-F10 — Runtime-defined columns: the factory and the two registries

This is the heart of the frontend, the way §4.2 is the heart of the product. It gets its own ADR because getting it wrong means hard-coding columns, which the brief forbids in `CLAUDE.md` itself: *"attribute definitions drive everything — never hard-code a column."*

### Options

1. **Hard-code system columns; render custom attributes through one generic "custom" column.**
2. **Generate every column, system and custom alike, from a definition list** — where system attributes and derived columns are definitions too.
3. **Server-rendered column descriptors** — the API returns render instructions per column.

### Choice

**Option 2.** `GET /api/v1/attribute-definitions?object_type=contact` returns *one* array containing system attributes, custom attributes and derived pseudo-columns (`is_derived: true`), exactly as the storage decision already models them. The frontend has one kind of column.

### Reasoning

Option 1 produces two code paths, and every feature then has to be built twice — the Columns picker, the filter picker, the cell renderer, the inline editor, the CSV export. Worse, the derived columns (`last_interaction_at`, `warmth`, `open_followups`) belong to neither path, so they become a *third*. §5.2 explicitly says derived columns must appear "in the Columns picker like any other attribute". Two paths cannot satisfy that without a third.

Option 3 moves rendering decisions into the API, which breaks the API's own contract (it serves an MCP server and a CLI, neither of which wants React render instructions) and makes the UI un-styleable without a deploy.

Option 2's cost is that `createColumnHelper` — a *compile-time* type-inference helper — is not usable for runtime columns. That is fine: we build plain `ColumnDef<RecordTableFeatures, RecordRow>` objects. The helper is still used for the genuinely static tables (Attributes list, Import Review).

### The factory

```tsx
// apps/web/src/features/table/use-record-columns.tsx
import type { ColumnDef } from '@tanstack/react-table'
import type { AttributeDefinition, RecordRow } from '@mutuals/core'

export function useRecordColumns(
  defs: AttributeDefinition[],
  visibleOrder: string[] | undefined,
): ColumnDef<RecordTableFeatures, RecordRow>[] {
  return React.useMemo(() => {
    const byKey = new Map(defs.map((d) => [d.key, d]))
    const ordered = visibleOrder?.length
      ? visibleOrder.map((k) => byKey.get(k)).filter(Boolean as unknown as (d?: AttributeDefinition) => d is AttributeDefinition)
      : defs.filter((d) => d.showByDefault).sort((a, b) => a.position - b.position)

    return [
      selectionColumn,                    // §5.2 checkboxes; pinned start
      ...ordered.map(toColumnDef),
    ]
  }, [defs, visibleOrder])
}

function toColumnDef(def: AttributeDefinition): ColumnDef<RecordTableFeatures, RecordRow> {
  return {
    id: def.key,                                   // slug, or "metrics.warmth" for derived
    header: () => <ColumnHeader def={def} />,      // icon + title + sort arrow, §5.2
    // accessorFn, not accessorKey: keys contain dots and are user-defined, and
    // accessorKey would treat "metrics.warmth" as a deep path into the row object.
    accessorFn: (row) => readValue(row, def),
    cell: (ctx) => <AttributeCell def={def} row={ctx.row.original} />,
    enableSorting: def.sortable,                   // storage-DECISION §3.1
    enableHiding: !def.isPrimaryLabel,
    enableResizing: true,
    size: def.uiWidth ?? defaultWidthFor(def.type),
    meta: { def } satisfies RecordColumnMeta,      // typed via module augmentation
  }
}

declare module '@tanstack/react-table' {
  interface ColumnMeta<TFeatures, TData, TValue> {
    def?: AttributeDefinition
  }
}
```

The `accessorFn`-not-`accessorKey` note is the kind of thing that costs an afternoon if it is not written down: `accessorKey: "metrics.warmth"` silently does a deep property lookup, and user-created slugs can contain characters that make that lookup do something surprising.

### The two registries

Everything type-specific in the UI lives in exactly two switch statements, side by side in one folder, so adding an attribute type is a mechanical change:

```
apps/web/src/features/attributes/
  registry.tsx          ← AttributeCell (read) + AttributeInput (write), the two switches
  cells/                ← text-cell, number-cell, date-cell, bool-cell, select-cell,
                          multi-select-cell, tags-cell, url-cell, email-cell, phone-cell,
                          relation-cell, derived-cell
  inputs/               ← one per type, mirroring cells/
  icons.ts              ← type → lucide icon (§6.7 "Type (icon + label)")
  operators.ts          ← type → operator list; MIRRORS packages/core's operator table
```

```tsx
// apps/web/src/features/attributes/registry.tsx
export function AttributeCell({ def, row }: { def: AttributeDefinition; row: RecordRow }) {
  const value = readValue(row, def)
  if (value == null) return <EmptyCell def={def} row={row} />   // §5.2 "subtle placeholder"

  switch (def.type) {
    case 'single_select':
      return <OptionChip option={def.options.find((o) => o.key === value)!} />
    case 'multi_select':
    case 'tags':
      return <ChipList values={value} def={def} />
    case 'relation':
      // §5.2 "relations as chips with an icon that link to the record"
      return <RelationChips links={value} />
    case 'yes_no':
      return value ? <Check className="size-4" /> : <X className="size-4 text-muted-foreground" />
    case 'url':
      return <a href={value} target="_blank" rel="noreferrer" className="link">{prettyUrl(value)}</a>
    case 'email':
      return <a href={`mailto:${value}`} className="link">{value}</a>
    case 'number':
      return <span className="tabular-nums">{formatNumber(value, def.config)}</span>
    case 'date':
      return <span className="tabular-nums">{formatDate(value)}</span>
    case 'long_text':
      return <span className="truncate text-muted-foreground">{value}</span>
    default:
      return <span className="truncate">{value}</span>
  }
}
```

`operators.ts` mirroring `packages/core` is a duplication I am accepting knowingly, and paying for with a test: the operator list must be *rendered* (icons, labels, value editors), which is UI, but it must *agree* with the compiler, which is core. A unit test asserts `Object.keys(uiOperators[type])` equals `coreOperators[type]` for all twelve types. Cheaper and clearer than making core own React labels.

### Inline editing

§5.2: double-click or Enter enters edit mode; save on blur. The cell is a two-state component — display, or the matching `AttributeInput` — and commit calls `useSetAttributeValue` (ADR-F5). `Escape` reverts, `Enter` commits, `Tab` commits and moves to the next editable cell in the row. `_pending` on the row (set by `onMutate`) renders a 1px pulse on the cell border, so a slow write is visible without a spinner that shifts layout.

### Consequences

- The Columns picker, the filter picker, the create dialog, the detail sidebar and the CSV export all iterate the same `AttributeDefinition[]`. A new custom attribute appears in all five with zero code.
- Attribute definitions are fetched once with `staleTime: Infinity` and invalidated only by attribute mutations. They are on the critical path of every screen, so they are also prefetched in `__root.tsx`'s loader.

---

## 12. ADR-F11 — Virtualisation at 10k rows

### Options

1. **Classic paging** — 50 rows, Previous/Next. shadcn's demo does this.
2. **Infinite scroll + virtualisation** — `useInfiniteQuery` over the opaque cursor + `@tanstack/react-virtual`.
3. **Fetch all 10k, virtualise client-side.**

### Choice

**Option 2**: pages of 100 via `useInfiniteQuery`, `@tanstack/react-virtual@3.14.10` over the flattened rows, **fixed 40 px row height**, real `<table>` markup with absolutely positioned `<tr>`.

### Reasoning

Option 3 is the one that looks fastest and is worst. 10k rows × ~60 attributes is a multi-megabyte JSON payload; it defeats the storage decision's entire three-query design (Q2 hydrates ≤50 ids precisely so this does not happen); and it turns every filter change into a full refetch. Option 1 is honest and boring but §5.2 says "virtualised rows", and paging through 10k contacts 50 at a time to find someone is a bad product.

Option 2 satisfies both: the DOM holds ~30 rows regardless of dataset size, and the network holds 100 rows per request. The cursor is the storage decision's opaque cursor, so the frontend never knows or cares whether the server is doing keyset (default sort) or limit/offset (custom-attribute sort).

**Fixed row height is a design decision, not a shortcut.** §5.1 asks for Tacto's density: single-line cells, chips, avatars. If every row is 40 px, we skip `measureElement` and its ResizeObserver entirely — no measurement settle, no scroll jump, no layout thrash. The rule that makes it true is enforced in CSS (`h-10`, `overflow-hidden`, `truncate` on every cell) and asserted in a Playwright test. Long text truncates; the detail page is where you read it.

**Real `<table>`, not a div grid.** shadcn's `Table` primitives are real table elements; keeping them preserves semantics, screen-reader behaviour, and the `shadcn diff` upgrade path (ADR-F8). The virtualisation technique is TanStack's documented one: `<tbody>` gets `position: relative` and `height: getTotalSize()`, and each `<tr>` is `position: absolute; transform: translateY(virtualRow.start)`. The sticky first column still works, because `position: sticky` on the `<td>` composes with the absolutely positioned row.

```tsx
// apps/web/src/features/table/table-shell.tsx
const ROW_HEIGHT = 40

export function TableShell({ table, rows, total, totalIsEstimate, onReachEnd }: TableShellProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (i) => rows[i]?.id ?? i,     // stable across refetch; no remount on reorder
  })

  const items = virtualizer.getVirtualItems()
  const last = items.at(-1)

  // Prefetch when the user is within ~1.5 screens of the end.
  React.useEffect(() => {
    if (last && last.index >= rows.length - 30) onReachEnd()
  }, [last?.index, rows.length, onReachEnd])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed border-separate border-spacing-0 text-[13px]">
          <thead className="sticky top-0 z-20 bg-background">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    style={{ width: header.getSize() }}
                    className={cn(
                      'h-9 border-b px-3 text-left align-middle font-medium text-muted-foreground',
                      header.column.getIsPinned() === 'start' &&
                        'sticky left-0 z-30 bg-background',
                    )}
                  >
                    {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                  </th>
                ))}
              </tr>
            ))}
          </thead>

          <tbody style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((vr) => {
              const row = table.getRowModel().rows[vr.index]
              if (!row) return null
              return (
                <tr
                  key={row.id}
                  data-index={vr.index}
                  data-state={row.getIsSelected() ? 'selected' : undefined}
                  className="absolute flex w-full hover:bg-muted/40 data-[state=selected]:bg-muted"
                  style={{ height: ROW_HEIGHT, transform: `translateY(${vr.start}px)` }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      style={{ width: cell.column.getSize() }}
                      className={cn(
                        'flex h-10 items-center overflow-hidden border-b px-3',
                        cell.column.getIsPinned() === 'start' &&
                          'sticky left-0 z-10 bg-background',
                      )}
                    >
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* §5.2 "Rows: 2,236" — honest about estimates (storage-DECISION §5.1 Q3) */}
      <div className="flex h-9 shrink-0 items-center border-t px-3 text-xs text-muted-foreground">
        {total === null ? 'Rows: …'
          : `Rows: ${totalIsEstimate ? '~' : ''}${total.toLocaleString()}`}
      </div>
    </div>
  )
}
```

Verified TanStack Virtual v3 API used here: `count`, `getScrollElement`, `estimateSize`, `overscan`, `getItemKey`, `getVirtualItems()`, `getTotalSize()`.

### Consequences

- Steady-state DOM: ~30 rows × visible columns. Independent of dataset size.
- `getItemKey` returning the record id (not the index) is what prevents a full row remount — and therefore a lost inline-edit focus — when a page of data arrives.
- **Stage 7 acceptance test, written as a number:** with 10k seeded contacts and 14 visible columns, scrolling from row 0 to row 10 000 keeps every frame under 16 ms in a Playwright trace, and the DOM node count stays flat. If it does not, the fallback is a div-grid layout, which is a CSS change inside `TableShell` and touches nothing else.
- Honest limit: no `Ctrl+End`-style jump to the last row without loading everything between. Not required by the brief; sorting descending is the workaround, and it is the one every comparable tool uses.

---

## 13. ADR-F12 — The import wizard: where the file is parsed

### Options

1. **Parse in the browser** (`papaparse` / SheetJS / a vCard parser) in a Web Worker; send mapped rows to the API.
2. **Upload the raw file to the API**; the API parses, stores rows in a staging table, and the wizard reads pages of parsed rows.
3. **Hybrid** — browser parses the first 100 rows for an instant preview; the API parses the whole file for real.

### Choice

**Option 2**, with one deliberate exception: the file is uploaded on step 1 and everything after is API-driven.

### Reasoning

The brief leaves this open ("your call; must handle 10k rows"), but §3.1's API-first rule effectively decides it. §7 says *"every operation the UI performs must be a single, well-named API operation, not a sequence of UI-only calls"* — because the MCP server and the CLI must be able to import too. If parsing, auto-mapping and duplicate detection live in the browser, then `mutuals import contacts.csv` from a CLI reimplements all three, and the two implementations disagree about what "Connected On" maps to.

The other half is that step 4 (Review) needs things only the server has. Duplicate detection is an identifier unique-index probe (storage-DECISION §2.7, §5.8) — deterministic, database-side, and §4.8's "the LLM extracts; code decides" depends on it. Validation of select options needs the option list. "% of rows have a value" (§6.8 step 3) is an aggregate over the whole file. Doing these in the browser means shipping the whole contact book to the client.

And 10k rows × ~40 columns in browser memory, in an editable grid with undo/redo and find-and-replace (§6.8 step 4), is 400k editable cells. That is a spreadsheet application. Reading pages of 100 through the same `RecordTable` that everything else uses is a fraction of the work and reuses the virtualisation we already built.

The wizard therefore becomes: `POST /import-batches` (multipart) → server parses → `GET /import-batches/:id/columns` (auto-mapping proposal, `%` filled, distinct values per select target) → `PUT /import-batches/:id/mapping` → `GET /import-batches/:id/rows?filter=errors` (paged, into `RecordTable`) → `PATCH /import-batches/:id/rows/:n` for in-place fixes → `POST /import-batches/:id/commit`. Each of those is exactly the "single well-named API operation" §7 asks for, and the MCP server gets import for free.

Wizard state lives in the URL: `/import/contacts?batch=<uuid>&step=map`. Refresh-safe, back-button-safe, and shareable — which matters because a 10k-row import is not a 5-second interaction.

The one browser-side piece: the drop zone reads the first ~64 KB to show the file's first rows and detect the delimiter *before* upload, so the "What are you importing / Source format" step feels instant. That is presentation only; nothing depends on it.

### Consequences

- The API needs a staging table for parsed import rows. That is a backend change and must be raised with whoever owns the API ADR — the storage decision defines `import_batch` but not per-row staging. Flagged in §17.
- The wizard's Review grid is `RecordTable` with a static column set and a different data source. One table component, as §5.2 demands.
- Uploads use `@fastify/multipart` with a size cap; the browser shows real progress via `XMLHttpRequest`'s `upload.onprogress` (fetch has no upload progress).

---

## 14. ADR-F13 — Component and file structure

### Options

1. **Type-first** — `components/`, `hooks/`, `pages/`, `utils/`.
2. **Feature-first** — `features/<domain>/` owning its components, hooks and API calls.
3. **Route-colocated** — everything under `routes/`.

### Choice

**Feature-first, with routes as thin composition roots.**

### Reasoning

Type-first folders scale by file count, not by concept: `components/` reaches 120 files and nobody can tell which three belong together. Route-colocation breaks the moment a component is used by two routes — and `RecordTable` is used by six.

Route files stay thin on purpose: a route defines its search schema, its loader and which feature components to render. That makes the router swappable and, more usefully, makes the features testable without a router.

```
apps/web/src/
  main.tsx
  routeTree.gen.ts                  (generated, gitignored)
  routes/                           thin: search schema + loader + composition
  features/
    app-shell/                      sidebar, breadcrumb, workspace menu (§5.1)
    attributes/                     registry.tsx, cells/, inputs/, icons.ts, operators.ts
                                    attribute-list.tsx, create-attribute-dialog.tsx (§6.7)
    table/                          record-table.tsx, table-shell.tsx, use-record-columns.tsx,
                                    filter-bar.tsx, filter-chip.tsx, columns-menu.tsx,
                                    view-menu.tsx, bulk-action-bar.tsx
    records/                        record-form.tsx, record-detail/, use-set-attribute-value.ts,
                                    fact-history-popover.tsx, merge-dialog.tsx (§6.9)
    interactions/  follow-ups/  import/  dashboard/  search/     (⌘K palette + quick capture)
    settings/
  lib/                              api.ts, query-client.ts, query-keys.ts, format.ts
  hooks/                            use-debounced-value.ts, use-hotkeys.ts
packages/ui/src/components/         shadcn primitives — DO NOT hand-edit
packages/core/src/                  shared with the API: schemas, filter model, warmth, slugs
```

**One rule with teeth:** a `features/*` folder may import from `packages/ui`, `lib/`, `hooks/` and `@mutuals/core` — never from a sibling feature. Cross-feature composition happens in `routes/`. Enforced by an ESLint `no-restricted-imports` zone rather than by discipline, because discipline does not survive stage 5.

---

## 15. ADR-F14 — Design tokens for §5.1

§5.1 in full: sidebar ~240px light grey; top bar with breadcrumb; content max-width ~1200px, generous padding, white; neutral greys, **one accent colour**, thin borders, 13–14px base font, small rounded chips coloured by option, avatar circles with initials; the density and calm of the Tacto screenshots — a working tool, not a marketing page.

### Options

1. **shadcn defaults** (`neutral` base, 16px, `--radius: 0.625rem`) unchanged.
2. **A Mutuals token layer** in `@theme`: shadcn's semantic names, our values.
3. **A full bespoke design system.**

### Choice

**Option 2.** Keep every shadcn semantic token name (`--background`, `--muted`, `--border`, `--primary`, …) so every `shadcn add` lands looking correct; override the *values*, add the four things shadcn has no opinion about (density, the option-chip palette, layout constants, tabular numerals).

Option 1 is 16px and 10px radius — visually a marketing site, and §5.1 says explicitly it is not one. Option 3 throws away the reason we chose shadcn.

### The one non-obvious decision: option colours are token names, not hex

`attribute_option.color` is `text` in the storage decision. **It stores a token name from a closed set** — `slate | gray | red | orange | amber | green | teal | blue | indigo | violet | pink` — never a hex string. Three reasons: a hex chosen in light mode is unreadable in dark mode; a user-picked hex will eventually fail contrast on a chip; and the colour picker in §6.7 becomes eleven swatches instead of an eyedropper, which is faster to use and impossible to get wrong. Each token resolves to a `-bg` / `-fg` / `-border` triple defined per theme. **This is a contract with the database and must be mirrored in `packages/core`'s option config schema** (`z.enum([...])`, not `z.string()`).

### `packages/ui/src/styles/globals.css`

```css
@import "tailwindcss";
@import "tw-animate-css";
@source "../../../../apps/web/src";

@custom-variant dark (&:is(.dark *));

:root {
  /* ---- neutral ramp: warm-neutral, low chroma. Calm, not clinical. ---- */
  --background:            oklch(1    0     0);
  --foreground:            oklch(0.21 0.006 265);   /* near-black, never pure #000 */
  --card:                  oklch(1    0     0);
  --card-foreground:       oklch(0.21 0.006 265);
  --popover:               oklch(1    0     0);
  --popover-foreground:    oklch(0.21 0.006 265);

  --muted:                 oklch(0.97 0.002 265);   /* §5.1 sidebar / table zebra */
  --muted-foreground:      oklch(0.55 0.010 265);   /* labels, placeholders, empty cells */

  /* ---- the ONE accent (§5.1). Indigo: legible on white, calm, not "brand-y". ---- */
  --primary:               oklch(0.52 0.155 264);
  --primary-foreground:    oklch(0.99 0     0);
  --accent:                oklch(0.96 0.014 264);   /* hover/selected tint of the accent */
  --accent-foreground:     oklch(0.42 0.140 264);

  --secondary:             oklch(0.97 0.002 265);
  --secondary-foreground:  oklch(0.28 0.008 265);
  --destructive:           oklch(0.58 0.205 27);    /* §6.4 overdue dates, delete actions */
  --destructive-foreground:oklch(0.99 0     0);

  /* ---- thin borders (§5.1): hairlines, not boxes ---- */
  --border:                oklch(0.925 0.004 265);
  --input:                 oklch(0.90  0.005 265);
  --ring:                  oklch(0.52  0.155 264);

  /* ---- sidebar (§5.1: "light grey background") ---- */
  --sidebar:               oklch(0.985 0.002 265);
  --sidebar-foreground:    oklch(0.30  0.008 265);
  --sidebar-accent:        oklch(0.955 0.004 265);
  --sidebar-border:        oklch(0.92  0.004 265);

  /* ---- geometry ---- */
  --radius:                0.375rem;                /* 6px — restrained, not pill-soft */
  --sidebar-width:         15rem;                   /* 240px, §5.1 */
  --sidebar-width-collapsed: 3.25rem;
  --content-max:           75rem;                   /* 1200px, §5.1 */
  --topbar-height:         3rem;
  --row-height:            2.5rem;                  /* 40px, ADR-F11 — fixed, load-bearing */
  --header-height:         2.25rem;

  /* ---- option chips (§5.2). Token names, never hex. ---- */
  --chip-gray-bg:   oklch(0.96 0.003 265); --chip-gray-fg:   oklch(0.40 0.010 265);
  --chip-red-bg:    oklch(0.95 0.030 25);  --chip-red-fg:    oklch(0.47 0.150 25);
  --chip-orange-bg: oklch(0.95 0.035 65);  --chip-orange-fg: oklch(0.47 0.130 55);
  --chip-amber-bg:  oklch(0.96 0.040 95);  --chip-amber-fg:  oklch(0.46 0.110 80);
  --chip-green-bg:  oklch(0.95 0.035 155); --chip-green-fg:  oklch(0.44 0.110 155);
  --chip-teal-bg:   oklch(0.95 0.030 190); --chip-teal-fg:   oklch(0.44 0.095 195);
  --chip-blue-bg:   oklch(0.95 0.030 250); --chip-blue-fg:   oklch(0.46 0.135 255);
  --chip-indigo-bg: oklch(0.95 0.032 275); --chip-indigo-fg: oklch(0.46 0.150 272);
  --chip-violet-bg: oklch(0.95 0.032 300); --chip-violet-fg: oklch(0.47 0.150 300);
  --chip-pink-bg:   oklch(0.95 0.030 350); --chip-pink-fg:   oklch(0.48 0.145 350);
  --chip-slate-bg:  oklch(0.95 0.008 240); --chip-slate-fg:  oklch(0.42 0.020 250);
}

.dark {
  --background:            oklch(0.17 0.006 265);
  --foreground:            oklch(0.94 0.003 265);
  --card:                  oklch(0.20 0.006 265);
  --card-foreground:       oklch(0.94 0.003 265);
  --popover:               oklch(0.20 0.006 265);
  --popover-foreground:    oklch(0.94 0.003 265);
  --muted:                 oklch(0.24 0.006 265);
  --muted-foreground:      oklch(0.66 0.010 265);
  --primary:               oklch(0.70 0.140 264);
  --primary-foreground:    oklch(0.17 0.006 265);
  --accent:                oklch(0.27 0.030 264);
  --accent-foreground:     oklch(0.86 0.070 264);
  --secondary:             oklch(0.25 0.006 265);
  --secondary-foreground:  oklch(0.92 0.003 265);
  --destructive:           oklch(0.65 0.180 27);
  --destructive-foreground:oklch(0.17 0.006 265);
  --border:                oklch(1 0 0 / 10%);
  --input:                 oklch(1 0 0 / 14%);
  --ring:                  oklch(0.70 0.140 264);
  --sidebar:               oklch(0.19 0.006 265);
  --sidebar-foreground:    oklch(0.88 0.004 265);
  --sidebar-accent:        oklch(0.25 0.006 265);
  --sidebar-border:        oklch(1 0 0 / 8%);

  --chip-gray-bg:   oklch(0.28 0.006 265); --chip-gray-fg:   oklch(0.80 0.010 265);
  --chip-red-bg:    oklch(0.30 0.060 25);  --chip-red-fg:    oklch(0.82 0.110 25);
  --chip-orange-bg: oklch(0.30 0.060 65);  --chip-orange-fg: oklch(0.83 0.105 70);
  --chip-amber-bg:  oklch(0.30 0.055 95);  --chip-amber-fg:  oklch(0.85 0.100 90);
  --chip-green-bg:  oklch(0.29 0.055 155); --chip-green-fg:  oklch(0.82 0.100 155);
  --chip-teal-bg:   oklch(0.29 0.050 190); --chip-teal-fg:   oklch(0.82 0.085 195);
  --chip-blue-bg:   oklch(0.29 0.060 250); --chip-blue-fg:   oklch(0.82 0.105 255);
  --chip-indigo-bg: oklch(0.29 0.062 275); --chip-indigo-fg: oklch(0.82 0.110 272);
  --chip-violet-bg: oklch(0.29 0.062 300); --chip-violet-fg: oklch(0.83 0.110 300);
  --chip-pink-bg:   oklch(0.29 0.058 350); --chip-pink-fg:   oklch(0.83 0.108 350);
  --chip-slate-bg:  oklch(0.28 0.014 245); --chip-slate-fg:  oklch(0.80 0.025 245);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-border: var(--sidebar-border);

  --radius-sm: calc(var(--radius) - 2px);
  --radius-md: var(--radius);
  --radius-lg: calc(var(--radius) + 2px);

  /* §5.1 "13–14px base font": the whole scale shifts down one notch. */
  --text-xs:   0.6875rem;  /* 11px — table meta, footer, provenance line */
  --text-sm:   0.8125rem;  /* 13px — TABLE CELLS, chips, sidebar nav (the app default) */
  --text-base: 0.875rem;   /* 14px — body, form inputs, dialog copy */
  --text-lg:   1rem;       /* 16px — card titles, section headings */
  --text-xl:   1.125rem;   /* 18px — page titles */
  --text-2xl:  1.375rem;   /* 22px — dashboard greeting, detail-page name */

  --font-sans: "Inter var", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
}

@layer base {
  * { @apply border-border outline-ring/40; }
  body {
    @apply bg-background text-foreground;
    font-size: var(--text-base);
    /* Density: shadcn's defaults assume 16px. Nudging line-height keeps rows tight. */
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
  }
  /* Numbers in a table must not dance while they update. */
  table, .tabular { font-variant-numeric: tabular-nums; }
}

/* The chip. One utility, eleven tokens, both themes. */
@utility chip-* {
  background-color: var(--chip-*-bg);
  color: var(--chip-*-fg);
}
```

```tsx
// packages/ui/src/components/option-chip.tsx
const CHIP = ['gray','slate','red','orange','amber','green','teal','blue','indigo','violet','pink'] as const
export type ChipColor = (typeof CHIP)[number]     // === the DB's closed set

export function OptionChip({ color = 'gray', children }: { color?: ChipColor; children: React.ReactNode }) {
  return (
    <span className={cn(
      'inline-flex h-5 max-w-full items-center gap-1 truncate rounded px-1.5 text-xs font-medium',
      `chip-${color}`,
    )}>
      {children}
    </span>
  )
}
```

**Typography note.** `--text-sm` (13px) is the table/chip/sidebar default and `--text-base` (14px) is body — which is why `TableShell` above sets `text-[13px]` explicitly at the table root rather than relying on inheritance. Keeping the root at 16px (rather than the tempting `html { font-size: 14px }`) means Tailwind's `--spacing` scale keeps its plain-English meaning: `p-4` is still 16px, and every shadcn component installed later still looks right.

**Dark mode.** The brief does not ask for it. Defining both palettes now costs one CSS block and zero component changes; not defining it means retro-fitting every hard-coded colour later. The toggle itself is deferred.

### Consequences

- The visual identity lives in exactly one file. Simon can be shown two accent values side by side without touching a component.
- Every new `shadcn add` inherits the theme automatically.
- Contrast: every `-bg`/`-fg` chip pair is designed above 4.5:1; a unit test over the token table asserts it, so a future palette tweak cannot quietly break legibility.

---

## 16. Pinned versions — verified vs assumed

All versions read from the npm registry on **2026-09-03**.

| Package | Pin | Verified | Note |
|---|---|---|---|
| `react`, `react-dom` | 19.2.8 | registry `latest` | |
| `vite` | 8.2.2 | registry; `engines: ^20.19 \|\| >=22.12` | 8.0.0 shipped 2026-03-12 |
| `@vitejs/plugin-react` | 6.1.1 | registry; peer `vite ^8`; babel/compiler peers **optional** | Oxc path, no React Compiler |
| `@tailwindcss/vite`, `tailwindcss` | 4.3.3 | registry; peer `vite ^5.2 \|\| ^6 \|\| ^7 \|\| ^8` | |
| `tw-animate-css` | 1.4.0 | registry | replaces `tailwindcss-animate` |
| `@tanstack/react-router` | 1.170.32 | registry; peer `react >=18` | `validateSearch` + Zod verified in docs |
| `@tanstack/router-plugin` | 1.168.35 | registry; peer `vite >=8.0.0`, `@tanstack/react-router ^1.170.32` | |
| `@tanstack/react-query` | 5.102.8 | registry; peer `react ^18 \|\| ^19` | v6 is Svelte/Solid-only |
| `@tanstack/react-table` | 9.2.4 | registry; 9.0.0 on **2026-08-04** | shadcn data-table docs verified on v9 |
| `@tanstack/react-virtual` | 3.14.10 | registry; peer `react ^16.8–^19` | |
| `zod` | 4.5.4 | registry; v4 breaking changes read from zod.dev | |
| `react-hook-form` | 7.87.0 | registry (8.x is beta only) | |
| `@hookform/resolvers` | 5.9.1 | registry; `@hookform/resolvers/zod` → `zodResolver` | |
| `radix-ui` | 1.6.7 | registry | Base UI is `1.0.0-rc.0` — not used |
| `lucide-react` | 1.39.0 | registry | |
| `cmdk` | 1.1.1 | registry | ⌘K palette, §6.10 |
| `sonner` | 2.0.8 | registry | toasts, §5.2 |
| `@dnd-kit/core` / `@dnd-kit/sortable` | 6.3.1 / 10.0.0 | registry | column reorder drag, §5.2 |
| `date-fns` | 4.4.0 | registry | relative dates ("3 weeks ago") |
| `react-day-picker` | 10.0.1 | registry | shadcn Calendar dependency |
| `class-variance-authority` / `tailwind-merge` | 0.7.1 / 3.6.0 | registry | |
| `shadcn` (CLI) | 4.20.1 | registry, published 2026-09-02 | run via `pnpm dlx`, not a dependency |
| `typescript` | 6.0.3 | registry (7.0.2 is `latest`) | see ADR-F2 |
| `typescript-eslint` | 8.69.0 | registry; peer `typescript >=4.8.4 <6.1.0` | **excludes TS 7** |
| `eslint` | 10.9.1 | registry | |
| `prettier` / `prettier-plugin-tailwindcss` | 3.9.6 / 0.8.1 | registry | |
| `vitest` | 4.1.11 | registry | |
| `@testing-library/react` | 16.3.3 | registry | |
| `@playwright/test` | 1.62.1 | registry | |
| `pnpm` | 11.25.0 | registry | |

**Verified by reading the library's own current documentation:**

- TanStack Table v8→v9 breaking changes: `useTable`, `tableFeatures()`, implicit core row model, `createColumnHelper<TFeatures, TData>`, `ColumnDef<TFeatures, TData, TValue>`, `sortFn`/`sortFns`/`getSortFn`, pinning `start`/`end`, `enableColumnPinning`/`enableRowPinning`, sizing/resizing split, `table.state` / `table.store` / `table.Subscribe`, `onStateChange` removed, instance-method calls, `flexRender` retained plus `<table.FlexRender />`.
- The v9 feature export names used above (`columnVisibilityFeature`, `columnOrderingFeature`, `columnPinningFeature`, `columnSizingFeature`, `columnResizingFeature`, `rowSelectionFeature`, `rowSortingFeature`) appear in the v9 stock-features list.
- v9 manual sorting: `manualSorting: true` with `sortedRowModel` omitted; `getCanSort()`, `getToggleSortingHandler()`, `getIsSorted()` unchanged.
- shadcn's `docs/components/data-table` page uses v9 verbatim (`tableFeatures`, `useTable`, `<table.FlexRender />`).
- shadcn monorepo support: per-workspace `components.json`, matching `style`/`iconLibrary`/`baseColor`, **empty `tailwind` config for v4**, `shadcn add` run from the app workspace.
- shadcn CLI v4: `--monorepo`, `--base radix|base-ui`, `--dry-run`/`--diff`/`--view`, presets; `--style`/`--base-color`/`--src-dir`/`--css-variables` removed and now error.
- Tailwind v4 + shadcn: no `tailwind.config.js`, `@import "tailwindcss"`, `@custom-variant dark`, oklch `:root`/`.dark`, `@theme inline`, `tw-animate-css`, `data-slot` attributes.
- TanStack Router: `validateSearch` with a Zod schema, `Route.useSearch()`, functional `search` updaters, `retainSearchParams` / `stripSearchParams`, default `parseSearchWith(JSON.parse)` / `stringifySearchWith(JSON.stringify)` with JSON-encoded nested values.
- TanStack Virtual v3: `count`, `getScrollElement`, `estimateSize`, `overscan`, `getItemKey`, `measureElement`, `getVirtualItems()`, `getTotalSize()`; the documented `<table>` technique (tbody `height = getTotalSize()`, `position: relative`, rows `position: absolute` + `transform: translateY(start)`, `data-index` for measurement).
- Zod 4: `error` replaces `message`/`invalid_type_error`/`required_error`; `z.email()`/`z.uuid()` top-level; `z.record()` requires both args; `.default()` applies to output and `.prefault()` restores v3 behaviour; `.errors` → `.issues`; `z.treeifyError`/`z.flattenError`; `z.toJSONSchema`.
- TypeScript 7.0: no stable programmatic API until 7.1; `baseUrl` removed; `types` defaults to `[]`; `rootDir` defaults to `./`; `moduleResolution: node/node10/classic` and `target: es5` are hard errors.
- TanStack Query: v5 is the current React line; v6 exists only for Svelte/Solid adapters.

**Assumed, to be confirmed in Stage 2 (all cheap to check, none load-bearing for the architecture):**

- v9's exact option names for `manualFiltering` / `manualPagination` (continuity from v8 assumed; `manualSorting` verified).
- That `columnResizingFeature` requires `columnSizingFeature` to be registered alongside it.
- That absolutely-positioned `<tr>` composes with `position: sticky` `<td>` for the pinned first column across Safari/Firefox — the reason the Stage 2 definition of done includes a cross-browser screenshot.
- `@tanstack/router-plugin@1.168.35`'s exact `autoCodeSplitting` behaviour on Vite 8 + Rolldown.
- shadcn CLI v4's `--monorepo` scaffold shape for a **Vite** (not Next.js) monorepo; the docs show the layout but not this exact combination.
- That `openapi-typescript`'s `peerDependencies: typescript ^5.x` is a stale range rather than a real constraint — irrelevant, since ADR-F6 does not use it.
- Every latency and frame-time number in this document is a **budget**, not a measurement. Stage 7's performance pass replaces them with Playwright traces at 10k rows, exactly as the storage decision replaces its own extrapolations with `EXPLAIN (ANALYZE, BUFFERS)`.

---

## 17. Open questions that genuinely need a human

Deliberately short. Everything the brief already decided is not here.

1. **Working directory.** `/Users/simonfuhrbach/code/crm` already contains a different Mutuals implementation (Next.js 16 + `better-sqlite3` + single app) whose stack contradicts three fixed decisions in §3.1. The brief's own Step 0 requires Simon to confirm the folder. Do we build the monorepo in a fresh directory, or replace this tree (and keep it on a branch)? Everything in this ADR assumes a clean slate.
2. **Import staging is an API-side change** (ADR-F12). The storage decision defines `import_batch` but not a per-row staging table for the Review grid. Whoever owns the API/backend ADR needs to add it, or the wizard's Review step has to be redesigned. This is a coordination item, not a preference.
3. **Dark mode in Phase 1: tokens only, or a working toggle?** §5.1 does not mention it. The tokens cost nothing (ADR-F14) and are already written; a tested toggle plus dark-mode screenshots in every stage report is maybe half a day. Recommendation: tokens now, toggle in Stage 7. Simon's call.
