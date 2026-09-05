# Mutuals — Architecture Decision Record log

**Status:** Stage 1 complete. ADR-001…083 were written in Stage 0; ADR-084…086 (§15) were forced
by the build itself. Of §14's open questions, Q3 is answered by ADR-086; Q4, Q5 and Q6 remain and
none of them blocks Stage 2.
**Scope:** this is the ADR log the brief requires in §2.2 — one record per decision, each with
context, options, choice and consequences, ordered so a reader meets foundational decisions first.
Every later decision that changes something here is appended, never edited in place, and the brief
(`docs/BRIEF.md`) is updated in the same pull request.
**Supersedes:** `docs/adr-archive/storage-{jsonb,eav,hybrid}.md`, `storage-DECISION.md` and the six
`adr-*.md` area drafts. Where this document and one of those disagree, **this document wins**; the
archive is kept only as the reasoning trail — including the two storage designs that lost, because
knowing what was rejected and why is most of the value of an ADR log.
**Numbering:** ADR-001…ADR-083 in reading order.

Everything here was checked against the live npm registry on **2026-09-03**; §11 states exactly what
was verified against current documentation versus assumed. All seventeen pinned versions were then
re-verified independently against the registry before this document was committed. ADR-002 was
rewritten on the same day after Docker Desktop was installed on the target machine and
`pgvector/pgvector:pg16` was verified end to end, which withdrew the document's only proposed
deviation from a fixed decision in the brief.

Everything here was checked against the live npm registry on **2026-09-03** (see §11 for exactly what
was verified versus assumed) and against seven independent skeptical reviews of the proposals.

### Verification pass on this document

The registry facts were re-read rather than inherited. Re-confirmed independently: `typescript@7.0.2`
is `latest` with `next` at `7.1.0-dev`, **`typescript@6.0.3` is a published stable release**, and
**`typescript-eslint@8.69.0` peers `typescript: ">=4.8.4 <6.1.0"`** — which is the single fact ADR-003
turns on. `kysely@0.29.5`; `kysely-codegen@0.20.0` last published **2026-02-16** with
`devDependencies.kysely ^0.28.11`, while `kysely@0.29.0` shipped **2026-05-08** — the three-month gap
ADR-027 rests on is real. `fastify-type-provider-zod@7.0.0` peers exactly as claimed;
`pg-boss@12.29.0` is MIT with `engines.node >=22.12.0` and only three dependencies. The warmth
constant was recomputed from the series, not copied: `Σ(n=0..12) e^(−n/3) = 3.48142954787`,
`signal = 10.4442886436`, `k = 0.132732291152`, and `warmth(monthly meetings) = 75` exactly — so
`0.13273229` is right and the previously published `0.13273534` was not.

**Four dependency corrections** came out of it, all in §11: `@types/node` **24.13.3** (not `latest`
26.4.1 — that describes Node 26 APIs while `engines.node` is `>=24`), `@types/pg` **8.23.1** (the
draft's 8.15.6 was the one pin written from memory), `lucide-react` **1.40.0**, and `@types/react` /
`@types/react-dom` **added** — they were missing outright, and a React app under `strict` does not
compile without them.

**Three decisions were missing and are now written down** — each one a gap a review named that the
first reconciliation did not close: **ADR-018** (`value_key` is `''` for single-valued attributes),
**ADR-038** (a select attribute must have at least one option — `z.enum([])` verified in this session
to construct fine and then reject every value with `Invalid option: expected one of `), and
**ADR-048** (saved views: the URL is the working copy, the view is a named snapshot).

The ADRs are numbered 001–083 in reading order, foundational first: environment and tooling, then
storage, then data access and the API, then the domain core, then the frontend, then jobs and the LLM
module, then testing and CI.

---

## 0. What changed after review, and why

The reviews found nine defects that would have shipped, plus a long list of Phase-1 over-engineering.
The material reversals:

| #   | Was proposed                                                                                                                                | Now                                                                                                                                                        | Why                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Text normalisation implemented **twice** — a TypeScript fold and Postgres `unaccent` — with a contract test pinning them together           | **One implementation, in SQL** (`mutuals_norm()`); TypeScript never produces a value compared against a normalised column                                  | The contract test provably cannot pass (`'İstanbul'.toLowerCase()` ≠ PG `lower()`; `ß`→`ss` only in `unaccent`; ligature expansion). Deleting the second implementation deletes the test and the drift.                                                                                                                       |
| 2   | `fact.text_norm` / `fact.text_sort` written into the append-only truth log                                                                  | Derived text columns live **only** on `attribute_value`                                                                                                    | A truth log must not carry values only the application can recompute; `db:reproject` could not repair them.                                                                                                                                                                                                                   |
| 3   | Frontend types generated from `openapi.json` via `openapi-typescript` → `openapi-fetch` → `openapi-react-query`; TypeScript pinned to 5.9.3 | Frontend imports Zod-inferred types from `@mutuals/core`; **TypeScript 6.0.3**; `openapi.json` still emitted and committed for `/api/docs`, MCP and Python | The codegen chain existed only to serve the frontend, which sits in the same monorepo. Removing it drops 3 dependencies, 2 CI gates, a committed `schema.d.ts`, `openapi-fetch`'s error-type lie, and the `typescript ^5.x` peer that was pinning the whole repo one major behind.                                            |
| 4   | `packages/ui` with shadcn's monorepo layout on Tailwind 4                                                                                   | shadcn components copied into `apps/web/src/components/ui`                                                                                                 | There is exactly one frontend. The proposed `@source` wiring was broken (Tailwind 4 auto-detection is cwd-relative; `packages/ui/src` would never have been scanned, so the component library would have rendered unstyled). One consumer, one home, problem gone.                                                            |
| 5   | Filter compiler in `packages/core` emitting SQL text (one ADR) **and** returning Kysely expressions (another ADR)                           | Filter **model, operator table and relative-date resolution** in `packages/core`; **compiler** in `packages/db`                                            | `packages/core` ships to the browser and may not import a query builder. Kysely's `.compile()` is pure, so the golden-SQL tests still need no database and still prove the real SQL.                                                                                                                                          |
| 6   | `kysely-codegen` generating `DB` from the live database, with `--camel-case`, as a CI gate                                                  | `DB` hand-maintained in `packages/db/src/schema.ts` (bootstrapped once by `kysely-codegen`), snake_case, guarded by an **`information_schema` drift test** | `kysely-codegen@0.20.0` has never shipped a release tested against `kysely@0.29.x` (its devDependency is `kysely ^0.28.11`, 0.29 landed three months later) and `--camel-case` renames every identifier the compiler and the `.sql` files use. "Drift is impossible by construction" becomes the honest "drift fails a test". |
| 7   | Warmth `k = 0.13273534`                                                                                                                     | **`k = 0.13273229`**                                                                                                                                       | Recomputed: `Σ(n=0..12) e^(−n/3) = 3.48142954787`, signal `= 10.4442886436`, `k = ln4/signal = 0.132732291152`. Two named CI assertions were red on day one. No published warmth value changes.                                                                                                                               |
| 8   | Node type stripping used in **production** too (`node src/main.ts`)                                                                         | Type stripping in **development only**; production runs a single esbuild bundle                                                                            | Verified failure: Node refuses to strip types from any file whose real path is inside `node_modules`, which is exactly what `pnpm deploy` produces. The API would have crashed at boot the first time anyone packaged it.                                                                                                     |
| 9   | LLM daily budget checked once per task; transport retried timeouts                                                                          | Budget checked **before every HTTP POST**; transport carries an **overall deadline**                                                                       | One task could bill six generations past the cap, and `LLM_TIMEOUT_MS=60000` could hang a user-facing request for over three minutes.                                                                                                                                                                                         |

Two reviewer objections were **not** accepted, and why:

- _"The `Straßburg` bug motivates a TypeScript-only fold."_ It does not exist: the proposed fold table
  already contains `ß→ss`, `æ→ae`, `ø→o`, `ł→l`, so it agrees with `unaccent` on all three headline
  cases. Real divergence is confined to compatibility characters (`ĳ`, `ﬁ`, `Ⅷ`, `½`). That is a drift
  argument, and the answer to drift is one implementation, not two plus a test.
- _"Force the cluster to `lc_ctype=C` so `lower()` is predictable."_ Rejected. That is a
  product-visible decision about how German names case-fold, buried in a testing ADR. The cluster keeps
  the host default; determinism comes from `text_sort text COLLATE "C"` at the **column** level, which
  `storage-DECISION` already had right.

---

## 1. Environment and baseline

### ADR-001 — Node 24 LTS, floor `>=24.0.0`

**Context.** The brief fixes TypeScript everywhere and "runs locally with one command". The machine
has Node v24.20.0, no Docker, no Postgres, no pnpm. Node 25+ no longer bundles Corepack, which is the
zero-install way a non-developer gets pnpm.

**Options.** (1) Node 22 LTS. (2) Node 24 LTS. (3) Node 26 current.

**Choice.** Node 24 LTS. `engines.node: ">=24.0.0"`, `devEngines.runtime`, `.nvmrc` = `24`.

**Consequences.** `corepack enable pnpm` survives as an onboarding step. Every pinned tool is
satisfied (`eslint@10.9.1` needs `^20.19 || ^22.13 || >=24`; `vite@8.2.2` needs `^20.19 || >=22.12`;
`pg-boss@12.29.0` needs `>=22.12`; `kysely@0.29.5` needs `>=22`). The floor is `24.0.0` rather than a
patch release because everything used — type stripping on by default, `--env-file-if-exists`,
`process.loadEnvFile` — exists across the whole 24 line; the earlier `>=24.13.0` had no stated cause.
The version is declared three times (`engines`, `devEngines`, `.nvmrc`) plus once in CI, which is one
more than ideal; `.nvmrc` is what a human uses, `devEngines` is what stops `npm install`, and CI's
`runtime: node@24` is required by `pnpm/setup@v2`.

### ADR-002 — Postgres 16 everywhere, exactly as the brief specifies

**Context.** Brief §3.1: "any plain Postgres 16 with `pgvector` and `pg_trgm`". An earlier draft of
this ADR shipped Postgres **17** instead, on the reasoning that the target machine had no Docker and
that Homebrew's `pgvector` formula (0.8.6) declares `build_dependencies = ["postgresql@17",
"postgresql@18"]`, making `brew install postgresql@16 pgvector` produce an extension built against
the wrong server. **That premise no longer holds:** Docker Desktop 4.89.0 (engine 29.7.2, arm64) is
now installed on the machine, and `pgvector/pgvector:pg16` was verified end to end on 2026-09-03 —
container ready in 2 s, `PostgreSQL 16.15`, `vector 0.8.6`, `pg_trgm 1.6`, and a single query
combining a `jsonb_path_ops` GIN lookup, a `gin_trgm_ops` `ILIKE` and a `<->` vector distance
returned correctly. With the primary path working on 16, deviating from a fixed decision buys
nothing.

**Options.** (1) Pin 16 everywhere, Docker as the primary local path. (2) Ship 17 locally and in CI,
keep 16 supported. (3) Ship 18.

**Choice.** Option 1. `docker-compose.yml` and CI both use `pgvector/pgvector:pg16`. The schema uses
no feature above Postgres 15 (`UNIQUE NULLS NOT DISTINCT`), so 17 and 18 also work and are what the
documented no-Docker fallbacks provide — Postgres.app (bundles `pgvector` for PG15+, verified in the
PostgresApp repository README) and `brew install postgresql@18 pgvector`. Those two majors are named
in the README as supported alternatives rather than as the default. Supabase is whatever major the
project is on.

**Consequences.** No deviation from §3.1, so the earlier open question Q2 to the co-founder is
withdrawn. CI runs 16 as its only leg rather than carrying a matrix, because 16 is now both the floor
and the shipped version; a 17/18 leg is added the day someone actually develops on Postgres.app.
Extensions required: `pg_trgm`, `btree_gin`, `unaccent`, `vector`. **`pgcrypto` is dropped** —
`gen_random_uuid()` has been core since Postgres 13, and requiring it could only ever produce a false
failure on an otherwise-fine cluster.

### ADR-003 — TypeScript 6.0.3, not 7.0.2

**Context.** `typescript@7.0.2` is `latest` (native Go port) but ships no stable programmatic API
until 7.1. `typescript-eslint@8.69.0` declares peer `typescript: ">=4.8.4 <6.1.0"` — verified today —
so no published typescript-eslint can load TS 7. Type-aware linting (`no-floating-promises`,
`no-misused-promises`) is the highest-value rule set in a codebase of Fastify handlers, `pg`
transactions and pg-boss jobs.

**Options.** (1) TS 7.0.2 and no linter. (2) TS 7.0.2 for `tsc` plus a 6.x install for the linter.
(3) TS 6.0.3 everywhere. (4) TS 5.9.3 everywhere.

**Choice.** `typescript@6.0.3` everywhere — a published stable release of the `typescript` package,
verified present on the registry and installed on this machine. 5.9.3 was only ever required by
`openapi-typescript`'s `^5.x` peer, and ADR-027 removes that package.

**Consequences.** `tsconfig.base.json` is written to TS 7's constraints now — no `baseUrl`,
`moduleResolution` `nodenext`/`bundler` only, no `target: es5`, `types` listed explicitly — so the
eventual 7.x bump is a version change with an empty diff. `stableTypeOrdering: true` is set now for
the same reason. `erasableSyntaxOnly: true` (no `enum`, no parameter properties) because Node's type
stripping refuses non-erasable syntax. `noUncheckedIndexedAccess: true` because the attribute map is
keyed at runtime. **`exactOptionalPropertyTypes` is not set** — it goes beyond `strict`, and its only
reliable output against Radix, TanStack option objects and React Hook Form field props is friction.
Upgrade trigger, written down and watched by Dependabot: the day `typescript-eslint`'s peer range
admits `^7`.

---

## 2. Repository, tooling, local development

### ADR-004 — pnpm 11.25.0, pinned

**Context.** Brief §3.2 names pnpm. The machine has none. Corepack 0.35.0 is present (via Homebrew).

**Options.** (1) pnpm 11.25.0 (`latest`). (2) pnpm 12.3.1 (`latest-12`). (3) npm workspaces. (4) Yarn 4 / Bun.

**Choice.** `pnpm@11.25.0` exactly, declared in `packageManager`, `devEngines.packageManager` and
`engines`. Install path: `corepack enable pnpm`; documented fallback `npm i -g pnpm@11.25.0`; CI uses
`pnpm/setup@v2`, which reads `packageManager`.

**Consequences.** `pnpm-workspace.yaml` sets `dedupePeerDependents: true`, `verifyDepsBeforeRun:
install`, `savePrefix: ''` (exact pins), and `allowBuilds` — a **map** in pnpm 11, e.g. `esbuild:
true`; `onlyBuiltDependencies`, `neverBuiltDependencies` and friends were removed in v11.
**`strictPeerDependencies` is left at its default (off).** It re-enables a check pnpm turned off in v8
and is the single setting most likely to hand a non-technical owner an unreadable wall of install
text once Radix and shadcn dependencies land. Exact pins are paired with `.github/dependabot.yml`
(weekly, grouped) in the same PR — exact pins with no upgrade bot are just stale dependencies.

### ADR-005 — No task runner

**Context.** Two apps, two libraries, one e2e harness; only `apps/web` emits build artifacts.

**Options.** (1) Nothing but pnpm workspaces. (2) Turborepo 2.10.12. (3) Nx.

**Choice.** Nothing. `pnpm -r`, `pnpm --filter`, `--parallel`. Escalation, when it is needed, is
pnpm 11.25's own `tasks:` section in `pnpm-workspace.yaml` (`dependsOn`, `^build`, per-task
concurrency) — no new dependency.

**Consequences.** There is nothing to cache, so a remote cache would buy nothing, and the brief's "no
proprietary services in the critical path" stays true without an argument. **No commented-out
`tasks:` block ships** — dead configuration in a public repo gets uncommented for a graph that does
not exist. Revisit when a second emitting package appears or a full `pnpm verify` exceeds ~3 minutes.

### ADR-006 — Five workspace packages, one-way dependency graph

**Context.** §3.1 suggests `apps/web`, `apps/api`, `packages/core`, `packages/db`. Two brief rules
constrain the rest: the frontend talks only to the public API, and "attribute definitions drive
everything — never hard-code a column", which makes the filter model shared vocabulary.

**Options.** (1) Four packages, e2e inside `apps/web`. (2) Five. (3) Eight, adding `ui`, `llm`,
`jobs`, `api-client`, `contracts`, `import`.

**Choice.** Five: `apps/api`, `apps/web`, `packages/core`, `packages/db`, `e2e`.

```
apps/web ──HTTP──▶ apps/api ──▶ packages/db ──▶ packages/core
    │                                              ▲
    └────────── types + filter model ──────────────┘
                     e2e ──▶ packages/db, packages/core   (dev only)
```

- `packages/core` depends on `zod` and `libphonenumber-js` only. No `node:*`, no `pg`, no `kysely`,
  no `fastify`. It ships to the browser.
- `packages/db` depends on `core`, `kysely`, `pg`.
- `apps/api` depends on `core` + `db`. `apps/web` depends on `core` only.

**Consequences.** The rejected packages, and where their code lives instead — every one of these is a
directory rename plus a `package.json` on the day a second consumer appears:
`packages/contracts` → `packages/core/src/contracts/`; `packages/ui` → `apps/web/src/components/ui/`
(ADR-050); `packages/llm` → `apps/api/src/llm/`; `packages/jobs` → `apps/api/src/jobs/`;
`packages/import` (file parsers) → `apps/api/src/import/`; `packages/api-client` → deleted (ADR-030);
`integrations/` → `apps/api/src/integrations/` (§9 extension point, interface only).
`e2e` is a separate package because Playwright must truncate and reseed, so it needs `@mutuals/db`,
and putting it inside `apps/web` would make the database a devDependency of the frontend — the one
boundary the brief states twice. **`e2e/` is created in Stage 2 with the first spec**, not now.

### ADR-007 — One base tsconfig plus one per package; no project references

**Context.** Nothing except `apps/web` emits. Project references would force `composite: true` and
therefore declaration emit purely to satisfy a build system.

**Options.** (1) One base + one per package. (2) Project references. (3) One root tsconfig with `paths`.

**Choice.** Option 1. `tsconfig.base.json` holds `strict`, `noUncheckedIndexedAccess`,
`erasableSyntaxOnly`, `verbatimModuleSyntax`, `stableTypeOrdering`, `isolatedModules`, `noEmit`.
`api`/`db`/`e2e` add `"types": ["node"]` and `module`/`moduleResolution: nodenext`; `web` uses
`module: preserve`, `moduleResolution: bundler`. **`packages/core` declares no `types` at all** — it
is the isomorphic package, and pulling in `@types/node` there defeats the guard in ADR-009.
Workspace packages resolve through `exports: { ".": "./src/index.ts" }`.

**Consequences.** Relative imports inside a package are written with the `.ts` extension, because
Node's type stripping does not remap `./a.js` → `a.ts`.

### ADR-008 — Node type stripping in development; a bundled entry point in production

**Context.** Measured: Node 24.20.0 runs `.ts` with no flag, and a workspace package exporting raw
`.ts` through a pnpm symlink imports cleanly, with `node --watch` restarting on edits to the
dependency's source. Also measured: Node **refuses** to strip types from any file whose real path is
inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and `pnpm deploy` materialises
workspace dependencies as real directories there.

**Options.** (1) Raw `.ts` in dev and prod. (2) `tsx` 4.23.13 everywhere. (3) Precompiled `dist/`
everywhere. (4) Raw `.ts` in dev, a bundle for production.

**Choice.** Option 4. Development: `node --watch --env-file-if-exists=.env apps/api/src/main.ts`, no
loader, no bundler, no watcher library, and `packages/core`/`packages/db` have no build step.
Production: `pnpm build:api` runs esbuild once into a single `apps/api/dist/main.js`
(`--platform=node --format=esm --packages=external --bundle`), and `pnpm start` runs that file.

**Consequences.** `pnpm deploy` is documented as **unsupported**; the two supported deployment shapes
are "run the bundle" or "deploy the whole workspace and `pnpm install --frozen-lockfile --prod`".
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` and `--preserve-symlinks` are named in
`ARCHITECTURE.md` as the constraints this buys. CI boots the production start path once, so the
failure cannot reach a deploy. `esbuild` is a build-only dependency and never runs in the dev loop.

### ADR-009 — ESLint 10 flat config + typescript-eslint (type-aware) + Prettier

**Context.** Brief §3.2 requires ESLint, Prettier and a CI lint job.

**Options.** (1) ESLint 10.9.1 + typescript-eslint 8.69.0 + Prettier 3.9.6. (2) Biome 2.5.12. (3) oxlint.

**Choice.** Option 1. Biome is faster and has no type-aware rules; `no-floating-promises` is the
reason the whole TypeScript version decision (ADR-003) was taken, so giving it up to save seconds
would be incoherent.

**Consequences — three fixes to the proposed config, each verified as a real failure:**

1. `scripts/**/*.mjs` is linted with `js.configs.recommended` only, **outside** the
   `recommendedTypeChecked` block. With `projectService: true` and the file excluded from every
   tsconfig, `eslint .` fails on the first run with "was not found by the project service".
2. The `packages/core` import guard bans the **whole** builtin set, not just `node:`-prefixed
   specifiers — the group is built from `builtinModules` in `node:module`, because bare `fs` and
   `path` passed the proposed rule and are exactly what a copy-pasted helper drags into a browser
   bundle. The same rule bans `pg`, `kysely`, `fastify`.
3. `apps/web` gets type-aware linting too (the proposal exempted it silently), and
   `apps/web/src/components/ui/**` relaxes `eslint-plugin-react-hooks@7`'s React Compiler rules
   (purity, immutability, set-state-in-render) because those fire on unmodified shadcn components.

`prettier --check .` runs with a `.prettierignore` covering `docs/refs/`, `fixtures/`,
`packages/db/migrations/*.sql` and every generated artifact.

### ADR-010 — One `.env` at the repo root, validated by Zod at boot

**Context.** Two apps, one database, one LLM key. Node 24 reads `.env` natively; Vite reads it via
`envDir`. Verified: `--env-file-if-exists` prints a notice and exits 0 when the file is absent, while
plain `--env-file` hard-fails, and the real process environment wins over the file.

**Options.** (1) One root `.env`. (2) Per-app `.env` files. (3) The `dotenv` package. (4) direnv.

**Choice.** One root `.env`, `.env.example` committed and complete, loaded by
`--env-file-if-exists` (API, scripts) and Vite's `envDir: '..'`. **No `dotenv` dependency.** A Zod
schema validates the whole documented surface at boot and fails with `z.prettifyError`.

**Consequences.** **`.env.test` is deleted.** The integration suite reads a single
`TEST_DATABASE_URL` from the root `.env`, and `globalSetup` asserts its database name ends in
`_test` before any `TRUNCATE`. The previous design had two variables carrying the same fact, a
`.gitignore` that hid the file a fresh clone needed, and no stated winner for the safety guard.
Every key `.env.example` documents is in the Zod schema, or it is not in `.env.example`.
The `LLM_EMBEDDING_*` keys are **not** in `.env.example` in Phase 1 — they are documented in
`ARCHITECTURE.md` and added in Stage 8, because nobody can fill them in for six stages.

### ADR-011 — `pnpm dev` is one command and never requires Docker

**Context.** §3.1: one command. §12: Simon is not a developer. The machine has no Docker and no
Postgres, so the command must find or start a database, migrate it, run two processes, and when it
cannot, print instructions a non-developer can follow.

**Options.** (1) A zero-dependency preflight script. (2) `docker compose up` running everything.
(3) Two terminals. (4) The Supabase CLI.

**Choice.** Option 1 — `scripts/dev.mjs`. Options 2 and 4 need the thing the machine does not have;
option 3 fails §12.

**Consequences — four fixes to the proposed script:**

- `new URL(process.env.DATABASE_URL)` is inside a `try/catch` that prints _"DATABASE_URL could not be
  parsed — if your password contains `@ : / #`, percent-encode it"_ with a worked example. Verified:
  a Supabase-style password containing `/` throws `ERR_INVALID_URL`, and `.env.example` tells the
  user to paste exactly such a string.
- When the host is not `localhost`/`127.0.0.1`, an unreachable database prints a connectivity hint,
  not a three-option "install Postgres locally" menu.
- `spawnSync(process.platform === 'win32' ? 'where' : 'which', …)`.
- After migrating, the script logs the server version and the resolved database name, so hitting the
  wrong server is obvious instead of confusing.

**CORS never exists**, and that is worth stating: in dev, Vite proxies `/api` to Fastify; in
production, Fastify serves `apps/web/dist` and `/api/v1/*` from one origin. `VITE_API_URL` defaults
to the empty string.

### ADR-012 — Postgres provisioning: compose for the database only

**Context.** Three local paths must work: Docker, Postgres.app, Homebrew. Plus Supabase as managed
Postgres for the shared instance.

**Options.** (1) `docker-compose.yml` with a database service only. (2) Full-app compose.
(3) `embedded-postgres`. (4) A project-local cluster installed by a shell script.

**Choice.** Option 1, `pgvector/pgvector:pg16`, database service only, `${DB_PORT:-5432}` published,
a healthcheck, and `--wait` used by `scripts/dev.mjs`. Postgres.app is the primary no-Docker path;
Homebrew is documented **with the `postgresql@18`, not `@16`, correction** (ADR-002).

**Consequences.** `embedded-postgres` is disqualified because it cannot carry `pgvector` — Phase 1
would work with a NULL vector column and break in Stage 8. The alternative "project-local cluster in
`./.pgdata`" proposal is **rejected outright**: its `pnpm db:up` ran `brew install` and, on Linux,
`sudo apt-get install` unprompted, and cloned `pgvector` at a **mutable git tag** straight into `make
install`. An npm script that escalates to root is not something an MIT repo asks a stranger to run.
`pnpm db:up` in this design **detects and instructs**; it installs nothing without an explicit
`--install` flag. `.env.example` states that `DB_PORT` and the port inside `DATABASE_URL` must change
together. `pnpm db:up` also creates `mutuals_dev`, `mutuals_test` and `mutuals_e2e`.

---

## 3. Storage — the load-bearing layer

`storage-DECISION.md` §2's DDL is adopted in full except where an ADR below amends it. The amendments
are ADR-019 (normalisation), ADR-020 (`fact` carries no derived columns), ADR-024 (projector bugs) and
ADR-002 (no `pgcrypto`).

### ADR-013 — Typed EAV: an append-only `fact` log projected into one derived model

**Context.** §4.2 requires user-defined attributes with fast filter and sort on any of them; §4.5
requires an append-only fact log behind every value; §3.2 requires versioned, reproducible migrations.

**Options.** (1) `current_values jsonb` + GIN. (2) Typed EAV: `fact` (truth) → `attribute_value`
(derived). (3) Three layers: `fact` + `attribute_value` + a `current_values jsonb` render cache.
(4) Index the `fact` table directly with partial indexes on live rows.

**Choice.** Option 2. `fact` carries **typed slot columns** (`text_value`, `num_value`, `date_value`,
`bool_value`, `option_id`, `target_record_id`) rather than an untyped blob. `attribute_value` is the
**one** derived model — used for `WHERE`, `ORDER BY` and reading a row — with identical typed columns,
so projection is a column-for-column copy. Relations live in `record_link` because the link carries
its own attributes (§4.3). Derived columns live in `contact_metrics` / `organization_metrics`.
Full-text and the future `vector(1536)` live in `search_document`. **Nine fixed indexes on
`attribute_value`, each led by `attribute_id`.**

**Consequences.** Creating an attribute is one `INSERT`; deleting one is one `DELETE`. **No runtime
DDL**, so §3.2's "migrations versioned in the repo" is literally true instead of "plus whatever the
user clicked". Every row in `attribute_value` is by construction current, so there is no liveness
predicate for a query to forget — the failure mode that rules out both option 1 (a wrong-typed JSON
value makes a record silently vanish from a filter) and option 4 (one forgotten predicate renders a
superseded value as current). Costs, named and accepted: ~15× row amplification, ~3–4× write
amplification, the planner is blind to per-attribute statistics, `ORDER BY` on a custom attribute is a
sort of the filtered set rather than an index-ordered scan (fine to ~100k matching rows; §9.4 of the
storage document holds the escape hatch), and every query is longer — confined to one compiler.
The `current_values jsonb` render cache stays available as a **purely additive** later change: one
column, one line in the projector, one branch in the serialiser. Add it only if Stage 7's 10k-row
profile puts hydration on the hot path.

### ADR-014 — `workspace_id` nullable per §9, but always populated

**Context.** §9 requires "every table gets a nullable `workspace_id` column now".

**Options.** (1) Nullable and unpopulated. (2) Nullable and always populated. (3) NOT NULL now.

**Choice.** Option 2, with `UNIQUE NULLS NOT DISTINCT` on every unique constraint that carries it.

**Consequences.** Every query is `= $ws` from day one, not `IS NOT DISTINCT FROM`, which cannot use
an equality index well. Uniqueness holds even if a seed script or a hand-run migration forgets the
column. `workspace_id` is in **no index key** in Phase 1 — it is a constant column. The multi-tenant
migration is `SET NOT NULL` plus one pass of `CREATE INDEX CONCURRENTLY` with `workspace_id`
prepended, and zero logic changes. CI asserts no row anywhere has a NULL `workspace_id`.

### ADR-015 — A `record` supertype; `interaction` is a subtype from day one

**Context.** Five tables (`fact`, `attribute_value`, `identifier`, `record_link`, `search_document`)
point at "a contact or an organization". Postgres has no polymorphic foreign key, and §4.5 requires
deleting a record to delete its facts.

**Options.** (1) A `record` supertype with `contact`/`organization`/`interaction` as `id`-sharing
subtypes. (2) Nullable FK pairs plus CHECKs on five tables. (3) No referential integrity.

**Choice.** Option 1.

**Consequences.** One hash join on every list query, against a permanently cached table, and one
extra `INSERT` on create. In exchange, five polymorphic tables get real `ON DELETE CASCADE`, the
`relation` attribute type has one FK target, provenance has one home, and §4.1's "model interactions
so custom attributes would be a small change" becomes _literally_ small: adding custom attributes to
interactions is inserting `attribute_definition` rows and nothing else.

### ADR-016 — Hard delete, not soft delete

**Context.** §5.4 promises "This will delete 3 contacts and 12 interactions"; §4.5 says deleting a
record deletes its facts; §6.8 requires re-import after deletion not to be blocked.

**Options.** (1) `deleted_at` soft delete. (2) Real delete via `ON DELETE CASCADE`.

**Choice.** Option 2. A soft-deleted contact's email would occupy the `identifier` unique index and
block ever re-importing that person.

**Consequences.** Deletion is irreversible, and the confirmation dialog states the counts in numbers.
Attribute deletion is one `DELETE` on `attribute_definition`, cascading facts, values, links and
options. Select **options** are the exception: `option_id` FKs are `ON DELETE RESTRICT`, and §6.7's
flow is ask clear-or-remap → append superseding facts → project → set `archived_at`, so history still
renders the old label.

### ADR-017 — Three operator semantics the brief does not specify

**Context.** Notion and Airtable disagree with each other on all three.

**Options.** Notion's conventions, or Airtable's. They disagree with each other on all three, so there is no de-facto standard to defer to and each has to be settled on how a person reads the chip.

**Choice.**

- **`is empty` means "no live value row exists"**, for all twelve types, compiled as one `NOT EXISTS`
  over `av_attr_rec_idx`. `CHECK (text_value <> '')` on both `fact` and `attribute_value` makes
  "empty string" and "no value" incapable of diverging at any write site.
- **`number ≠ x` means "has a value, and it differs"** — it does not include records with no value,
  because `is empty` is a separate operator and the other convention silently returns every empty
  record, which reads as a bug.
- **`single_select is not one of` means `NOT (is one of)`** and therefore **does** include records
  with no value, matching how a person reads "is not an Investor".

**Consequences.** All three are shown verbatim in the filter chip's tooltip, so the user is never
guessing, and all three are golden-SQL unit tests.

### ADR-018 — `value_key` is `''` for every single-valued attribute

**Context.** `value_key` is the identity of one value inside one attribute on one record. Three
mechanisms depend on it: `av_record_attr_uq (record_id, attribute_id, value_key)`,
`fact_live_uq (record_id, attribute_id, value_key) WHERE superseded_by_id IS NULL`, and the sort join
`LEFT JOIN attribute_value sv ON … AND sv.value_key = ''`. The storage document defines `''` for
single-valued attributes; the domain-core proposal exported a `valueKey(norm)` helper returning the
normalised text for **every** prepared value. Two documents, two rules, and five surfaces reading one
column.

**Options.** (1) `''` for single-valued, canonical value for multi-valued. (2) The canonical value
always, plus an `is_multi` predicate everywhere cardinality matters.

**Choice.** Option 1, written down once as the derivation table and computed in the write path from
`is_multi` alone:

| cardinality / type          | `value_key`                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------- |
| any single-valued attribute | `''`                                                                                    |
| `tags`                      | `left(mutuals_norm(text_value), 512)`                                                   |
| `multi_select`              | the option's stable `key`                                                               |
| `relation`                  | not applicable — identity is `record_link (from_record_id, attribute_id, to_record_id)` |

**Consequences.** The `valueKey()` helper in `packages/core` is **deleted**; nothing outside the write
path computes this value. One correction to the review that raised it: the failure it predicted — a
single-valued text attribute storing normalised text, so every alphabetical sort silently returns
`NULL` — **cannot happen**, because `CHECK (is_multi OR value_key = '')` already exists on both `fact`
and `attribute_value` and turns it into a loud write error. So this ADR buys a readable rule rather
than a rescued bug, and that is the honest claim. Because `''` is shared by every single-valued
attribute, one unique index expresses "at most one value" for single-valued and "at most one row per
element" for multi-valued, with no second code path. Two named tests: a single-valued `short_text`
writes `value_key = ''` and is returned by the alphabetical sort; the same string written as a `tags`
element writes the normalised key and is matched by `contains any of`.

### ADR-019 — Text normalisation has exactly one implementation, and it is SQL

**Context.** This is the change with the widest blast radius. The proposals had a TypeScript fold
(`packages/core/src/text/normalize.ts`) _and_ Postgres `unaccent`, pinned together by a "highest-value
test in the suite". That test cannot pass: verified, `'İstanbul'.toLowerCase()` is `i̇stanbul`
(i + U+0307) where Postgres gives `istanbul`; `unaccent` maps `ß→ss` and expands `ﬁ`, `ĳ`, `Ⅷ`;
`pg_trgm`'s word-character test is locale-dependent. Making them agree means hand-porting
`unaccent.rules` (~1500 entries) plus locale case-folding into TypeScript and keeping it in sync
forever — precisely the brittle cleverness the brief forbids.

**Options.** (1) Two implementations plus a contract test. (2) Normalise in TypeScript only and have
SQL never normalise. (3) Normalise in SQL only and have TypeScript never produce a value compared
against a normalised column.

**Choice.** Option 3, expressed as one house rule:

> **TypeScript never produces a value that is compared against a normalised database column.**

Mechanically:

```sql
CREATE FUNCTION mutuals_norm(text) RETURNS text
  LANGUAGE sql STABLE STRICT AS $$ SELECT lower(unaccent('unaccent', btrim($1))) $$;
```

- `attribute_value.text_norm` = `mutuals_norm(text_value)`, `text_sort` = `left(text_norm, 256)`
  (NULL for `long_text`), both **written by the projector**.
- `record.label_norm` = `mutuals_norm(display_label)`, written by the existing label trigger.
- `fact.value_key` for `tags` = `left(mutuals_norm(text_value), 512)`, computed in the `INSERT`
  statement (single-row path) or in the `INSERT … SELECT` from the staging table (bulk path).
- The filter compiler normalises the **needle in SQL**: `WHERE v.text_norm = mutuals_norm($1)` and
  `WHERE v.text_norm LIKE '%' || mutuals_esc(mutuals_norm($1)) || '%'`.
- Duplicate **candidate generation and trigram scoring both happen in SQL** (`similarity()`);
  `packages/core` receives already-scored candidates and applies the rule table (ADR-037).

**Consequences.** The TypeScript trigram reimplementation, the fold table, the `unaccent.rules` port
and the 100-pair contract test are all **deleted** — one algorithm fewer to maintain and one whole
class of silent divergence gone. `mutuals_norm` is only ever called in `INSERT`/`UPDATE`/`WHERE`,
**never inside an index definition**, so it does not need to be `IMMUTABLE` and the whole
"`unaccent` is STABLE" problem evaporates — as does the need for `contact.name_key`, since
`record.label_norm` is a written column with its own trigram GIN. `packages/core` keeps a _display_
casefold for UI conveniences (deduplicating tag suggestions as you type); it is documented as
**not** the filter contract and nothing asserts the two agree. If `unaccent` is unavailable on a
target Postgres, `mutuals_norm` becomes `lower(btrim($1))`: one line, then `pnpm db:reproject`. Only
accent-insensitivity is lost. The cluster keeps its host default locale; determinism for sorting
comes from `text_sort text COLLATE "C"` at the column level, not from a cluster-wide `lc_ctype=C`.

### ADR-020 — `fact` carries no derived columns

**Context.** One proposal moved `text_norm`/`text_sort` into `fact` so TypeScript could write them.

**Options.** (1) Derived text columns on `fact`. (2) Derived text columns only on `attribute_value`.

**Choice.** Option 2. `fact` is the truth log and holds only what was observed, plus its provenance.

**Consequences.** `pnpm db:reproject` can rebuild every derived value from `fact` alone — which is
the entire safety argument for keeping a projection. A `CHECK` on a derived column in an append-only
log could only ever assert `NOT NULL`; it could never assert _correct_, so a hand-written or
mis-versioned `INSERT INTO fact` would have produced a permanently wrong row that no rebuild
could repair.

### ADR-021 — `valid_from` is stored and displayed, but does not gate currency

**Context.** §4.5 defines current as "the newest non-superseded fact"; `valid_from` invites bitemporal
resolution.

**Options.** (1) Bitemporal resolution, with currency ordered by `valid_from`. (2) Unconditional supersession, with `valid_from` stored and displayed but never ordering currency.

**Choice.** Supersession in the write path is unconditional: the newest write wins. `valid_from` is
stored, indexed and shown in the history popover ("Company: Stripe — _since Jun 2025_, from LinkedIn
import") but never orders currency.

**Consequences.** Said explicitly because a half-implemented bitemporal rule is worse than none: an
ordering clause that never fires is a lie in the code. Extension point:
`project_record_as_of(record, date)` is the same function with `AND valid_from <= p_date` and a
`DISTINCT ON`; no schema change, the columns are already there.

### ADR-022 — Warmth: one implementation, in `packages/core`, `k = 0.13273229`

**Context.** §4.7 requires a pure function in `packages/core` with unit tests, calibrated so one
meeting per month ≈ 75.

**Options.** (1) A TypeScript function plus a set-based SQL twin for the nightly sweep. (2) Exactly one implementation, in TypeScript. (3) SQL only, dropping §4.7’s "pure function in `packages/core`".

**Choice.** Exactly one implementation, in TypeScript. The nightly sweep is: one aggregate query →
`computeWarmth()` → one batched write-back. No SQL twin.

Calibration, recomputed: `Σ(n=0..12) e^(−n/3) = 3.48142954787`; `signal = 3.0 × that =
10.4442886436`; `warmth = 75` needs `e^(−k·signal) = 0.25`; **`k = ln 4 / 10.4442886436 =
0.132732291152 → 0.13273229`**. The previously published `0.13273534` does not match its own stated
derivation and made two named CI assertions red on day one. No published warmth value in the
calibration table changes.

**Consequences.** The test computes the calibration signal from the geometric series rather than
typing a literal, and asserts `WARMTH_K === Math.log(4)/CALIBRATION_SIGNAL` to 8 decimals, so the
constant, the derivation and the docs cannot drift apart again. Decay is on **whole civil days** in
the profile timezone, so the nightly sweep only touches rows that moved. Future-dated interactions
are clamped, not dropped. Overrides apply last, and **cap beats floor**: `min(not_important ? 10 :
100, max(pinned_important ? 60 : 0, raw))` — `not_important` also means "stay quiet".
**The sweep writes back every contact row in the workspace**, not only contacts with an interaction
in the last 365 days: otherwise a contact who goes quiet keeps last year's warmth forever, and after
a 10k-row LinkedIn import almost no row ever gets a `computed_at`. Freshness is read from a scalar
`workspace.metrics_swept_at`, written by the sweep as its last statement (ADR-060).

### ADR-023 — Row count is a separate, exact, cached query; pagination uses an opaque cursor

**Context.** §5.2 wants "Rows: 2,236" in the footer.

**Options.** (1) `count(*) OVER ()`. (2) A separate exact count. (3) A tri-state `?count=auto|exact|none`
with a `reltuples` estimate and `meta.totalIsEstimate` on the wire.

**Choice.** Option 2. `count(*) OVER ()` must buffer the entire filtered set before emitting the first
row, so `LIMIT 50` short-circuits nothing. `meta.total` is an **exact nullable integer**, memoised per
filter signature for the duration of a view.

**Consequences.** Option 3 is dropped as over-engineering: at a few thousand contacts a narrow count
is sub-millisecond, and "Rows: ~2,200" is _worse_ UX than the truth. Because `total` is already
nullable, an estimate can arrive later with no API change. The list cursor is **opaque**, so today's
`LIMIT/OFFSET` for custom-attribute sorts becomes keyset later with no API or UI change. The proposed
`(filter, sort)` signature hash inside the cursor and the `stale_cursor` 400 are dropped — they guard
a bug unreachable in a single-user app whose only client always sends the filter alongside the cursor.

### ADR-024 — Two projector defects fixed before Stage 1 ships

**Context.** The projection-equivalence exercise found two real bugs in the proposed `project_record`.

**Options.** (1) Ship as proposed and fix whatever the equivalence gate catches. (2) Fix both defects in the migration before the gate is written.

**Choice.**

1. The three `string_agg` calls that build `search_document.body` get an explicit `ORDER BY`. Without
   one, the body text — and therefore the generated `tsvector` — is not a function of the data, and
   `db:reproject` can produce a different (equally valid) string, breaking the equivalence gate for
   no real reason.
2. The two `row_number()` windows that assign `attribute_value.position` and `record_link.position`
   get `f.id` as a final tiebreaker. Without it, rows with an identical `observed_at` — which is
   every row of a `COPY` import — tie non-deterministically.

**Consequences.** These land in the migration before the equivalence gate is written, so the gate's
first run is meaningful rather than a false alarm.

### ADR-025 — Projection equivalence is a per-record digest map, checked where state accumulates

**Context.** The safety argument for keeping a derived copy is that a full rebuild reproduces it.

**Options.** (1) A single `md5()` over the whole database. (2) A sorted per-`record_id` digest map
compared with `toEqual`.

**Choice.** Option 2, run as the **last test inside the integration project**, in one worker's own
database, after that worker's mutations.

**Consequences.** When it trips, Vitest prints the diverging records instead of `expected 'a3f…' to be
'b71…'`. The proposed CI wiring ran `db:reproject:verify` against a `mutuals_dev` database that the
job never created, never migrated and never seeded, while the mutations happened in
`mutuals_test_w1..4` under a per-test `TRUNCATE` — so the gate would have errored or passed vacuously.

---

## 4. Data access, migrations and the public API

### ADR-026 — Kysely 0.29.5 on `pg` 8.23.0 as the query layer, not Drizzle

**Context.** The brief flags this hardest ("Drizzle is the leading candidate; justify your pick"), and
ADR-013's schema constrains the answer: a composite FK to a non-primary-key unique target,
`UNIQUE NULLS NOT DISTINCT` on five tables, six partial indexes and one partial unique index, a
multicolumn GIN mixing a `btree_gin` uuid opclass with `gin_trgm_ops`, a `text COLLATE "C"` column, a
generated `tsvector`, a `vector(1536)`, a plpgsql projector and four triggers.

**Options.** (1) Drizzle ORM 0.45.2 + drizzle-kit 0.31.10. (2) Kysely 0.29.5 on `pg`. (3) Raw `pg`
with hand-written mappers.

**Choice.** Option 2.

**Reasoning.** Not because Drizzle is bad — 20.3M weekly downloads, and it would work. Because
`schema.ts` would be a partial lie: every constraint that makes this design safe is inexpressible, so
`drizzle-kit generate` would keep proposing to drop objects it cannot see, and you would have to stop
trusting the tool's main feature. The hot path is correlated `EXISTS` composition, one per filter
chip, which is Kysely's first-class typed operation and Drizzle's `sql`-fragment escape hatch. And
`drizzle-orm@0.45.2` has not moved since 2026-03-27 while `1.0.0-rc.5` publishes weekly — adopting it
means adopting a scheduled major rewrite on the package that touches every file in `packages/db`.
Raw `pg` is rejected for the other 80% of the API — ordinary CRUD over ~15 tables — where
hand-written column lists and row mappers are pure cost.

**Consequences.** Kysely is a string builder: no ORM, no unit of work, no lazy loading, no N+1.
`.compile()` is pure, so golden-SQL tests need no database. Kysely 0.29 is ESM-only, needs Node ≥22
and TypeScript ≥5.4, and moved `Migrator` to the `kysely/migration` subpath — all satisfied.

### ADR-027 — The `DB` interface is hand-maintained, guarded by an `information_schema` drift test

**Context.** The proposal generated `DB` with `kysely-codegen@0.20.0` and made a byte-identical
`git diff` a CI gate. Verified: that package's own `devDependencies.kysely` is `^0.28.11` and it has
not published since 2026-02-16, three months before kysely 0.29 shipped its breaking ESM-only,
`kysely/migration` release. Its peer range `>=0.27.0 <1.0.0` admits 0.29.5 on paper only. Worse,
`--camel-case` renames **tables and columns** (`attributeValue.textNorm`, `recordLink.fromRecordId`),
so every identifier in the filter compiler and in the hand-written `.sql` files would be a type error,
and `CamelCasePlugin` does not rewrite identifiers inside raw `sql` fragments — of which this design
has many.

**Options.** (1) Generated, committed, `git diff` gate. (2) Hand-written, drift test. (3) Generated
with `schema.overrides.ts`.

**Choice.** Option 2. `packages/db/src/schema.ts` is bootstrapped **once** by running
`kysely-codegen` (no `--camel-case`) against a migrated database, reviewed by a human, then
hand-maintained. A CI test reads `information_schema.columns` from the migrated database and asserts
it matches the interface, table by table and column by column, including nullability.

**Consequences.** The honest claim is now "drift fails a test", not "drift is impossible by
construction" — a materially weaker guarantee than the one used to reject the brief's default, and it
is stated as such. In exchange, an unmaintained CommonJS tool that `require()`s an ESM-only dependency
is out of the correctness path. **`packages/db` is snake_case end to end**, matching the `.sql` files
a reviewer reads; camelCase happens once, at the API boundary, where the Zod response schemas already
name `displayName`, `createdAt`, `lastInteractionAt`. `pnpm db:codegen:suggest` remains available as
a convenience for writing new tables; it is never a gate.

### ADR-028 — Plain numbered `.sql` migrations, run explicitly, checked on boot

**Context.** §3.2: versioned, in the repo, reproducible. There is no TS schema DSL to diff against
(ADR-027), so migration _generation_ is not a requirement — migration _application_ is.

**Options.** (1) drizzle-kit generate/migrate. (2) Kysely's `Migrator` with a
`SqlFileMigrationProvider` over numbered `.sql` files. (3) `node-pg-migrate`. (4) Migrate on API boot.

**Choice.** Option 2. `packages/db/migrations/0001_*.sql`, `0002_*.sql`, … Applied by
`pnpm db:migrate`, **never automatically on boot**. The API calls `assertSchemaCurrent()` at startup
and refuses to serve if the database is behind.

**Reasoning, verified in the libraries' own source.** `pg@8.23.0`'s `requiresPreparation()` ends
`return this.values.length > 0`, and Kysely's Postgres driver calls
`client.query(compiledQuery.sql, compiledQuery.parameters)`. An empty parameter array selects the
**simple** protocol, so a whole DDL file — dollar-quoted `plpgsql` and all — runs as written. That is
the mechanism that makes hand-authored SQL a first-class citizen rather than a workaround.

**Consequences — three corrections.**

1. Kysely's `Migrator` runs **the entire migration run in one transaction**
   (`runWithLock(db, db => db.transaction().execute(run))`), not one per migration. The safety
   conclusion is stronger, not weaker — a failure at `0007` rolls back `0005` and `0006` too — but
   anyone reasoning about partial application from the old text would have been wrong.
2. **The `.notx.sql` escape hatch is deleted.** `Migration` in kysely 0.29.5 has only `up`/`down`;
   `disableTransactions` is Migrator-level; and the Migrator throws _"corrupted migrations: previously
   executed migration X is missing"_ the moment a provider omits a recorded migration. A runner that
   filtered out `.notx.sql` files would throw as soon as one had been applied. Nothing in Phase 1 needs
   `CONCURRENTLY`, and ADR-013 forbids runtime DDL; if it is ever needed the honest answers are a
   second ledger table or `disableTransactions: true`, and that is one line in a future ADR.
3. `assertSchemaCurrent()` catches Postgres error `42P01` (`kysely_migration` does not exist on a
   genuinely fresh database) and prints _"Run: pnpm db:migrate"_ instead of a relation-not-found error.

### ADR-029 — REST, OpenAPI 3.1 generated from Zod 4

**Context.** §3.2 makes this the default and requires any tRPC proposal to explain how non-TypeScript
clients still get REST. §7 requires `/api/v1`, docs at `/api/docs`, a middleware slot for a future
bearer token, and — the sentence that actually constrains the design — _"every operation the UI
performs must be a single, well-named API operation"_.

**Options.** (1) REST + Zod + `fastify-type-provider-zod@7.0.0`. (2) tRPC 11 + `trpc-to-openapi`.
(3) A hand-written `openapi.yaml` as the source.

**Choice.** Option 1. One schema object per route feeds three consumers at once: Fastify's validator,
Fastify's serialiser, and `@fastify/swagger`'s document generator. OpenAPI **3.1**, not 3.0, because
3.1 _is_ JSON Schema — the same dialect the LLM structured-output path and MCP tool definitions want.
`@fastify/swagger-ui` serves `/api/docs`; the raw document is at `/api/v1/openapi.json` and is
**committed** as `docs/openapi.json`, regenerated and diffed in CI.

**Consequences — three corrections.**

- Registering a schema in `z.globalRegistry` emits **two** components, `X` and `XInput`; v7 splits
  input/output variants. Documented, so nobody wonders why the spec doubled.
- The contract test comparing `z.toJSONSchema(FilterSetSchema, {target:'draft-2020-12'})` to the
  emitted component must **strip `$schema`**; as written it was red on day one.
- **No `bearerAuth` security scheme is published.** §7 asks for a middleware slot; the empty
  `fastify-plugin` `preHandler` _is_ that slot. Declaring an auth scheme no operation enforces tells
  every generated client to send credentials that are ignored.

House rule: `z.toJSONSchema` is **always** called with an explicit `io` (`'input'` for query/body,
`'output'` for responses). Its default is `'output'`, which silently yields the parsed array shape for
the `?filter=` wrapper.

### ADR-030 — The frontend gets its types from `@mutuals/core`; no client codegen

**Context.** §3.2: "the frontend should get types from the API without hand-writing them."

**Options.** (1) Generate `schema.d.ts` from `openapi.json` with `openapi-typescript@7.13.0`, then
`openapi-fetch` + `openapi-react-query`. (2) Import the Zod schemas and their inferred types from the
shared package and hand-write a ~40-line typed fetch wrapper.

**Choice.** Option 2. `packages/core/src/contracts/` owns every request and response schema; `apps/api`
implements them and emits OpenAPI from them; `apps/web` imports `z.infer` types and parses responses
with the same schemas.

**Reasoning.** The codegen chain existed to serve a frontend that lives in the same repository as the
schemas. Dropping it removes three runtime dependencies, a committed generated file, two CI gates, and
`openapi-fetch`'s verified error-path type lie (a non-JSON 502 body yields a raw string while the
generated type still says `Problem`). It also removes the `typescript ^5.x` peer that was pinning the
whole repository one major behind (ADR-003). OpenAPI is still emitted and committed, so §7's MCP,
CLI and Python story is unaffected — it just is not in the frontend's build path.

**Consequences.** `docs/openapi.json` is the single reviewable generated artifact and the single
generated-artifact CI gate. Web response parsing tolerates unknown keys where a client-only field
(`_pending`, ADR-049) is attached, by attaching such state in a side map keyed by row id rather than
on the row.

### ADR-031 — Wire contract

**Context.** §7 requires a consistent error shape with per-field validation errors, a documented
filter model, and one named operation per UI action.

**Options.** (1) A bare object for one resource and `{data, page, meta}` for lists, with RFC 9457 errors. (2) JSON:API. (3) One uniform envelope for every response, single resources included.

**Choice.**

- **Single resource:** the bare object. **Lists:** `{ data: T[], page: { cursor, hasMore },
meta: { total } }`. `total` is an exact nullable integer.
- **Errors:** RFC 9457 `application/problem+json` — `type`, `title`, `status`, `detail`, `instance`,
  plus `errors: [{ field, code, message }]` for validation. `type` URIs point at anchors in the
  repository's `docs/ERRORS.md` on GitHub; RFC 9457's default is `about:blank` and the URI is
  explicitly not required to dereference, so this is not a question for a human.
- **Attribute values:** an **empty attribute is an absent key**, matching ADR-017's single definition
  of empty. Select options are carried by stable `key`, never by uuid.
- **Concurrency on inline edits:** documented **last-write-wins**. §5.2's "error toast on failure"
  fires on 4xx/5xx; there is no `If-Match` in Phase 1. `updated_at` is returned on every record so a
  precondition header is additive later.

The **`attributes` map schema is written down in `packages/core`**, not shown as an example — it is
the response validator that runs on every list request, the type the DataTable consumes, and the
contract the MCP server will consume:

```ts
export const AttributeValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('short_text'), value: z.string() }),
  z.object({ type: z.literal('long_text'), value: z.string() }),
  z.object({ type: z.literal('number'), value: DecimalString, unit: z.string().optional() }),
  z.object({ type: z.literal('date'), value: CivilDate }),
  z.object({ type: z.literal('yes_no'), value: z.boolean() }),
  z.object({ type: z.literal('single_select'), value: OptionRef }), // {key,label,color}
  z.object({ type: z.literal('multi_select'), value: z.array(OptionRef) }),
  z.object({ type: z.literal('tags'), value: z.array(z.string()) }),
  z.object({ type: z.literal('url'), value: z.string() }),
  z.object({ type: z.literal('email'), value: z.string() }),
  z.object({ type: z.literal('phone'), value: z.string() }), // E.164 when parseable
  z.object({ type: z.literal('relation'), value: z.array(RelationRef) }), // {id,label,objectType,
]) //  title?,from?,to?,isPrimary?}
export const AttributesSchema = z.record(SlugSchema, AttributeValueSchema)
```

**The complete operation list (34), because CI cannot detect a missing one.** The proposed CI check
only asserts `operationId`s are unique and non-empty; it structurally cannot prove UI coverage, so the
list itself is the reviewable artifact:

`listContacts` `getContact` `createContact` `updateContact` `deleteContact` `bulkDeleteContacts`
`bulkUpdateContactAttribute` `mergeContacts` `previewMergeContacts` `getContactConnections` ·
`listOrganizations` `getOrganization` `createOrganization` `updateOrganization` `deleteOrganization`
`mergeOrganizations` · `listInteractions` `createInteraction` `updateInteraction` `deleteInteraction` ·
`listFollowUps` `createFollowUp` `updateFollowUp` `deleteFollowUp` `bulkUpdateFollowUps` ·
`listAttributeDefinitions` `createAttributeDefinition` `updateAttributeDefinition`
`deleteAttributeDefinition` `previewDeleteAttributeDefinition` · `listViews` `createView`
`updateView` `deleteView` · `createImportBatch` `getImportBatch` `updateImportRow` `revertImportRow`
`replaceInImportBatch` `exportImportBatch` `commitImportBatch` `getImportErrorReport` ·
`search` `ask` `quickCapture` `getStats` `getProfile` `updateProfile`.

(That is 48 including the import and profile surface; "34" counts the record-facing ones. The file
`apps/api/src/routes/operations.ts` holds the array, and CI asserts every registered route appears in
it and vice versa.)

**Bulk writes return 200 with per-item results**, not 207:
`{ data: { succeeded: string[], failed: [{ id, code, message }] }, meta: { attempted, succeeded, failed } }`.
A 207 forces every client to parse a multi-status body it otherwise never sees; a uniform 200 with an
explicit `failed` array is what the bulk action bar renders directly.

**The import contract**, end to end (§6.8): `POST /import-batches` (multipart, `@fastify/multipart`,
streamed to disk, returns `{ id, status: 'parsing' }`) → `GET /import-batches/:id` (poll; returns
`status`, `rowCount`, `lastCommittedRow`, `mapping`, `counts`) → `GET /import-batches/:id/rows`
(paged staging rows for the Review grid) → `PATCH /import-batches/:id/rows/:n`,
`POST …/rows/:n/revert`, `POST …/replace` (find-and-replace as one server operation over all staged
rows), `GET …/export` → `POST /import-batches/:id/commit` → `GET …/errors.csv`. Progress is **polled**
at 1 s, not SSE: one fewer transport, and the queue's own latency is ~2 s anyway (ADR-059).
A per-row staging table `import_row (batch_id, row_number, raw jsonb, mapped jsonb, errors jsonb,
duplicate_of uuid, decision text)` is added to the schema — this was an unowned coordination item and
is now decided.

**`?q=`** is defined as: substring over `record.label_norm` **or** the text attributes named in the
request's `columns` parameter, compiled as **one** `EXISTS` with an attribute-id array (an `OR` of
per-column `EXISTS` defeats the semi-join pull-up). The ⌘K palette is a different operation
(`search`) using `label_norm` trigram + identifier prefix + `tsvector`.

**Consequences.** `operations.ts` is the artifact the MCP claim rests on. The claim "CI proves every
UI action maps to one operation" is **withdrawn**; CI keeps ids unique, non-empty and in sync with the
registered routes, and the list is reviewed by a human.

### ADR-032 — One filter model, serialised as a single URL-encoded JSON array in `?filter=`

**Context.** Two serialisations were proposed: one JSON array, and repeated compact
`filter=field:op:value` parameters.

**Options.** (1) One JSON array in `?filter=`. (2) Repeated compact `field:op:value` parameters.
(3) Bracket syntax `filter[0][op]=…`. (4) RSQL/FIQL.

**Choice.** Option 1. `?filter=` carries `encodeURIComponent(JSON.stringify(conditions))`; `sort`,
`columns`, `cursor`, `limit`, `q`, `view` are plain scalars.

**Reasoning.** Verified end to end: `@fastify/swagger` renders the Zod discriminated union as a clean
`oneOf` with `const` discriminants, and the querystring parameter correctly renders as
`{"type":"string"}` because `jsonSchemaTransform` uses the input side. TanStack Router's default
`parseSearchWith(JSON.parse)` handles it natively on the client. Option 2 needs a two-layer escaping
scheme (payload parts percent-encoded, then the whole value encoded again by `URLSearchParams`) that
was never pinned down, and Fastify's default `fast-querystring` decodes `+` as a space — so an
unescaped `+` in a phone fragment silently becomes a space. One JSON value has one escaping layer.

**Consequences.** `packages/core` exports one codec, `parseListQuery(raw: Record<string, string |
string[]>): ListQuery`, which JSON-parses the structured keys and then runs the Zod schema. Fastify
registers it as the route's querystring parser; TanStack Router calls it from `validateSearch`. That
is one definition with an **explicit** wire boundary, instead of the previously claimed "same schema
at both ends", which was false: the router hands the client an array while Fastify hands the handler a
string, and `z.array(...)` rejects one of them. **`cursor` is not in the URL search schema** — it
belongs to the API contract and to `getNextPageParam`, and putting it in the query key would discard
every loaded page on each fetch. An OpenAPI `discriminator` is added via the registry so the generated
Python client gets a tagged union too. The "flatten the union if `oneOf` renders badly" fallback is
deleted — verified unnecessary.

### ADR-033 — The filter compiler lives in `packages/db`

**Context.** Two ADRs disagreed: one put the compiler in `packages/core` emitting SQL text, the other
put it in `packages/core` returning Kysely expressions. The second is impossible — `packages/core`
ships to the browser and may not import a query builder. The first requires splicing raw SQL text and
renumbering parameters at the seam.

**Options.** (1) Compiler in `core`, emitting `{sql, parameters}`. (2) Compiler in `core`, returning
Kysely expressions. (3) Compiler in `packages/db`, consuming `core`'s model and slot table.

**Choice.** Option 3. `packages/core` owns the filter model, `OPERATORS_BY_TYPE`, `SLOT_COLUMNS`
(the one file with physical column names), the query-string codec and relative-date resolution.
`packages/db/src/filter/compile.ts` turns a validated `FilterSet` plus resolved `AttributeDefinition`s
into an `Expression<SqlBool>` per chip and `eb.and([...])` over them.

**Consequences.** The golden-SQL tests still need no database, because `.compile()` is pure — so
§8.1's "filter → query compilation, high coverage" is satisfied and the tests assert the **real** SQL,
not an intermediate representation. `apps/web` imports the operator table and the model, never SQL,
and the browser bundle provably contains none. The `packages/core/./sql` subpath export is deleted,
along with its justification ("a future non-Postgres consumer, of which there is none planned").
The `SLOT_COLUMNS`-only grep test now covers `packages/db/src/filter/**` as well, and its banned-token
list includes `option_id`, `target_record_id`, `text_norm`, `text_sort` and `value_key` — the previous
version banned tokens that its own reference implementation used.

---

## 5. Domain core (`packages/core`)

### ADR-034 — `packages/core` is pure, clock-free and returns `Result`

**Context.** §8.1 singles out attribute validation, slug generation, filter compilation, duplicate
matching, recurrence and import mapping for high-coverage unit tests. Those tests are only cheap if
the functions have no I/O and no ambient clock.

**Options.** (1) Allow an ambient clock and freeze it in tests. (2) Take `now`, `today` and `timeZone` as parameters and forbid ambient time entirely. (3) Throw on invalid user input instead of returning `Result`.

**Choice.** No I/O, no `Date.now()`, no `new Date()` without an argument. `now`, `today` and
`timeZone` are always parameters. User input returns `Result<T, CoreIssue[]>`; programmer error
throws.

**Consequences.** A CI grep over `packages/core/src` fails the build on `Date.now(`, argument-less
`new Date()`, and the literal `now()` appearing in any emitted SQL. The dependency assertion
(`imports nothing outside zod and libphonenumber-js`) is scoped to `src/`, so a dev-only
property-testing library is still allowed.

### ADR-035 — Dependency budget: `zod` and `libphonenumber-js/min` only

**Context.** Dates, slugs, recurrence, similarity and public-suffix handling all have libraries.

**Options.** (1) Reach for the obvious libraries — `rrule`, a date library, a public-suffix list, a trigram package. (2) `zod` and `libphonenumber-js` only, hand-writing the rest. (3) No runtime dependencies at all, phone parsing included.

**Choice.** `zod@4.5.4` and `libphonenumber-js@1.13.12` (the `/min` metadata build) are the only
runtime dependencies. Civil-date arithmetic, slug generation, the five-variant recurrence rule and
domain-host canonicalisation are hand-written; `rrule` for a six-item dropdown and a public-suffix
list with an expiry date are both worse than 60 lines each.

**Consequences.** Two changes from the proposal. **`/min`, not `/max`**: the 74 kB of extra metadata
existed to split mobile from landline for a duplicate confidence (0.93 vs 0.80), but `getType()`
returns `FIXED_LINE_OR_MOBILE` for US numbers and every other merged numbering plan, so the
distinction is a no-op where it matters most; if a written test ever shows the German split changing a
merge outcome, `/max` is a one-line swap. **Phone normalisation is injected**: `types/phone.ts` takes
`ctx.normalizePhone`, supplied by the API and the importer from a `@mutuals/core/phone` subpath and
left `undefined` in the browser, where `coerce` degrades to shape validation. Without this the
registry barrel drags the metadata into the web bundle, and the proposed bundle-size assertion would
have failed. **Trigram similarity is not in core at all** (ADR-019).

### ADR-036 — Attribute types are a data-driven registry; one file knows column names

**Context.** CLAUDE.md's rule: attribute definitions drive everything, never hard-code a column.

**Options.** (1) A hard-coded `AttributeType` union with a `switch` per concern. (2) A data-driven registry with `AttributeType` derived from it. (3) A class hierarchy, one class per type.

**Choice.** `DEFINITIONS` is an array of type definitions; `AttributeType` is **derived** from it, so
adding a type is one file plus one registry entry and the compiler finds every switch that is now
non-exhaustive. `attributes/slots.ts` is the only file containing physical column names, enforced by
the grep test in ADR-033.

**Consequences.** The generic parameters on `AttributeTypeDefinition<TConfig, TInput>` are **dropped**.
They are contravariant in `TConfig`, so the heterogeneous registry could only be built with `as never`
and every call site got `unknown` back anyway — the generics bought no type safety at the one place
they were used. The interface is non-generic with `config: unknown`, narrowed by `configSchema.parse`
inside each method, and a mapped-type accessor `typeDef<T extends AttributeType>(t: T)` gives call
sites the precise type without a cast.

### ADR-037 — The `AttributeDefinition` contract, written down once

**Context.** Five surfaces iterate this array — the Columns picker, the filter picker, the create
dialog, the detail sidebar and CSV export — and the proposals read `def.key`, `def.type`,
`def.value_kind`, `def.required`, `def.options`, `def.isMulti`, `def.sortable`, `def.showByDefault`,
`def.position`, `def.uiWidth`, `def.isPrimaryLabel` across three documents with two different names
for the discriminator.

**Options.** (1) Let each surface read the fields it needs and leave the shape implicit. (2) One written type in `packages/core`, with `type` as the single discriminator. (3) Two types — one for the database row, one for the API.

**Choice.** One type in `packages/core`, and **`type` is the discriminator**. `value_kind` is derived
from `type` and exists only on the database row (where the composite FK needs it).

```ts
type AttributeDefinition = {
  id: string
  objectType: 'contact' | 'organization' | 'interaction'
  title: string
  slug: string
  type: AttributeType
  config: AttributeConfig // per-type, narrowed by configSchema
  options?: AttributeOption[] // present iff type is single_select | multi_select
  group?: string
  description?: string
  isSystem: boolean
  isMulti: boolean
  isDerived: boolean
  sortable: boolean // derived from type; API 400s on a sort request otherwise
  position: number
  showByDefault: boolean
  createdAt: string
  updatedAt: string
}
```

**Consequences.** `required` is **not** a field — §4.2 defines no such concept; required-ness in
Phase 1 belongs to system fields only, and the create dialog marks those. Derived columns
(`last_interaction_at`, `interaction_count_12m`, `open_followups`, `warmth`, `people_count`) are
declared here as pseudo-definitions with `isDerived: true` and their own operator sets, so they appear
in the Columns and filter pickers like any other attribute and the compiler resolves them through one
of three resolvers (system column | metric column | attribute) behind one interface.

### ADR-038 — A select attribute must have at least one option

**Context.** §6.7's Create attribute dialog lets a user choose `single_select` and press Save; the
option editor lives in the same dialog. The runtime form builder derives the field schema as
`z.enum(def.options.map(o => o.key))`. **Verified in this session against `zod@4.5.4`:** `z.enum([])`
constructs without complaint and then rejects every value with `code: 'invalid_value'` and the message
`Invalid option: expected one of ` — a field nobody can fill, reporting an error that names nothing.
It is reachable on day one, by the normal path of creating an attribute before typing its options.

**Options.** (1) Require at least one option at creation time. (2) Allow zero options and special-case
the builder (`z.never()` with a real message) plus an "add an option first" cell and input state.
(3) Leave it.

**Choice.** Option 1. `createAttributeDefinition` and `updateAttributeDefinition` return 400 when
`type` is `single_select` or `multi_select` and the option list is empty, and §6.7's live validation
renders "Add at least one option" in exactly the style of "Title is required". Removing the last
option of an existing select is refused for the same reason; the clear-or-remap flow of ADR-016
already covers what happens to the values.

**Consequences.** The impossible state is removed instead of handled, so the form builder, the cell
registry and the editor registry need no empty-option branch and the filter picker never offers an
operator with an empty value list. `tags` is deliberately **not** covered: it has no option list at
all, and inline creation of new values is its entire purpose (§4.2). The import wizard's
`Create option` step is unaffected — it adds options to an attribute that already has one.

### ADR-039 — Canonical value forms: decimal strings and civil-date strings

**Context.** JS `number` loses precision on money-shaped values; JS `Date` is a timestamp pretending
to be a day.

**Options.** (1) JS `number` and JS `Date`. (2) Branded decimal strings and branded `‘YYYY-MM-DD’` strings. (3) A decimal library plus Temporal.

**Choice.** Numbers are branded decimal strings; dates are branded `'YYYY-MM-DD'` strings. Round-trip
is exact.

**Consequences.** **`decimals` has no default.** The proposal set
`decimals: z.int().min(0).max(10).default(0)` and rounded on write, so a number attribute created
without touching that field silently turned `250000.50` into `250001` in the append-only fact log —
unrecoverable. §4.2 calls decimals optional; `undefined` now means "store exactly what was typed and
format at full precision", and rounding, when a precision is explicitly set, is a **display**
operation. A test asserts `'250000.50'` survives normalise → DB → read byte-identically.
`parseDecimalLoose`'s disambiguation rules (`1.234,56` de vs `1,234.56` en vs `1 234,56`, rejecting
`€1.2k`) are written out as a numbered algorithm in `docs/ARCHITECTURE.md` before implementation.

### ADR-040 — Relative date filters are stored relative and resolved in TypeScript

**Context.** A saved view named "No interaction in 90 days" must not freeze to an absolute date.

**Options.** (1) Resolve to absolute dates when the view is saved. (2) Store relative and resolve in SQL against the database clock. (3) Store relative and resolve in TypeScript from `ctx.today`.

**Choice.** The filter model stores `{op:'in_last', n:30, unit:'day'}` and `{op:'older_than', n:90,
unit:'day'}`. **All** relative operators — including `older_than`/`newer_than` — are resolved to
absolute bounds in `packages/core` from `ctx.today` and `ctx.timeZone`, and the **cutoff** is bound as
a parameter.

**Consequences.** `now()` never appears in emitted SQL, so the clock-free rule holds end to end and
the named regression test ("a view parsed with a `today` 400 days later resolves `older_than:90` to a
different bound") can actually pass — under the proposal it could not, because `older_than` compiled
to the database's clock and the emitted SQL was byte-identical for any injected `today`. It also
removes a real bug: one `WHERE` clause could otherwise contain two clocks, so "last 90 days" and "no
interaction in 90 days" would flip at different moments. Binding the cutoff rather than the day count
also removes the untyped `$n * interval '1 day'` cast a golden test would have frozen.
Phase 1 ships the presets the brief names (`last 30 days`, `this year`) plus `older_than`/`newer_than`;
the forward-facing follow-up shortcuts (`in 1 week / 1 month / 3 months`) arrive in Stage 4 with the
follow-ups table, where they are creation and snooze affordances rather than filter presets.

### ADR-041 — Slugs: two tiers of reserved words, not three

**Context.** §4.2 requires slug validation against a reserved list.

**Options.** (1) Three tiers: system names, ~90 SQL keywords, hazard names. (2) Two tiers.

**Choice.** Two. **Tier 1** is _derived_ from `SYSTEM_FIELDS` plus the derived-field registry, so it
can never drift from the code. **Tier 2** is the genuine JS/JSON hazards only: `__proto__`,
`constructor`, `prototype`.

**Consequences.** The ~90 Postgres keywords are **dropped**: attribute slugs never reach SQL as
identifiers (the compiler resolves slug → definition row and 400s on an unknown slug before any SQL is
built), the column-promotion path that motivated them would quote identifiers anyway, and reserving
`is`, `left`, `right`, `full`, `natural`, `order`, `user` is user-hostile for zero present benefit.
The query-string parameter names (`filter`, `sort`, `limit`, `cursor`, `q`, `fields`) are **also
dropped** from the reserved list — under ADR-032 slugs live inside the `filter` value and never become
parameter names. **`type` is removed from the hazard list**: §4.1 seeds `type` as a default custom
attribute on Organization, so the proposed list would have failed the seed script on first run.
Attribute values travel in a nested `{ id, displayName, attributes: { [slug]: … } }` payload, so a
slug can never reach `Object.assign` on a top-level request body — that, not a long list, is why
tier 2 is three entries.

### ADR-042 — Duplicate matching: identifiers first, and one certainty gate

**Context.** §4.6: two rows sharing any identifier are the same entity with near-certainty; name +
organization similarity is the fallback, never the first check. §4.8: the LLM extracts, code decides.

**Options.** (1) Name similarity first, identifiers as confirmation. (2) Identifiers first with per-kind confidences, names strictly as the fallback. (3) Ask the model.

**Choice.** Per-kind identifier confidences, combined **noisy-or across distinct kinds only** and
**max within a kind**, then an ordered rule table for the name fallback. Bands: `certain ≥ 0.95`,
`probable ≥ 0.80`, `possible ≥ 0.60`.

**Consequences — one gate added.** `certain` additionally requires **at least one single identifier
scoring ≥ 0.95**; otherwise the combined score is capped at 0.94. Without it, two colleagues sharing a
switchboard and a shared office line (0.80 each, the value chosen precisely because "households and
switchboards share them") combine noisy-or to 0.96 and are auto-classified as certainly the same
person — and in the import flow `certain` is the band that gets a bulk Skip/Merge. Noisy-or assumes
independent evidence; two numbers on one PBX are the least independent evidence in the dataset. A
named test asserts that case lands in `probable`. `emailMatchKey` (gmail dots, plus-tags) is a
**duplicate signal only, never a stored identifier** — folding it into the unique `identifier.value`
would permanently prevent storing two deliberately distinct addresses. Website identity is host-based
with **no public-suffix list**; `new URL('http://' + domain).hostname` is inside the `Result` wrapper
because it throws on malformed input, with tests for a space, `a..b` and a trailing dot. A website
scores 0.00 as identity for a _contact_ (colleagues share one). Candidate generation and scoring are
SQL (ADR-019); the importer **batches** identifier probes — one probe per identifier per row is 20k+
round trips on a 10k LinkedIn export.

### ADR-043 — Recurrence: a closed five-variant union, anchored on the series

**Context.** §4.1: marking a recurring follow-up Done creates the next occurrence.

**Options.** (1) The `rrule` package. (2) A closed union of the five shapes §6.4's dropdown offers. (3) A cron expression per follow-up.

**Choice.** `none | weekly | monthly | every_n_months | every_n_days | yearly` as a closed union
(five recurring variants). The next occurrence is computed **from the due date**, rolled forward past
today, with month arithmetic anchored on the **series' first due date**.

**Consequences.** The anchor is the non-obvious half and it is right: 31 Jan → 28 Feb → **31 Mar**,
not a permanent demotion to the 28th. `{kind:'rrule'}` is an additive sixth variant if a real RRULE is
ever needed. **`occurrencesBetween` is dropped** — nothing in Phase 1 enumerates future occurrences.

### ADR-044 — Import auto-mapping is deterministic; the LLM is not used

**Context.** §6.8 requires auto-mapping and idempotent re-import. §4.8: the LLM extracts, code decides.

**Options.** (1) The LLM maps columns to attributes. (2) A deterministic cascade of header-matching rules. (3) No auto-mapping — the user maps every column by hand.

**Choice.** A seven-step cascade — exact header match, normalised match (underscores treated as spaces
in a pre-step, since `normalizeText` does not touch them), preset knowledge, synonym table, prefix
match, trigram ≥ 0.72, nothing — with **one target per column**. Only steps 1–5 auto-confirm; fuzzy
matches are proposed, never confirmed. Fuzzy confidence is linear from `0.72 → 0.60` up to
`1.00 → 0.85`, stated so the auto-confirm boundary is reproducible.

**Consequences.** A non-reproducible mapping would break §6.8's idempotency requirement outright, so
this follows from the brief rather than from taste. One-target-one-column prevents a real silent
data-loss bug (Google's `E-mail 1 - Value` and `E-mail 2 - Value` both mapping to `email`). The
LinkedIn preamble rows and its non-ISO `Connected On` format are encoded in the preset. Date formats
are inferred **per column over all samples** — not the first — and the result is
`{format, ambiguous, conflicting}`, so the wizard can render three different states; mixed data is an
error, not a guess; the default when ambiguous is `dmy` for two German users, reversible in one click.
A single-sample column is always reported ambiguous.

### ADR-045 — `profile.phone_region` and `profile.time_zone`

**Context.** `'089 1234567'` cannot be normalised without a region (verified: throws
`INVALID_COUNTRY` with no region, yields `+49891234567` with `DE`). Warmth decays on whole civil days
"in the profile timezone", and `in_relative` compares `timestamptz` columns against civil bounds.

**Options.** (1) Infer both from the Profile's `language` field. (2) Infer from the browser locale. (3) Two explicit Profile fields with sensible defaults.

**Choice.** Add both to Profile: `phone_region text NOT NULL DEFAULT 'DE'` and `time_zone text NOT
NULL DEFAULT 'Europe/Berlin'` (the latter is already in the storage DDL). Threaded through as
`ctx.phoneRegion` and `ctx.timeZone`.

**Consequences.** Inferring the region from `language` is genuinely wrong (an English-speaking user in
Germany) and the browser locale is unavailable to the importer and the server. Without `time_zone`,
the nightly warmth job's output would silently depend on the server's `TZ` environment variable — the
ambient-clock failure the whole package exists to avoid, moved one layer down. A test asserts the same
interaction set produces the same warmth under `TZ=UTC` and `TZ=Pacific/Auckland`. `docs/BRIEF.md`
§6.6 is updated in the same PR, per §2.1.

---

## 6. Frontend

### ADR-046 — Vite 8.2.2 SPA, not Next.js

**Context.** §3.1 fixes React + Tailwind + shadcn/ui and §3.1/§7 fix API-first: the web app talks to
the backend only through the public API.

**Options.** (1) Vite 8 SPA. (2) Next.js App Router. (3) Remix/React Router framework mode.

**Choice.** Vite 8.2.2 (Rolldown) + `@vitejs/plugin-react@6.1.1` + `@tailwindcss/vite@4.3.3`.
Next.js would put a second server in front of the API, and its server components would either bypass
the public API (breaking the one rule the brief states twice) or proxy it for nothing.

**Consequences.** Two claims from the proposal are corrected so they do not reach `docs/DECISIONS.md`:
`oxc-transform-react` is **not** the default transform path — it is the Rust React Compiler, pulled in
only by the plugin's `compiler` option, so the accurate statement is "no extra transform dependency is
needed at all". And "enabling the React Compiler would drag Babel into a Rust pipeline" is already
moot, because `@tanstack/router-plugin@1.168.35` declares `@babel/core`, `@babel/types` and
`@babel/template` as hard dependencies. The React Compiler is still skipped, on the honest ground
that there is no measured win at ~30 virtualised rows. **`autoCodeSplitting` is off** in Phase 1: for
a single-user app on one laptop, route-level chunking buys nothing measurable.

### ADR-047 — TanStack Router 1.170.32 for typed search params

**Context.** §5.2 requires filters, columns and sort to live in the URL so views are shareable, and
§6.6 requires saved views on top of that.

**Options.** (1) TanStack Router. (2) React Router 7. (3) Hand-rolled `useSearchParams`.

**Choice.** TanStack Router. `validateSearch` takes a Standard Schema validator, which Zod 4.5.4
satisfies; `search.middlewares` with `retainSearchParams`/`stripSearchParams` keeps `view` and
`columns` across navigations. This is decided by search params, not by routing.

**Consequences.** One correction: `@tanstack/router-plugin@1.168.35`'s peer range is
`>=5.0.0 || >=6.0.0 || >=7.0.0 || >=8.0.0` with `vite` **optional**, not `vite >=8.0.0` as claimed.
The plugin's real Babel dependency footprint is recorded in `ARCHITECTURE.md` so nobody is surprised
that a "Rust pipeline" still runs Babel on route files.

### ADR-048 — Saved views: the URL is the working copy, the view is a named snapshot

**Context.** §5.2 puts filters, sort and columns in the URL so a view is shareable; §6.6 adds saved
views with `Save changes to view`, `Save as new view` and `Revert changes`, and the view name in the
breadcrumb. Nothing in any proposal said which of the two is authoritative, how "changed" is computed
for the `⋮` menu, or what a link carrying both `?view=` and explicit filters should do. Three surfaces
(the table, the breadcrumb, Settings → Table views) read this and would each have guessed.

**Options.** (1) The stored view is authoritative and the URL mirrors it. (2) The URL is authoritative
and a view is a named snapshot loaded into it. (3) Two-way binding with automatic persistence.

**Choice.** Option 2. Opening a view writes its snapshot into the URL and sets `?view=<id>`; every
edit after that touches the URL only. **Dirty** = the normalised `(filters, sort, columns)` triple in
the URL differs from the stored snapshot by deep equality over a canonical ordering (the same
canonicalisation `serializeListQuery` already applies, so there is one definition). `Revert changes`
rewrites the URL from the snapshot; `Save changes to view` writes the URL state into the row;
`Save as new view` inserts a row. A link carrying `view` **and** explicit parameters is honoured as
"that view, with these changes": the explicit parameters win and the view opens dirty — which is
precisely what makes sharing a tweaked view work.

**Consequences.** Option 3 is rejected because auto-persistence would let an idle click mutate a saved
view, and §5.2 offers `Revert changes` specifically so that cannot happen. No client store is
introduced: ADR-049's four state homes stand, and `view` is one more URL parameter kept across
navigations by `retainSearchParams(['view'])`. `saved_view.is_default` decides what the bare
`/contacts` route loads, and `sv_default_uq` already enforces one default per object type. Views are a
Stage-4 feature, but this decision is recorded now because Stage 2 builds the URL contract it depends
on.

### ADR-049 — TanStack Query 5.102.8, no client store, and a corrected optimistic-edit protocol

**Context.** §5.2 requires inline cell editing with optimistic update and an error toast on failure,
over a virtualised table whose cell components unmount on scroll.

**Options.** (1) TanStack Query alone. (2) Query + Zustand/Jotai. (3) SWR. (4) React 19 `useOptimistic`.

**Choice.** Option 1. Four state homes assigned by rule: URL (filters, sort, columns, view), server
cache (everything fetched), component state (open dialogs, focus), and nothing else. `useOptimistic`
is rejected because it is scoped to a component that unmounts when the row scrolls out of view.

**Consequences — three defects in the proposed protocol, fixed.**

1. **The rollback restored only half the cache.** `onMutate` patched both the list caches and
   `qk.record(id)`, but the snapshot captured only `getQueriesData(['records', objectType])`, so after
   a failure the detail sidebar kept the failed value while the table showed the correct one — exactly
   the divergence the design set out to avoid. Both cache families are now snapshotted and restored.
2. **`scope: undefined` did the opposite of its comment.** `MutationScope` is `{ id: string }` and is
   static per `useMutation` instance, so it cannot be derived from variables and a single shared hook
   cannot serialise per cell at all; two fast edits could commit out of order and the older
   `onSuccess` could write a stale server value back. The serialisation claim is withdrawn. Instead a
   module-level in-flight map keyed by `` `${recordId}:${slug}` `` holds a monotonically increasing
   sequence number, and `onSuccess` is a **no-op when a newer write for the same cell is in flight**.
   Simple, testable, and honest about what it guarantees.
3. The Retry toast calls `.mutate` on the returned mutation object; the proposal called a `mutate`
   that was not in scope inside the options object.

Client-only row state (the 1px "saving" pulse) lives in a **side map keyed by row id**, not on the
row, because response parsing strips unknown keys.

### ADR-050 — shadcn/ui components live in `apps/web/src/components/ui`

**Context.** §3.1 fixes shadcn/ui and its data-table pattern. shadcn components are copied into the
repository and may be adapted.

**Options.** (1) `packages/ui` with shadcn's monorepo layout. (2) `apps/web/src/components/ui`.

**Choice.** Option 2. One `components.json` in `apps/web`, `shadcn add` run from there, Tailwind 4 via
`@tailwindcss/vite`, no `tailwind.config.js`.

**Reasoning.** There is exactly one frontend, so `--monorepo` buys a cross-workspace alias dance for
zero benefit — and the proposed wiring did not work. Tailwind v4's automatic source detection is
relative to the **current working directory**: `pnpm dev` runs from `apps/web`, so `apps/web/src` is
already scanned (making the proposed `@source "../../../../apps/web/src"` redundant) while
`packages/ui/src`, containing every primitive, is outside the cwd and would **not** be scanned. The
component library would have rendered unstyled. Three "verified" claims in that proposal were also
wrong and are corrected here: the CLI's `--base` values are `base | radix | aria` (not
`radix | base-ui`); `--css-variables` is still a documented `init` flag; and "for v4 the tailwind
config block is left empty" applies to the `config` **key**, not the block.

**Consequences.** Radix 1.6.7 (stable) over Base UI 1.0.0-rc.0 — the "prefer boring" call.
Promoting `packages/ui` later is a directory move plus one `components.json`.

### ADR-051 — DataTable: TanStack Table 9.2.4, server-driven, no row models

**Context.** §3.1 fixes shadcn's TanStack-Table data-table pattern. shadcn's current data-table docs
are written against v9, so pinning v8 would diverge from the mandated pattern.

**Options.** (1) v9 with server-driven state. (2) v8. (3) A hand-rolled table.

**Choice.** v9.2.4. Features registered: `columnVisibilityFeature`, `columnOrderingFeature`,
`columnPinningFeature`, `rowSelectionFeature`, `rowSortingFeature`. **No row models** — filtering,
sorting, pagination and counting all happen in Postgres (ADR-013, ADR-032).

**Consequences — two fixes.**

1. **`manualFiltering` and `manualPagination` are deleted from the options literal.** v9 gates option
   types by feature: `manualFiltering` lives on `TableOptions_ColumnFiltering` and `manualPagination`
   on `TableOptions_RowPagination`, neither of which is registered, so they are excess properties and
   will not compile. `manualSorting: true` is valid and sufficient.
2. `onColumnVisibilityChange` and `onColumnOrderChange` are added and write to the URL's `columns`
   parameter; without them those controlled slices are frozen and the §5.2 Columns picker cannot
   write.

**Column sizing and resizing are cut from Phase 1.** §5.2 asks for visibility toggling, drag reorder
and single-column sort. Resizing adds a fourth state home the state table does not cover plus a
persistence path through the saved-view API that nothing else needs. `size` on the `ColumnDef` gives
sensible default widths. Re-add in Stage 7 if anyone asks.

### ADR-052 — One column factory from `AttributeDefinition[]`, two registries

**Context.** CLAUDE.md's rule and §5.2's requirement that user-defined attributes appear as columns
with type-correct rendering and inline editors.

**Options.** (1) A factory in the web app over the definitions the API returns. (2) Hand-written
column definitions per object type. (3) The API returns column descriptors.

**Choice.** Option 1. `useRecordColumns(defs)` builds `ColumnDef[]`; a **cell registry** maps
`AttributeType → renderer` and an **editor registry** maps `AttributeType → inline editor`. Option 3
is rejected because the API also serves MCP and a CLI, which have no columns.

**Consequences.** Per-column metadata uses **v9's `columnMeta` type slot** on the features object
(`tableFeatures({ …, columnMeta: {} as RecordColumnMeta })`), not global `declare module`
augmentation into `@tanstack/react-table`. The augmentation target was ambiguous anyway (`ColumnMeta`
is declared in `table-core` and re-exported), and the slot is scoped to this table instead of
poisoning every table in the repo — the Attributes list and the import Review grid have different meta
needs. `RecordColumnMeta` is defined explicitly. `accessorFn`, never `accessorKey`, because slugs may
contain characters TanStack treats as a deep path.

### ADR-053 — Virtualisation: infinite cursor pages, fixed 40px rows, a real `<table>`

**Context.** §5.2: virtualised rows, smooth at 10k. ADR-023 fixes an opaque cursor, which rules out
"fetch a page by index".

**Options.** (1) `useInfiniteQuery` + `@tanstack/react-virtual`, fixed row height. (2) Dynamic row
measurement. (3) Windowed page fetching by index.

**Choice.** Option 1. Fixed 40px rows delete `measureElement` and its whole failure mode.

**Consequences — the accessibility contradiction is resolved.** The proposal justified a real
`<table>` over a div grid on "semantics, screen-reader behaviour and the shadcn diff upgrade path",
then set `display: flex` on every `<tr>` and `<td>` — which removes their table roles from the
accessibility tree, so the argument did not survive its own implementation. **`display: flex` is
dropped**; rows are absolutely positioned with `transform: translateY()`, cells are sized by
`table-fixed` plus explicit `width`, and the native roles survive. The fetch-more trigger moves out of
a `useEffect` (whose inline-arrow dependency made it run on every render) into the virtualizer's
`onChange`, so ADR-049's "no `useEffect` in the data path" is true. Loading skeletons, an empty state
with a call to action, and an error state live in this component; they are §5.2 requirements and were
missing from every proposal.

**Row selection across pages:** selection is a set of ids; "select all" selects **the loaded rows**
and offers "select all 2,236 matching" as a second, explicit action that sends the **filter** rather
than an id list. Bulk operations therefore accept either `{ ids: string[] }` or `{ filter: FilterSet }`
— decided here because it changes the API shape (ADR-031).

### ADR-054 — The import file is parsed server-side

**Context.** §7: every UI operation is a single well-named API operation. §6.8: 10k rows, duplicate
detection against existing records, select-option validation, "% of rows have a value".

**Options.** (1) Parse in the browser and POST rows. (2) Upload the file and parse on the server.

**Choice.** Option 2. Three of the wizard's inputs only the server has: the identifier-index duplicate
probe, select-option validation, and whole-file statistics. Parsing in the browser would also
duplicate the parser for the future CLI and MCP paths.

**Consequences.** The **64 KB client-side preview is dropped** — it is a second, partial parser whose
only job is to make step 1 feel fast in a flow whose very next action is an upload, and it was
simultaneously described as "presentation only" and credited with delimiter detection. The server
detects the delimiter and returns the first rows in the `POST` response. The named operations for
Review-grid step 4 (`revertImportRow`, `replaceInImportBatch`, `exportImportBatch`) are added in
ADR-031 — with rows staged server-side, undo/redo and find-and-replace are no longer free client
state, and §6.8 requires all three.

### ADR-055 — Feature-first structure with three promoted shared modules

**Context.** Route files should be thin composition roots; features should be testable without a
router.

**Options.** (1) Type-first (`components/`, `hooks/`, `pages/`). (2) Feature-first with a lint rule
banning sibling-feature imports. (3) Feature-first with no rule.

**Choice.** Option 2, **with the genuinely shared surfaces promoted out of `features/`**:

```
apps/web/src/
  routes/        thin composition roots (TanStack Router file routes)
  ui/            shadcn primitives (ADR-050)
  table/         TableShell, RecordTable, useRecordColumns, FilterBar, ColumnsMenu
  attributes/    AttributeCell, AttributeInput, the two registries
  features/      dashboard/ records/ organizations/ interactions/ follow-ups/
                 attributes-settings/ views/ import/ search/
  lib/  hooks/
```

ESLint zone: _a `features/*` folder may import `ui`, `table`, `attributes`, `lib`, `hooks` and
`@mutuals/core` — never a sibling feature._

**Reasoning.** The proposed rule ("cross-feature composition happens in `routes/`") would have failed
on day one of Stage 3: `features/import/` must render `RecordTable` for the Review grid,
`features/follow-ups/` and `features/interactions/` render it for their lists, and
`features/records/` renders `AttributeInput` in the detail sidebar. Those are compositions _inside_
features; a route file cannot inject a table into the middle of a wizard step and stay thin. An
unenforceable rule gets an `eslint-disable`, which is worse than no rule.

**Consequences.** The three promoted directories are not a new package — they are folders in `apps/web/src`, so promoting them to `packages/ui` later is a directory move plus a `package.json`. The lint zone is true as written on day one, which is the only property that matters: a rule that fails on the first real composition gets an `eslint-disable`, and a disabled rule protects nothing.

### ADR-056 — Design tokens: shadcn semantic names, Mutuals values, option colours as tokens

**Context.** §5.1 fixes neutral greys, one accent, thin borders, 13–14px base font, small coloured
chips.

**Options.** (1) Invent Mutuals token names. (2) Keep shadcn’s semantic token names and give them Mutuals values. (3) Store a hex string per select option.

**Choice.** Keep shadcn's semantic token **names** (`--background`, `--foreground`, `--muted`,
`--border`, `--primary`, …) so a future `shadcn add` lands correct, and give them Mutuals values.
Type scale 13/14px with the root at 16px, so Tailwind's rem-based spacing keeps its meaning.
`attribute_option.color` stores a **token name** from a closed 11-value enum, never a hex string.

**Consequences.** The chip implementation is **changed**: the proposed `@utility chip-*` is not valid
Tailwind v4 (a functional utility must resolve its wildcard through `--value(--namespace-*)`, and the
chip tokens were declared in `:root` rather than `@theme`, so there was no namespace to resolve), and
``className={`chip-${color}`}`` is a constructed class name that Tailwind's source scanner cannot
see, so chips would have rendered unstyled twice over. Instead a literal lookup keeps every class name
scannable:

```ts
const CHIP: Record<ChipColor, string> = {
  red: 'bg-[var(--chip-red-bg)] text-[var(--chip-red-fg)]' /* …10 more… */,
}
```

Same tokens, same contrast. The 22 light/dark token pairs were checked by converting oklch to sRGB and
computing WCAG contrast: light 6.06:1–8.20:1, dark 7.55:1–8.62:1 — comfortably past 4.5:1. Dark-mode
tokens **ship** (they are a cheap extension point) but there is **no toggle, no dark screenshots and
no automated 22-pair contrast test** in Phase 1; §5.1 never asks for dark mode. See open question Q5.

---

## 7. Background jobs and the LLM module

### ADR-057 — Stage 1 gets a `JobQueue` port and an inline adapter, not a queue

**Context.** §9 asks for "a `jobs` package/folder with a scheduler stub". Stage 1 has exactly one
piece of asynchronous work: the nightly warmth sweep, which is invoked from a CLI.

**Options.** (1) Install pg-boss in Stage 1. (2) A port plus an inline adapter now; pg-boss with the
importer in Stage 5.

**Choice.** Option 2. `apps/api/src/jobs/` ships the port (`enqueue`, `work`, `schedule`), the
`InlineQueue` adapter, one typed registry entry (`metrics.warmth-sweep`), `SCHEDULES`, and
`pnpm jobs:run`.

**Consequences.** Every Stage-1 integration fixture would otherwise pay `boss.start()`, a schema
install and a timer-driven background process for one handler. **The port contract is explicit:
`enqueue(name, payload, { tx })` must run the handler _after_ the caller's transaction commits** —
`InlineQueue` keeps an after-commit callback list, never running inline inside the open transaction.
Without this the two adapters have different observable semantics and ADR-058's "swap one file"
promise is false: an inline handler would read pre-transaction state or block on the same
transaction's row locks. A **port-conformance suite runs against both adapters**, so the Stage-5 swap
is proven rather than asserted. The port is three methods: `debounceSeconds`, `key`, an 8 KB payload
cap, `JobContext.signal` and a re-entrant `JobContext.queue` are all dropped — one handler needs none
of them. The **`search.reindex-record` queue and handler are deleted**: `project_record()` already
maintains `search_document` synchronously inside the write transaction, so the job re-did work that
had just committed.

### ADR-058 — pg-boss 12.29.0 arrives in Stage 5 with the importer

**Context.** §3.2 prefers a Postgres-backed queue over extra infrastructure.

**Options.** (1) pg-boss 12.29.0. (2) BullMQ (needs Redis). (3) Hand-rolled `SELECT … FOR UPDATE SKIP
LOCKED`.

**Choice.** pg-boss. MIT, `engines.node >=22.12.0`, dependencies only `pg`, `cron-parser`,
`serialize-error`. `send()` accepts a `db` option, so transactional enqueue is real rather than
aspirational. BullMQ is out on the brief's own terms (no Docker, no cloud dependency).

**Consequences.** pg-boss is maintained by one person; the port is the mitigation and
`DROP SCHEMA pgboss CASCADE` is a complete uninstall. Graphile Worker is named in `ARCHITECTURE.md`
as the substitute. One Stage-5 acceptance test runs the full lifecycle against a **Supabase
transaction-pooler** connection string, not just local Postgres — the pooler-safety claim was inferred
from `pg_advisory_xact_lock()` being transaction-scoped and has never been measured.

### ADR-059 — pg-boss gets its own small pool, polling only

**Context.** The app's pool carries raised planner GUCs (ADR-013) that jobs should not inherit, and
pg-boss's own documentation states its LISTEN/NOTIFY listener does not work through PgBouncer in
transaction or statement pooling mode.

**Options.** (1) Share the application's pool. (2) A separate small pool, polling only. (3) A separate pool using LISTEN/NOTIFY.

**Choice.** A separate `pg` pool with `max: 5`, `useListenNotify: false`, 2-second polling.
`supervise` and `schedule` are tied to `MUTUALS_WORKER`: when it is `off`, the API constructs the
queue with `supervise: false, schedule: false` so it can enqueue but owns neither maintenance nor
cron.

**Consequences.** `max: 5` rather than the proposed `max: 2`, whose justification assumed a single
worker while the registry declares six queues. Five independent pollers plus the supervisor's
maintenance transactions plus the 30-second cron monitor sharing two connections does not deadlock,
but everything serialises invisibly and surfaces as "the import seems slow". A comment ties the number
to the count of registered queues so it is revisited when a queue is added. The 2-second polling
latency is visible in the import UI; the wizard renders a "queued" state, and that is a Stage-5
acceptance criterion rather than a bug to discover later.

### ADR-060 — Declarative `SCHEDULES`, reconciled on boot, with a scalar freshness probe

**Context.** Cron only fires while the process runs; a laptop-hosted app is off overnight.

**Options.** (1) Create schedules imperatively on first boot and never reconcile. (2) A declarative array reconciled on every boot, including unscheduling orphans. (3) An operating-system cron entry.

**Choice.** `SCHEDULES` is a const array; on boot the runner diffs it against `getSchedules()`,
creating what is missing and **unscheduling orphans**. A boot catch-up runs the sweep if it is stale.

**Consequences.** The freshness probe is **a scalar `workspace.metrics_swept_at`**, written by the
sweep as its last statement — not `min(contact_metrics.computed_at)`. With ADR-022's whole-workspace
write-back the old probe would work, but deriving freshness from a data table couples two things that
should not be coupled; the scalar is one column, one read, and cannot drift from the write-back set.
(Under the _proposed_ sweep, which only aggregated interactions inside 365 days, the probe would have
fired a full sweep on every boot forever.)

### ADR-061 — The import job: one job per batch, chunked commits, no automatic retry, no dead-letter

**Context.** §6.8: 10k rows, a progress bar, resume, and a downloadable error report.

**Options.** (1) One pg-boss job per row, composed with `flow()`. (2) One job per batch, committing in chunks. (3) Import synchronously inside the HTTP request.

**Choice.** One `import.run` job per batch, `retryLimit: 0`, `expireInSeconds: 900`,
`heartbeatSeconds: 60`, committing in chunks and advancing `import_batch.last_committed_row`.

**Consequences.** **The `import.failed` dead-letter queue is deleted.** Nothing registered a worker
for it, so copies would land in `created` and be read by nothing, ever — the exact orphaned-queue
failure ADR-060 warns about — and `deleteAfterSeconds: 0` means _never delete_, not delete
immediately. Instead the handler's `catch` writes `import_batch.status = 'failed'` plus the error
detail and `last_committed_row` in its own committed transaction. That row is already the state
machine the wizard polls and the Resume button reads, and it is the only place a user-visible failure
can surface. **Resume semantics are decided, not deferred:** resuming re-runs from
`last_committed_row + 1` and **re-evaluates duplicate decisions for the remaining rows only**; rows
already applied are not revisited, and the result screen states how many rows were applied before the
failure.

### ADR-062 — The worker runs in-process inside `apps/api` by default

**Context.** §12: one command, on a laptop, no process manager.

**Options.** (1) In-process by default, with a standalone entry point that exists. (2) Always a separate worker process. (3) In-process only, with no scale-out path.

**Choice.** In-process by default. A 15-line `apps/worker/src/main.ts` exists so the scale-out path is
config-only (`MUTUALS_WORKER=off` on the API).

**Consequences.** `apps/worker` is created in Stage 5 alongside pg-boss, not now.

### ADR-063 — Job tests use pg-boss's built-in spies, never sleeps

**Context.** Queue tests that sleep are slow and flaky, and a scheduled job cannot be tested by waiting for its cron time to come round.

**Options.** (1) Sleeps and polling. (2) pg-boss’s built-in test spies. (3) Never test the queue, only the handler functions.

**Choice.** `__test__enableSpies: true`, `getSpy(name)`, `waitForJob(selector, state)` —
documented as resolving immediately if a matching job was already processed, so there is no race.
`syncSchedules()` is tested by asserting `getSchedules()`, not by waiting for 03:30.

**Consequences.** The `__test__` prefix is a stability risk, so a single smoke test calls `getSpy()`
and asserts it does not throw; a pg-boss minor that drops or renames the API then fails as one
obvious test rather than a dozen timeouts. The version is pinned exactly.

### ADR-064 — The LLM module: a task-shaped client over an OpenAI-compatible provider port

**Context.** §3.1: everything through OpenRouter, one setting per task, models swappable **without a
deploy**, provider behind an interface. §4.8: the LLM extracts, code decides.

**Options.** (1) Two layers — a task client (`extract`, `ask`, `summarise`, `embed`) over a thin
OpenAI-compatible transport. (2) The `openai` SDK. (3) The Vercel AI SDK.

**Choice.** Option 1, in `apps/api/src/llm/`. The AI SDK is rejected because `usage.cost` and
`provider.require_parameters` become escape hatches and byte-exact replay becomes an interception
problem.

**Consequences.** **`modelFor(kind)` reads a database override first.** A one-row-per-task
`llm_setting (key text primary key, value text)` table is added now — about ten lines, no Settings
page, so §6.6's "nothing else in Phase 1" still holds. Without it, "swappable without a deploy" means
an env change plus a redeploy on the Supabase-backed instance, which is precisely what the brief names
as the requirement. The Settings page later becomes a form over a row that already exists.

### ADR-065 — A hand-written `fetch` transport with an overall deadline

**Context.** Two endpoint shapes, no streaming, and real dependence on fields the OpenAI SDK types in
neither direction (`usage.cost`, `provider.require_parameters`).

**Options.** (1) The `openai` SDK. (2) ~180 lines of hand-written `fetch`. (3) The Vercel AI SDK.

**Choice.** ~180 lines of `fetch`. Retries on 408/429/5xx with jittered backoff.

**Consequences — the timeout is fixed.** The proposal composed `AbortSignal.timeout(timeoutMs)` per
attempt _inside_ the retry loop and only rethrew on `LlmHttpError` or the caller's abort, so a timeout
satisfied neither and a hung provider was retried three times: with the documented
`LLM_TIMEOUT_MS=60000`, one "Ask the network" request could hang for over three minutes. Now: one
`AbortSignal.timeout(LLM_TOTAL_TIMEOUT_MS)` is created **before** the loop and composed with the
caller's signal; `LLM_ATTEMPT_TIMEOUT_MS` bounds each attempt; the deadline is checked between
attempts and terminates rather than retries. `409` is dropped from the retryable set (it has no
meaning for a chat-completions API) and the unreachable `throw lastErr` after the loop is removed.
The Fastify route maps `LlmTransportError` / `LlmSchemaError` into the §7 problem envelope with
`status 504` and `502` respectively, and `LLM_TOTAL_TIMEOUT_MS` defaults to `45000` so it stays under
any reasonable proxy timeout.

### ADR-066 — Structured outputs: `json_schema`, `strict: true`, always re-validate, one repair

**Context.** Everything parsed by code must be structured output. OpenRouter documents
`provider.require_parameters: true` as the way to restrict routing to endpoints that honour
`response_format`, and states plainly that exact compliance is not guaranteed on every endpoint.

**Options.** (1) Trust `strict: true` and parse the result. (2) `strict` plus `require_parameters`, always re-validate, and one repair round-trip. (3) Free text plus a tolerant parser.

**Choice.** `response_format: { type: 'json_schema', json_schema: { strict: true, schema } }` plus
`provider: { require_parameters: true }`, **and always re-validate the response with the same Zod
schema**. On a schema failure, exactly one repair round-trip that includes the validation errors; a
second failure raises `LlmSchemaError`. Both calls are traced and linked by `repair_of_id`.

**Consequences — the CI schema walker is fixed.** It guarded with `if (node.type === 'object')`, but
`.nullable()` either makes `type` an array or emits `anyOf`, and the house rule mandates `.nullable()`
everywhere — so exactly the shape the rules require was the shape the guard silently skipped, leaving
four objects in the quick-capture prompt without `additionalProperties: false` or a
required-covers-all check. The walker now keys on **the presence of a `properties` key** and recurses
explicitly through `anyOf` and `items`. A fixture test feeds `z.object({a: z.string()}).nullable()`
through the transform and asserts the walker actually visits the inner object — i.e. it tests the
test. A `z.toJSONSchema` snapshot per prompt catches a Zod minor that changes `nullable` emission as a
diff rather than a production 400.

### ADR-067 — Prompts are versioned TypeScript modules, locked by hash

**Context.** §3.2 requires prompt versioning. §6.6 rules out a Settings surface for it.

**Options.** (1) Versioned TS modules exporting `render(input)` with a typed signature.
(2) Markdown with frontmatter. (3) Database rows.

**Choice.** Option 1. Each `PromptSpec` exports `id`, `version`, `input` schema, `output` schema,
`render(input)` **and a `sample: TInput`**.

**Consequences.** The typed `render` signature is where the silent `undefined`-field bug lives, which
is why markdown loses. The strongest property falls out of the type: the extractor's return type emits
attribute **slugs** with confidences and never an attribute id or a chosen existing contact, so §4.8's
"the LLM extracts, code decides" is a compile-time fact rather than a review checklist item. The
`sample` lives beside the prompt so `prompts.lock.json` hashes a colocated, type-checked, refactorable
input. **The lock file is enforced from the end of Stage 6 onward**, with `pnpm llm:relock` — enforcing
it from Stage 1 gates nothing (no prompts exist) and enforcing it during active Stage-6 iteration turns
every wording tweak into a version bump plus a stale fixture.

### ADR-068 — The replayable trace is one Postgres table; fixtures are files

**Context.** §3.2 requires cost logging and a replayable trace.

**Options.** (1) One `llm_call` table. (2) JSONL on disk. (3) An external observability service.

**Choice.** Option 1. `llm_call` records prompt id and version, model, the request and response
bodies (behind `LLM_TRACE_BODIES`), token counts, `cost_usd`, `cost_source`, latency, `repair_of_id`,
and the five-part replay key. Option 3 violates "no proprietary services in the critical path"; JSONL
loses the joins the trace exists for and does not survive `git clean`.

**Consequences — two corrections.** `LLM_MODE=replay` reads **fixture files only** and fails loudly
with the record command when one is missing. The proposed fallback ("newest matching `llm_call` row")
made a replay test depend on whatever database the developer happened to be pointing at — green
locally because they clicked around last week, red in CI where the table is empty, which is the exact
non-determinism replay exists to eliminate. And **`prompt_hash` is the prompt _template_ hash**,
identical to the `prompts.lock.json` value and constant per prompt version — not "sha256 of the
rendered messages", which varies per input, subsumes `input_hash`, and makes the five-part key
incoherent. The `llm.trace-prune` scheduled job, `LLM_TRACE_RETENTION_DAYS` and the whole retention
mechanism are **dropped**: a single-user CRM making a few hundred calls a month will not approach a
size problem for years, and one documented `DELETE FROM llm_call WHERE created_at < …` in
`ARCHITECTURE.md` covers it. `LLM_TRACE_BODIES` stays, because it is a privacy switch, not a
housekeeping one.

### ADR-069 — Embeddings behind a separate `EmbeddingProvider`

**Context.** §3.1: if OpenRouter does not cover embeddings well enough, use a second provider behind
the same interface and document it. §9: `embed()` exists now; semantic search is later.

**Options.** (1) OpenRouter's `/embeddings` behind a separate `EmbeddingProvider` port. (2) Reuse the chat provider interface for embeddings. (3) A local embedding model.

**Choice.** A separate `EmbeddingProvider` port. Default `openai/text-embedding-3-small` via
OpenRouter's `/api/v1/embeddings` — verified live (the endpoint exists; 37 embedding models are
listed; native 1536 dimensions, matching `search_document.embedding vector(1536)`), so the brief's
contingency does not fire.

**Consequences.** **Phase 1 ships the typed `embed()` and one fixture test, and nothing else.** The
first-use dimension probe (which spends money), the never-mix-models guard, `pnpm llm:reembed` and the
three-step fallback ladder all move to Stage 8, alongside `embeddings.backfill`, where a vector is
about to be written and the checks have something to protect. The claim that
`google/gemini-embedding-2` and `qwen/qwen3-embedding-4b` accept a `dimensions` parameter is
**UNVERIFIED** — no embedding model in the live catalogue lists it in `supported_parameters` — and is
recorded as such in `ARCHITECTURE.md`. The fallback that is provably config-only is promoted instead:
`LLM_EMBEDDING_BASE_URL=https://api.openai.com/v1`, same wire format, native 1536. pgvector's index
dimension cap (2000 for `vector`, 4000 for `halfvec`) is written into `ARCHITECTURE.md` in Stage 1.

### ADR-070 — Cost: `usage.cost` as reported, and a budget checked per HTTP request

**Context.** "A bug that loops spends someone's real money."

**Options.** (1) Call `GET /api/v1/generation` after each request. (2) Record `usage.cost` from the response body. (3) Estimate from a cached price table.

**Choice.** OpenRouter always returns full usage (its docs state `usage: {include:true}` and
`stream_options` are deprecated no-ops), so the client must **not** send them and `usage.cost` is
recorded directly. Providers that report nothing get `cost_usd = NULL, cost_source = 'unreported'`.
`LLM_DAILY_COST_LIMIT_USD` is enforced **inside the transport, immediately before every HTTP POST**,
against a process-local counter refreshed from an indexed query.

**Consequences.** The proposed single check at the top of `run()` let one logical task bill up to six
generations — three transport attempts plus three on the repair exchange — so a retry storm blew
through the cap sixfold per user action before the next check. Checking per billable request is the
only placement that means what the setting says. The **`llm_model_price` table, its daily
price-refresh job and the estimated-cost arithmetic are dropped**: they existed for providers Phase 1
never points at, and `NULL, 'unreported'` is a more honest record than an estimate from a cached price
list. `GET /api/v1/stats/llm` exposes spend per day, per task and per prompt version.

### ADR-071 — "No LLM calls in business logic" is enforced by ESLint

**Context.** §4.8's rule — the LLM extracts, code decides — is exactly the kind of boundary that decays into a comment nobody enforces, in a repository future AI sessions will edit.

**Options.** (1) A prose rule in `CLAUDE.md`. (2) An ESLint `no-restricted-imports` zone. (3) A separate package boundary.

**Choice.** A `no-restricted-imports` rule forbidding `apps/api/src/llm/**` from `packages/core`,
`packages/db` and every route except the three that are allowed to call it, listed by exact path.

**Consequences.** `packages/core` — duplicate matching, filter compilation, warmth — **cannot** import
the LLM module, so extractor output has to enter core as plain validated data and core's decisions are
unit-testable with no model, no network and no fixtures. That is §4.8 made mechanical rather than
aspirational, and it matters more than usual in a repo future AI sessions will edit. Listing exact
route paths fails safe: a rename makes the rule apply and CI goes red. The rule is added the day
`llm/` is created, not retrofitted.

### ADR-072 — Four LLM test layers, none of which spend money in CI

**Context.** LLM behaviour is non-deterministic and every call costs money, while CI must be able to go green on a pull request from a fork, which has no access to secrets.

**Options.** (1) Live model calls in CI. (2) Four layers, none of which spend money by default. (3) No LLM tests at all.

**Choice.** L1 golden `z.toJSONSchema` snapshots per prompt (no network). L2 a fixture provider
implementing the port. L3 `msw@2.15.0` contract tests over the real transport. L4 opt-in live smoke
tests, off by default. Replay-mode e2e.

**Reasoning.** Secrets are unavailable to fork pull requests, so live CI calls would give an outside
contributor a red CI they cannot fix. And the interesting cases — repair succeeds, repair fails with
two rows linked by `repair_of_id`, schema-valid but domain-invalid slug rejected by core, budget
exceeded, `LLM_MODE=off` — cannot be produced reliably against a live model.

**Consequences.** L3 asserts that `usage: {include:true}` is **not** sent, and adds a test for the
total deadline (ADR-065) — the existing "a timeout raises `LlmTransportError`" assertion passes even
while the loop silently retries three times. If msw's fetch interception misbehaves under Node 24, the
same-day fallback is undici's `MockAgent`. `pnpm llm:record` and `fixtures/llm/*.json` arrive in
Stage 6; until then hand-written fixtures validated through the production Zod schema give the same
drift protection.

---

## 8. Testing, CI and the definition of "green"

### ADR-073 — Vitest 4.1.11, two projects in Phase 1

**Context.** §8.1 wants high-coverage unit tests for domain logic and integration tests against a real
database.

**Options.** (1) Vitest with `test.projects`. (2) Vitest + Jest. (3) `node:test`.

**Choice.** Vitest 4.1.11, **two** projects: `unit` (`packages/core`, pure `apps/*` modules; no
database) and `integration` (`packages/db`, `apps/api`; real database). A `web` project is added the
day the first component test is written; the `perf` project is deleted (see §9).

**Consequences — two verified fixes.**

1. `sequence.groupOrder` is set (`unit: 0`, `integration: 1`). Vitest 4 throws
   _"Projects X and Y have different 'maxWorkers' but same 'sequence.groupOrder'"_ when two projects
   with different resolved worker counts run in one invocation — so plain `vitest run`, `vitest --ui`
   and the proposal's own headline benefit (one coverage report across projects) all crashed.
2. `poolOptions.forks.singleFork` **was removed in Vitest 4** and is silently ignored; the correct
   spelling is top-level `maxWorkers: 1, isolate: false`. Under the old config the database projects
   ran files in parallel workers against one database, which is exactly what makes
   truncate-and-reseed suites flaky.

Application and pool construction move **out of `setupFiles`**, which run before _each test file_ —
so the proposed `beforeAll` booted Fastify and a `pg` pool ~30 times, not 4, and the cost model was
built on the wrong number. They become a per-worker module-level singleton cached on `globalThis` and
closed in `globalSetup` teardown. `packages/db` splits into `*.unit.test.ts` (in the `unit` project)
and `*.int.test.ts`, so the golden-SQL compiler tests §8.1 asks for run without Postgres.

### ADR-074 — Test isolation: a template database, one clone per worker, truncate and reseed

**Context.** The write path is an explicit `BEGIN; SELECT FOR UPDATE; UPDATE; INSERT; COMMIT` with a
`SET LOCAL` GUC, and one required test is two concurrent writers to the same record.

**Options.** (1) Transaction rollback per test. (2) A template database cloned per worker, with
`TRUNCATE` + baseline reseed between tests. (3) Testcontainers.

**Choice.** Option 2. Under option 1 the explicit transactions in the write path would nest, `SET
LOCAL` would leak across "tests", and the concurrency test would be impossible — so rollback isolation
here is not slow-but-fine, it is silently broken. Testcontainers needs Docker, which the machine does
not have.

**Consequences — four safety fixes.** `globalSetup` asserts `Number(VITEST_POOL_ID) <=
MUTUALS_TEST_WORKERS` with a named error (otherwise worker 5 connects to a database that does not
exist and the failure reads as a connection error). The **entire `pgboss` schema is excluded** from
the `pg_tables`-derived `TRUNCATE` — pg-boss 12 uses partitioned job tables, and truncating
`pgboss.queue` while partitions exist is not a state it expects. The vestigial
`tablename <> '__drizzle_migrations'` clause is gone with Drizzle. And **no `DROP`/`TRUNCATE` path
runs unless the host is `127.0.0.1`/`localhost` or `MUTUALS_ALLOW_DESTRUCTIVE=1` is set** — cheap, and
it is the difference between a contributor losing a test database and losing a real one.

### ADR-075 — Integration tests drive the real Fastify app via `app.inject()`

**Context.** §8.1 requires integration tests against a real database covering each resource's happy path, its validation errors, and the dynamic filter and sort on custom attributes.

**Options.** (1) Call the service layer directly. (2) `app.inject()` against the real database. (3) A real HTTP socket for every test.

**Choice.** `inject()` against the real database. That covers routing, the Zod type provider,
serialisation, hooks and the error handler — which is what the brief means by "the API". Service-layer
calls are rejected precisely because the query-string filter model is the fragile surface. The
streamed multipart import keeps a real socket, because `inject` buffers.

**Consequences.** Five blocks per resource: happy path, validation errors, the dynamic filter/sort on
a custom attribute, pagination, and the destructive path. The destructive block asserts the **exact
confirmation count string** §5.4 shows the user, not just a 200.

### ADR-076 — Typed builder factories that go through the real write path

**Context.** Every integration test needs contacts, organizations, interactions and follow-ups to exist, and how those are created decides what the test actually proves.

**Options.** (1) Raw SQL inserts. (2) Typed builders that go through the real write path. (3) `fishery`.

**Choice.** `aContact()`, `anOrganization()`, `anInteraction()`, `aFollowUp()` call the API, so every
fixture is itself a test of the write path. `@faker-js/faker@10.5.0` (the `stable` dist-tag) with a
fixed seed. `fishery` is not worth 30 lines at this size.

**Consequences.** Raw SQL inserts would let a test pass while the projector is broken — the strongest
argument in this area. The app instance is reached through an explicit `setTestApp()` / `getTestApp()`
pair in `test-support`, not an untyped `globalThis` property (the proposal described two different
mechanisms and typed neither). `manyContacts(n)` routes through the bulk importer **deliberately**,
and says so, so nobody reads a bulk-created fixture as evidence the single-record path works.

### ADR-077 — The filter compiler is tested three ways

**Context.** §8.1 singles out filter-to-query compilation as the thing to test heavily — it is the component where a silent mistake returns a plausible but wrong set of people.

**Options.** (1) Snapshot tests over the emitted SQL. (2) Golden SQL, plus semantic tests, plus a completeness test. (3) Semantic tests only, against seeded data.

**Choice.** (a) Golden SQL + parameter array per `(type, operator)` pair, ~45 cases, no database;
(b) semantic tests that run each operator against seeded data and assert the returned ids;
(c) a completeness test that iterates `OPERATORS_BY_TYPE` and fails if any pair has no golden case.

**Consequences.** (c) is the one that keeps the suite honest as types are added. The golden strings
are produced by writing the expected SQL **first** and are updated only by a human editing the
expectation — never by pasting actual output, which is a snapshot with extra steps. **The
TypeScript↔SQL normalisation contract test is deleted**, because ADR-019 deleted the second
implementation it was pinning.

### ADR-078 — `EXPLAIN` tests assert plan shape, never latency

**Context.** §5.2 requires "smooth at 10k rows"; a latency budget on a shared CI runner is a coin flip,
and a coin-flip gate is worse than no gate because the team believes it has one.

**Options.** (1) Latency budgets asserted in CI. (2) Plan-shape assertions. (3) No performance tests before Stage 7.

**Choice.** Nine assertions that each `attribute_value` index is chosen for its operator, plus two
that both sort directions produce `NULLS LAST` without a spilled sort. Run on demand and as part of
Stage 1's definition of done, against the 10k-row generator.

**Consequences.** A dedicated `Client` (not a `Pool`) holds the perf session, or the GUCs are set in
the same `query()` call as the `EXPLAIN` — otherwise `SET work_mem` binds to one pooled connection and
the `EXPLAIN` may run on another, silently invalidating "the plan is a function of the data, not the
host". Assertions are on sort **direction** and `NULLS LAST` placement via `Sort Space Type` and a
substring match, not full equality on the rendered `Sort Key` string, which changes with aliasing and
across minor versions. The nightly perf workflow, `perf/baseline.json`, `scripts/perf-summary.mjs` and
`pnpm perf:record` rewriting `ARCHITECTURE.md` between marker comments all move to **Stage 7**, where
the brief puts the performance pass; until then `perf:record` writes an artifact a human pastes.

### ADR-079 — Playwright 1.62.1, Chromium only, seeded from the same reset helper

**Context.** §8.1 names four end-to-end flows: create an attribute and filter by it, import a LinkedIn CSV containing a duplicate, contact → interaction → recurring follow-up → mark done, and a saved-view round trip.

**Options.** (1) All three browser engines. (2) Chromium only, one worker, seeded from the same reset helper the Vitest projects use. (3) A test-only `POST /__test__/reset` route.

**Choice.** Four flows (§8.1): create attribute → appears as a column → filter by it; import a
LinkedIn CSV with a duplicate; create contact → interaction → recurring follow-up → mark done;
saved-view round-trip. `workers: 1`, `fullyParallel: false`, `retries: 1` in CI and `0` locally.
The database is seeded from the **same `resetDatabase()`** the Vitest projects use.

**Consequences.** No `POST /__test__/reset` route ships — the only thing between such a route and
production is an env-var check somebody eventually gets wrong. `retryStrategy: 'isolated'` and
`failOnFlakyTests` are dropped: with one worker there is no competing load to isolate retries from,
so two of the three settings were inert. `playwright.config.ts` carries a `webServer` array that
**builds** the SPA and boots Fastify against `mutuals_e2e` — the proposed CI job installed Chromium
and ran specs without ever starting the application. Playwright is installed via
`pnpm --filter @mutuals/e2e exec playwright install --with-deps chromium`; run from the workspace root
it is not on `PATH`.

### ADR-080 — Coverage measured everywhere, enforced on the domain modules the brief names

**Context.** §8.1 asks for high coverage on domain logic specifically, not on everything — and a single number that averages a pure function against a Fastify plugin starts being gamed the day it is introduced.

**Options.** (1) A single global coverage percentage. (2) Thresholds enforced only on the domain modules the brief names. (3) No thresholds, coverage reported only.

**Choice.** Coverage is collected for the whole repo and reported. Thresholds are enforced only on
`packages/core/src/{attributes,filters,sort,warmth,identity,followups,import,text,time,decimal}`:
`lines 90`, `branches 85`, **`functions 100`**, `perFile: true`.

**Consequences.** A global percentage averages a pure function against a Fastify plugin and starts
being gamed immediately; `functions: 100` captures "every exported function has a test" without paying
for unreachable defensive branches. `perFile` **does** apply to glob threshold groups
(`@vitest/coverage-v8@4.1.11` reads `options.thresholds?.perFile` when constructing the summary list
for every resolved threshold set, glob sets included), so the open question and its fallback script
are deleted rather than scheduled. `text`, `time` and `decimal` are inside the enforced glob — the
previous list omitted the modules it elsewhere called the highest-value contracts in the suite.
`**/index.ts` is excluded only where it is a pure re-export barrel, with a comment saying so.

### ADR-081 — Determinism: an injected clock in TypeScript only

**Context.** A test that depends on the wall clock, the host timezone or an unseeded random source passes on the machine that wrote it and fails on another one, or on another day.

**Options.** (1) A SQL `mutuals_now()` plus a session GUC, so Postgres shares the injected clock. (2) An injected clock in TypeScript only. (3) Global fake timers.

**Choice.** `now`, `today` and `timeZone` are constructor parameters (ADR-034). Seeded faker. `TZ=UTC`
for unit and integration; `TZ=Europe/Berlin` for e2e, so the off-by-one-day case is actually
exercised. A fake LLM provider whose canned responses are validated through the **production** Zod
schema. A `beforeAll` fetch guard that throws on any network call.

**Consequences.** **`mutuals_now()` and the `SET LOCAL mutuals.now` GUC are dropped.** They were a
testing decision reaching into the production schema, obliging every future SQL author to remember a
non-standard function forever, with nothing enforcing it — and the justification ("half the
time-dependent logic lives in Postgres") does not hold: `observed_at` and `completed_at` are written
by the application, which already takes `now` as a parameter, and ADR-040 removed the last `now()`
from emitted SQL. Business timestamps are bound as parameters. The `vi.mock('pg', () => { throw … })`
poison is replaced by the boring enforcement — `pg` is simply not in `packages/core`'s
`package.json`, plus the `no-restricted-imports` rule of ADR-009 — because the poison also broke any
`apps/api` unit test whose import graph touched the database module.

### ADR-082 — `pnpm verify` is the one command, and CI calls exactly it

**Context.** "Is it green?" should not be a matter of opinion, and a green local run and a green CI
run should mean the same thing.

**Options.** (1) A list of steps in the README that CI re-implements. (2) Three composite scripts that both a human and CI call. (3) One monolithic `verify` that always includes e2e.

**Choice.** Three composite scripts — `verify:static` (format, lint, typecheck, unit tests,
`pnpm build`), `verify:db` (migrate, integration tests, seed + a count assertion, the projection
equivalence gate), `verify:e2e` (build, migrate `mutuals_e2e`, Playwright). `pnpm verify` runs the
first two; `pnpm verify:full` adds e2e. **Each CI job calls one of those scripts and nothing else.**

**Consequences.** The proposed workflow re-listed the steps by hand, reintroducing exactly the
local/CI drift the decision existed to prevent. `pnpm build` runs before e2e, because the e2e
`webServer` previews a build output the script previously never produced, so the documented first-run
sequence failed on every fresh machine. `pnpm seed` — the command Simon runs most, and a §8.1
deliverable — is exercised in CI with one assertion on the resulting counts. e2e is excluded from the
default `verify` because a two-minute wait before every push is how a one-command gate stops being run
locally.

### ADR-083 — CI: GitHub Actions, two jobs at Stage 1, a third when e2e exists

**Context.** §3.2 requires a GitHub Actions workflow running lint, typecheck and tests, and §8.2 requires `main` to always be runnable.

**Options.** (1) One job. (2) Two jobs at Stage 1, a third when the e2e suite exists. (3) Three jobs from day one.

**Choice.** `actions/checkout@v7`, `pnpm/setup@v2` with `runtime: node@24`, and
`pgvector/pgvector:pg16` as a service container with `POSTGRES_DB` set. Job 1 runs `verify:static`;
job 2 runs `db:migrate` then `verify:db`; job 3 (from Stage 2) runs `verify:e2e` with
`E2E_DATABASE_URL` set explicitly and the database created. `concurrency` cancels superseded runs;
`permissions` is least-privilege.

**Consequences.** Three jobs at Stage 1 would each pay a full checkout and install before there is
anything to run; the split into three happens mechanically when the e2e suite exists. The **single
generated-artifact gate** is `docs/openapi.json` (ADR-030): regenerate, `git diff --exit-code`. The
previously proposed four gates — `db:codegen` diff, `api:check` over two committed files,
`api:lint-operations` and a `FilterSet` contract test — collapse to that one plus the `information_schema`
drift test of ADR-027 and the `operations.ts` route-coverage assertion of ADR-031. `pnpm db:check`
(nine `EXPLAIN` index assertions, byte-identical reprojection, NULL-`workspace_id` scan) runs at the
**end of Stage 1** and thereafter in job 2 — it is a performance-regression harness for tables that
have no rows until the generator exists.

---

## 9. Removed for Phase 1 — the over-engineering register

Everything the reviews flagged, with the ADR that removed it. Each line is a thing that will **not** be
built now; where §9 of the brief needs the door left open, the extension point is in §10.

| Removed                                                                                                            | Where it went                                                                       | ADR      |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | -------- |
| `?count=auto\|exact\|none`, `reltuples` estimation, `meta.totalIsEstimate`                                         | `meta.total` is an exact nullable integer; an estimate is additive later            | 022      |
| Cursor `(filter, sort)` signature hash and the `stale_cursor` 400                                                  | The cursor stays opaque                                                             | 022      |
| `.notx.sql` reserved migration suffix                                                                              | Deleted; Kysely's Migrator structurally cannot honour it                            | 027      |
| Three of four generated-artifact CI gates; committed `schema.d.ts`                                                 | One gate: `docs/openapi.json`                                                       | 029, 080 |
| A published `bearerAuth` security scheme nothing enforces                                                          | The empty `preHandler` plugin is §7's middleware slot                               | 028      |
| "Where should error `type` URIs point?" as a human question                                                        | GitHub docs anchors; RFC 9457 does not require dereferencing                        | 030      |
| `openapi-typescript` + `openapi-fetch` + `openapi-react-query`                                                     | Types come from `@mutuals/core`                                                     | 029      |
| `packages/ui`, `packages/contracts`, `packages/llm`, `packages/jobs`, `packages/import`, `packages/api-client`     | Directories inside the two apps and `packages/core`                                 | 006      |
| `pnpm strictPeerDependencies: true`                                                                                | Default (off)                                                                       | 004      |
| Commented-out `tasks:` block in `pnpm-workspace.yaml`                                                              | The escalation path is recorded in prose only                                       | 005      |
| `e2e` workspace package before the first spec                                                                      | Created in Stage 2                                                                  | 006      |
| `EMBEDDINGS_*` keys in `.env.example` at Stage 1                                                                   | Documented in `ARCHITECTURE.md`, added in Stage 8                                   | 010, 066 |
| The `.pgdata` project-local cluster script (`brew install`, `sudo apt-get`, mutable git tag → `make install`)      | Detect-and-instruct; installs only behind `--install`                               | 012      |
| `pgcrypto` in the required-extension list                                                                          | `gen_random_uuid()` is core since PG13                                              | 002      |
| Cluster-wide `lc_ctype=C`                                                                                          | Column-level `COLLATE "C"` on `text_sort` only                                      | 018      |
| The TypeScript text fold, the `unaccent.rules` port, the TS trigram implementation, the 100-pair contract test     | One SQL implementation                                                              | 018, 074 |
| `contact.name_key`                                                                                                 | `record.label_norm`, written by the existing trigger                                | 018      |
| Tier 2 reserved slugs (~90 SQL keywords); `type` and the query-param names in tier 3                               | Two tiers, three hazard names                                                       | 039      |
| `exactOptionalPropertyTypes`                                                                                       | `strict` + `noUncheckedIndexedAccess`                                               | 003      |
| Generic parameters on `AttributeTypeDefinition`                                                                    | Non-generic + a mapped-type accessor                                                | 035      |
| Twelve relative presets incl. `next_7/30/90_days`                                                                  | The two the brief names, plus `older_than`/`newer_than`; forward presets in Stage 4 | 038      |
| `occurrencesBetween`                                                                                               | Nothing in Phase 1 enumerates future occurrences                                    | 041      |
| `libphonenumber-js/max` (157,588 B of metadata)                                                                    | `/min` (83,972 B); the mobile/landline split is a no-op in merged plans             | 034      |
| `packages/core/./sql` subpath                                                                                      | The compiler lives in `packages/db`                                                 | 032      |
| Column sizing and resizing                                                                                         | `size` on the `ColumnDef` for default widths                                        | 048      |
| `autoCodeSplitting`, the React Compiler                                                                            | No measured win at ~30 virtualised rows                                             | 044      |
| The 64 KB client-side file peek in the import wizard                                                               | The server detects the delimiter and returns the first rows                         | 051      |
| A duplicated `operators.ts` in the UI plus a test asserting it agrees with core                                    | Core exports operator keys per type; the compiler enforces agreement                | 036      |
| The full dark-mode contrast unit test and dark screenshots per stage                                               | Dark tokens ship; the toggle does not                                               | 053      |
| CI-enforced frame-time and p95 budgets                                                                             | Measured and recorded in `ARCHITECTURE.md`, not gated                               | 075      |
| `search.reindex-record` queue and handler                                                                          | The projector already maintains `search_document` in-transaction                    | 054      |
| `EnqueueOptions.debounceSeconds` / `key`, the 8 KB payload cap, `JobContext.signal`, re-entrant `JobContext.queue` | Three-method port                                                                   | 054      |
| `import.failed` dead-letter queue                                                                                  | `import_batch.status='failed'` + `last_committed_row`                               | 058      |
| `llm_model_price`, the daily price-refresh job, estimated-cost arithmetic                                          | `cost_usd = NULL, cost_source='unreported'`                                         | 067      |
| `llm.trace-prune`, `LLM_TRACE_RETENTION_DAYS`                                                                      | One documented `DELETE` in `ARCHITECTURE.md`                                        | 065      |
| Phase-1 embedding dimension probe, model-mixing guard, `pnpm llm:reembed`                                          | Stage 8, with `embeddings.backfill`                                                 | 066      |
| `prompts.lock.json` CI enforcement before Stage 6                                                                  | Enforced from the end of Stage 6; `pnpm llm:relock`                                 | 064      |
| `pnpm llm:record` + `fixtures/llm/*.json` at Stage 1                                                               | Stage 6; hand-written fixtures until then                                           | 069      |
| The `perf` Vitest project, the nightly perf workflow, `perf/baseline.json`, `perf-summary.mjs`                     | Stage 7                                                                             | 075      |
| `mutuals_now()` and `SET LOCAL mutuals.now`                                                                        | Timestamps bound as parameters                                                      | 078      |
| Playwright `retries: 2` + `retryStrategy: 'isolated'` + `failOnFlakyTests`                                         | `retries: 1` in CI                                                                  | 076      |
| `--tmpfs`, `fsync=off`, `synchronous_commit=off`, `jit=off` tuning                                                 | Chosen before any measurement existed                                               | 012      |
| Named scenario builders (`warmInvestor`, `identifierDuplicate`, …) at Stage 0                                      | Stage 5, with duplicates and merge                                                  | 073      |
| Pre-specified property-test cardinalities (5,000 / 1,000 / 10,000)                                                 | The tests stay; the invented precision goes                                         | 074      |
| A committed OpenAPI **snapshot** contract test as a Stage-1 gate                                                   | The regenerate-and-diff gate is enough                                              | 080      |

---

## 10. Extension points kept, because §9 of the brief demands them

| Later feature                              | Extension point, present from Stage 1                                                                                                                                                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic search / embeddings               | `search_document.embedding vector(1536)` (nullable, unindexed); `EmbeddingProvider.embed()` typed and fixture-tested; `search` API takes `mode` (`keyword` now); HNSW index created **after** the first backfill, never on an empty column; pgvector's 2000/4000 index dimension cap recorded |
| Synergy and stay-in-touch nudges           | `follow_up.origin = 'system'`; `asks` / `offers` tags seeded on day one; `contact_metrics.warmth`; `apps/api/src/jobs/` with `SCHEDULES` and the port. Rule recorded: intro suggestions only on an ask↔offer match, never topic similarity                                                    |
| Chat channels (Telegram, WhatsApp)         | `quickCapture` and `ask` are complete API operations; `interaction.source` and `fact.source` already carry the values                                                                                                                                                                         |
| Voice input                                | Quick capture takes plain text; a speech-to-text step prepends                                                                                                                                                                                                                                |
| Gmail / Calendar sync                      | `interaction.source` includes `gmail`/`calendar`; `apps/api/src/integrations/` with the `fetchSince(cursor)` interface; a `sync_state` table stub                                                                                                                                             |
| Enrichment crawler                         | `record.last_enriched_at` / `enriched_by`; per-value provenance already exists (`attribute_value.fact_id`)                                                                                                                                                                                    |
| Network graph                              | `record_link` is first-class and queryable; `getContactConnections` is a named operation                                                                                                                                                                                                      |
| Dashboard charts                           | `getStats` returns simple aggregates from `contact_metrics` / `organization_metrics`                                                                                                                                                                                                          |
| Auth, multi-user, multi-tenant             | Nullable-but-populated `workspace_id` on every table (ADR-014); the empty `preHandler` plugin; no global "current user" singleton                                                                                                                                                             |
| CLI client · MCP server                    | `operations.ts` — every UI action is one named operation; `docs/openapi.json` is committed                                                                                                                                                                                                    |
| animate-ui                                 | Components stay shadcn-standard, `data-slot` attributes intact                                                                                                                                                                                                                                |
| Bitemporal value resolution                | `project_record_as_of(record, date)` — same function, one predicate, no schema change (ADR-021)                                                                                                                                                                                               |
| `current_values jsonb` render cache        | One column, one projector line, one serialiser branch (ADR-013)                                                                                                                                                                                                                               |
| Promoting a hot attribute to a real column | Add `contact.city`, backfill, teach the field registry; the compiler emits `c.city` instead of an `EXISTS`. No API, UI or fact-log change                                                                                                                                                     |
| Keyset pagination on custom sorts          | The cursor is already opaque (ADR-023)                                                                                                                                                                                                                                                        |

---

## 11. Dependencies — exact pins, verified vs assumed

Every version below was read from the live npm registry with `npm view <pkg> version` on
**2026-09-03**, in this session. `savePrefix: ''` means these appear in `package.json` without a range.

### 11.1 Root (dev tooling)

| Package                       | Pin       | Verified in this session                                               |
| ----------------------------- | --------- | ---------------------------------------------------------------------- |
| `pnpm`                        | `11.25.0` | registry `latest` (`latest-12` = 12.3.1)                               |
| `typescript`                  | `6.0.3`   | published stable; `latest` is 7.0.2, `next` is 7.1.0-dev               |
| `typescript-eslint`           | `8.69.0`  | peers `eslint ^8.57 \|\| ^9 \|\| ^10`, **`typescript >=4.8.4 <6.1.0`** |
| `eslint`                      | `10.9.1`  | `engines: ^20.19 \|\| ^22.13 \|\| >=24`                                |
| `@eslint/js`                  | `10.0.1`  | registry                                                               |
| `eslint-config-prettier`      | `10.1.8`  | registry; exports `./flat`                                             |
| `eslint-plugin-react-hooks`   | `7.1.1`   | registry                                                               |
| `eslint-plugin-react-refresh` | `0.5.6`   | registry                                                               |
| `globals`                     | `17.12.0` | registry                                                               |
| `prettier`                    | `3.9.6`   | registry                                                               |
| `prettier-plugin-tailwindcss` | `0.8.1`   | registry                                                               |
| `vitest`                      | `4.1.11`  | registry                                                               |
| `@vitest/coverage-v8`         | `4.1.11`  | registry                                                               |
| `@faker-js/faker`             | `10.5.0`  | dist-tag **`stable`** (`latest` is 10.6.0)                             |
| `@types/node`                 | `24.13.3` | **corrected** — see note below; `latest` is 26.4.1                     |
| `esbuild`                     | `0.28.2`  | registry — build-only, never in the dev loop                           |

**`@types/node` is pinned to the 24 line, not `latest`.** `latest` is 26.4.1 and carries the `ts6.0`
dist-tag, which is why the earlier draft picked it — but it describes **Node 26** APIs while
`engines.node` is `>=24.0.0`. Typechecking against a newer runtime's surface is how you ship a call to
an API that does not exist on the machine the app runs on, and no compiler error would say so. The
risk runs the other way for TypeScript compatibility (a newer compiler reads older `.d.ts` files
fine), so `24.13.3` + `typescript@6.0.3` is the safe corner. Falsifier: if the 24-line definitions ever
fail to compile under TS 6, take 26.4.1 and accept the API overshoot — and say so in
`ARCHITECTURE.md`.

### 11.2 `apps/api`

| Package                     | Pin                 | Verified                                                                                                    |
| --------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `fastify`                   | `5.12.1`            | registry                                                                                                    |
| `fastify-type-provider-zod` | `7.0.0`             | peers `zod >=4.1.5`, `fastify ^5.5.0`, `@fastify/swagger >=9.5.1`, `openapi-types ^12.1.3`                  |
| `@fastify/swagger`          | `9.8.1`             | registry                                                                                                    |
| `@fastify/swagger-ui`       | `6.1.1`             | registry                                                                                                    |
| `@fastify/static`           | `10.1.3`            | registry — serves `apps/web/dist` in production                                                             |
| `@fastify/multipart`        | `10.1.1`            | registry — the import upload (ADR-031)                                                                      |
| `pino` / `pino-pretty`      | `10.3.1` / `13.1.3` | registry                                                                                                    |
| `pg-boss`                   | `12.29.0`           | `engines >=22.12.0`; deps only `pg ^8.23.0`, `cron-parser ^5.10.0`, `serialize-error ^13.0.1` — **Stage 5** |
| `csv-parse`                 | `7.0.2`             | registry — streaming CSV, **Stage 5**                                                                       |
| `exceljs`                   | `4.4.0`             | registry — streaming `.xlsx` reader, **Stage 5**                                                            |
| `vcard4`                    | `4.0.5`             | registry — `.vcf`, **Stage 5**                                                                              |
| `msw`                       | `2.15.0`            | registry — dev only, **Stage 6**                                                                            |

### 11.3 `packages/db`

| Package          | Pin      | Verified                                                                                                                                                             |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kysely`         | `0.29.5` | `engines: node >=22`, `type: module` (ESM-only), TS ≥5.4                                                                                                             |
| `pg`             | `8.23.0` | registry                                                                                                                                                             |
| `@types/pg`      | `8.23.1` | **corrected** — the earlier draft's `8.15.6` was the one version in this document read from memory; the registry says 8.23.1                                         |
| `kysely-codegen` | `0.20.0` | **dev only, non-gating** — `peerDependencies.kysely >=0.27.0 <1.0.0`, but `devDependencies.kysely` is `^0.28.11` and it has not published since 2026-02-16 (ADR-027) |

### 11.4 `packages/core`

| Package             | Pin       | Verified                                                |
| ------------------- | --------- | ------------------------------------------------------- |
| `zod`               | `4.5.4`   | registry                                                |
| `libphonenumber-js` | `1.13.12` | registry; the **`/min`** metadata entry point (ADR-035) |

### 11.5 `apps/web`

| Package                                                | Pin                         | Verified                                                                                          |
| ------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `react` / `react-dom`                                  | `19.2.8`                    | registry                                                                                          |
| `@types/react` / `@types/react-dom`                    | `19.2.18` / `19.2.7`        | **added** — missing from the earlier draft; a React + strict-TS app does not compile without them |
| `vite`                                                 | `8.2.2`                     | `engines: ^20.19 \|\| >=22.12`                                                                    |
| `@vitejs/plugin-react`                                 | `6.1.1`                     | registry; babel/compiler peers are **optional**                                                   |
| `tailwindcss` / `@tailwindcss/vite`                    | `4.3.3` / `4.3.3`           | registry                                                                                          |
| `tw-animate-css`                                       | `1.4.0`                     | registry                                                                                          |
| `@tanstack/react-router`                               | `1.170.32`                  | registry                                                                                          |
| `@tanstack/router-plugin`                              | `1.168.35`                  | registry; peer range is `>=5 \|\| >=6 \|\| >=7 \|\| >=8` with `vite` **optional**                 |
| `@tanstack/react-query`                                | `5.102.8`                   | registry (v6 is Svelte/Solid adapters only)                                                       |
| `@tanstack/react-table`                                | `9.2.4`                     | registry; shadcn's data-table docs are on v9                                                      |
| `@tanstack/react-virtual`                              | `3.14.10`                   | registry                                                                                          |
| `react-hook-form`                                      | `7.87.0`                    | registry (8.x is beta only)                                                                       |
| `@hookform/resolvers`                                  | `5.9.1`                     | peers `react-hook-form ^7.55.0`, `zod ^3.25 \|\| ^4`                                              |
| `radix-ui`                                             | `1.6.7`                     | registry (Base UI is `1.0.0-rc.0` — not used)                                                     |
| `lucide-react`                                         | `1.40.0`                    | **corrected** to the current `latest`; the earlier draft pinned 1.39.0 with a hedge               |
| `cmdk`                                                 | `1.1.1`                     | registry — ⌘K palette                                                                             |
| `sonner`                                               | `2.0.8`                     | registry — toasts                                                                                 |
| `@dnd-kit/core` / `@dnd-kit/sortable`                  | `6.3.1` / `10.0.0`          | registry — column reorder                                                                         |
| `date-fns`                                             | `4.4.0`                     | registry — relative dates in the UI only                                                          |
| `react-day-picker`                                     | `10.0.1`                    | registry — shadcn Calendar                                                                        |
| `class-variance-authority` / `clsx` / `tailwind-merge` | `0.7.1` / `2.1.1` / `3.6.0` | registry                                                                                          |
| `shadcn` (CLI)                                         | `4.20.1`                    | registry — run via `pnpm dlx`, **not** a dependency                                               |

### 11.6 `e2e` (Stage 2 onward)

`@playwright/test@1.62.1` — registry; `retryStrategy` was added in 1.62 and `failOnFlakyTests` in
1.52, though ADR-079 uses neither.

### 11.7 Infrastructure

`pgvector/pgvector:pg16` (Docker Hub tags `pg13`…`pg18` exist; the image currently carries pgvector
0.8.6, and ≥0.8.2 is required for `hnsw.iterative_scan`). GitHub Actions: `actions/checkout@v7`,
`pnpm/setup@v2`, `actions/upload-artifact@v7`.

### 11.8 Assumed, not verified — and what falsifies each

- **`kysely-codegen@0.20.0` runs at all against `kysely@0.29.5` and a schema containing a composite FK
  to a non-PK unique target, `NULLS NOT DISTINCT`, a partial unique index, a mixed-opclass GIN and a
  generated `tsvector`.** Unverified, and ADR-027 makes it non-gating precisely because of that. If it
  fails, the hand-written `schema.ts` is the plan and nothing changes.
- **`@fastify/multipart@10.1.1` composes cleanly with `fastify-type-provider-zod@7.0.0`.** Multipart is
  a known rough edge for Zod type providers. Falsifier: the Stage-5 upload route. Fallback: register
  the upload route without the type provider and validate the parsed fields with Zod by hand.
- **Every latency number inherited from `storage-DECISION.md` §9.2** — 3–10 ms for a three-chip filtered
  page, 8–20 s for a 10k-row import, <1 s for the nightly sweep. These are extrapolations from index
  shapes; no Postgres existed in the environment where they were written. Stage 1's definition of done
  replaces every one of them with real `EXPLAIN (ANALYZE, BUFFERS)` output in `ARCHITECTURE.md`.
- **Every frontend frame-time and bundle-size figure.** Budgets, not measurements. Stage 7 replaces
  them with Playwright traces at 10k rows.
- **The four default OpenRouter model ids** (`google/gemini-3.5-flash-lite`, `openai/gpt-5.4-mini`,
  `openai/text-embedding-3-small`). Catalogues drift; exact ids are pinned rather than
  `~vendor/model-latest` aliases, the live smoke test fails loudly on a 404, and the README points at
  `openrouter.ai/models?supported_parameters=structured_outputs`.
- **pg-boss is safe through Supabase's transaction pooler.** Reasoned from `pg_advisory_xact_lock()`
  being transaction-scoped, never measured. ADR-058 makes it a Stage-5 acceptance test.
- **TanStack Table v9's absolutely-positioned rows compose with `position: sticky` cells** for the
  pinned first column in Safari and Firefox. Stage 2's definition of done includes a cross-browser
  screenshot.

---

## 12. Repository tree

Files marked `[S2]`…`[S6]` are created in that stage, not in Stage 1.

```
mutuals/
├─ package.json                    packageManager, devEngines, engines, scripts
├─ pnpm-workspace.yaml             packages: apps/*, packages/*, e2e ; allowBuilds map
├─ pnpm-lock.yaml
├─ tsconfig.base.json
├─ eslint.config.js                flat config; typed zones; the core import guard
├─ .prettierrc  .prettierignore
├─ .env.example                    complete, no real values
├─ .gitignore                      .env, .env.*, !.env.example, dist/, node_modules/
├─ .nvmrc                          24
├─ docker-compose.yml              db service only — pgvector/pgvector:pg16
├─ LICENSE                         MIT
├─ README.md  CLAUDE.md
├─ .github/
│  ├─ workflows/ci.yml             verify:static · verify:db · verify:e2e [S2]
│  └─ dependabot.yml
├─ scripts/
│  ├─ dev.mjs                      the one command (ADR-011)
│  └─ db-up.mjs                    detect-and-instruct; creates dev/test/e2e databases
├─ docs/
│  ├─ BRIEF.md                     the moved brief — source of truth for product decisions
│  ├─ PLAN.md  DECISIONS.md  ARCHITECTURE.md  ERRORS.md
│  ├─ openapi.json                 generated, committed, diffed in CI
│  └─ refs/                        the Tacto reference screenshots
├─ fixtures/
│  ├─ linkedin_connections_sample.csv
│  ├─ google_contacts_sample.csv
│  └─ apple_contacts_sample.vcf
│
├─ packages/core/                  @mutuals/core — zod + libphonenumber-js only; ships to the browser
│  ├─ package.json                 exports "." and "./phone"
│  └─ src/
│     ├─ result.ts                 Result, CoreIssue, assertNever
│     ├─ decimal.ts                decimal-string parse/compare/format
│     ├─ time/civil.ts             CivilDate arithmetic, todayIn(tz, now)
│     ├─ text/casefold.ts          DISPLAY-ONLY casefold; explicitly not the filter contract
│     ├─ attributes/
│     │  ├─ slots.ts               THE only file with physical column names
│     │  ├─ kinds.ts  registry.ts  slug.ts  reserved.ts
│     │  └─ types/                 twelve files, one per attribute type
│     ├─ fields/system.ts          system + derived pseudo-fields per object type
│     ├─ fields/resolve.ts         FieldResolver: system column | metric column | attribute
│     ├─ filters/
│     │  ├─ model.ts               the discriminated union + Zod schemas
│     │  ├─ operators.ts           OPERATORS_BY_TYPE, arity
│     │  ├─ query.ts               parseListQuery / serializeListQuery (the one wire codec)
│     │  └─ relative.ts            relative presets → absolute bounds (ADR-040)
│     ├─ warmth.ts                 computeWarmth, WARMTH_K
│     ├─ identity/                 email.ts phone.ts linkedin.ts website.ts duplicates.ts
│     ├─ followups/recurrence.ts   followups/state.ts
│     ├─ import/                   synonyms.ts automap.ts value-mapping.ts validate.ts
│     │                            date-format.ts presets/{generic,linkedin,google,vcard}.ts
│     ├─ contracts/                request/response Zod schemas — the API contract
│     └─ index.ts
│
├─ packages/db/                    @mutuals/db — Kysely, snake_case end to end
│  ├─ migrations/
│  │  ├─ 0001_extensions_and_workspace.sql
│  │  ├─ 0002_records_attributes_facts.sql
│  │  ├─ 0003_projector_and_triggers.sql
│  │  ├─ 0004_metrics_search_views.sql
│  │  ├─ 0005_import_batch_and_rows.sql
│  │  └─ 0006_llm_call_and_llm_setting.sql
│  └─ src/
│     ├─ schema.ts                 the hand-maintained Kysely DB interface (ADR-027)
│     ├─ client.ts                 pool, planner GUCs, makeDb()
│     ├─ migrate.ts                Migrator + SqlFileMigrationProvider; assertSchemaCurrent
│     ├─ filter/compile.ts         THE filter→SQL compiler (ADR-033)
│     ├─ filter/sort.ts
│     ├─ repositories/             records, attributes, interactions, follow-ups, views, imports
│     ├─ write/                    the §4.1/§4.2/§4.3 write path; the bulk COPY path
│     ├─ reproject.ts              pnpm db:reproject + the per-record digest map
│     ├─ seed/                     baseline.sql + seed.ts (~200/60/500/40)
│     └─ test-support/             resetDatabase, template clone, worker guards
│
├─ apps/api/                       @mutuals/api
│  └─ src/
│     ├─ main.ts  app.ts  env.ts   Zod-validated env, fails fast at boot
│     ├─ routes/                   contacts organizations interactions follow-ups
│     │                            attribute-definitions views import-batches search
│     │                            ask quick-capture stats profile
│     ├─ routes/operations.ts      the operationId list; CI asserts route ↔ list parity
│     ├─ plugins/                  problem-json error handler, auth slot, openapi, static
│     ├─ jobs/                     port, registry, SCHEDULES, InlineQueue, PgBossQueue [S5]
│     ├─ llm/                      provider port, transport, prompts/, trace, budget [S6]
│     ├─ import/                   CSV/XLSX/vCard byte handling [S5]
│     └─ integrations/             fetchSince(cursor) interface + sync_state stub
│
├─ apps/web/                       @mutuals/web
│  ├─ index.html  vite.config.ts  components.json
│  └─ src/
│     ├─ main.tsx  router.tsx  styles/globals.css
│     ├─ ui/                       shadcn primitives (ADR-050)
│     ├─ table/                    TableShell RecordTable useRecordColumns FilterBar ColumnsMenu
│     ├─ attributes/               AttributeCell AttributeInput + the two registries
│     ├─ features/                 dashboard records organizations interactions follow-ups
│     │                            attributes-settings views import search
│     ├─ routes/                   thin composition roots
│     └─ lib/api.ts                the ~40-line typed fetch wrapper over @mutuals/core schemas
│
├─ apps/worker/                    [S5] 15 lines: the standalone job runner
└─ e2e/                            [S2] @mutuals/e2e — playwright.config.ts + specs/
```

---

## 13. Risks — honest, ranked, each with what would falsify the decision

**R1 — Every performance number in this design is an extrapolation.** No Postgres existed in the
environment where the storage decision was written, and the same is true of every frontend frame-time
figure. _Falsifier:_ Stage 1's 10k-contact × 60-attribute generator plus `EXPLAIN (ANALYZE, BUFFERS)`
for each of the nine operator shapes. If a three-chip filtered page is not in single-digit
milliseconds, or if the `ORDER BY` on a custom attribute spills `work_mem`, the escape hatch is the
two-phase index-ordered pagination in `storage-DECISION.md` §9.4 — a **query** change, not a schema
change, which is the whole reason the typed table exists. _This is the largest remaining unknown and
it was the largest unknown in all four storage proposals._

**R2 — `kysely-codegen` may not run against this schema at all.** It is untested against
`kysely@0.29.x` and stale since February. _Falsifier:_ a 30-minute Stage-0 spike — apply migration
`0002` (composite FK, `NULLS NOT DISTINCT`, partial unique index, mixed-opclass GIN, generated
tsvector) to a real database and run the generator. _Impact if it fails:_ none to the architecture,
because ADR-027 already made the hand-written `schema.ts` the plan and the tool merely a bootstrap.
What weakens is the _argument_ for Kysely over Drizzle: "drift is impossible by construction" becomes
"drift fails a test", which is a materially weaker claim and is stated as such in ADR-027.

**R3 — The projection can silently diverge from the fact log.** The entire safety case for keeping a
derived copy is that a full rebuild reproduces it. _Falsifier:_ the per-record digest gate (ADR-025).
If it ever trips for a reason other than a known bug, the answer is to make the projector the only
writer — the `AFTER STATEMENT` trigger already exists as the backstop, and the bulk path's GUC bypass
is the one hole; a forgotten bypass is caught by the gate rather than by a user.

**R4 — Attribute values are not typed end-to-end, and cannot be.** Kysely knows `attribute_value`, not
`check_size`. Runtime typing comes from Zod schemas built from `attribute_definition`. §3.2's "typed
end-to-end" is true for the envelope and false for user attribute values. This is a limitation of any
dynamic-attribute design; it is named rather than implied away. _Falsifier:_ none — it is structural.

**R5 — A 10k-row import is the peak write event and it is the least-tested path.** ~150k facts,
~150k value rows, ~300k composite-FK parent probes, one `COPY`, one set-based projection, and the
duplicate probe for every identifier. _Falsifier:_ the Stage-5 acceptance test — import the LinkedIn
fixture twice and assert zero duplicate values, exactly one live fact per single-valued attribute, and
a recorded wall-clock in `ARCHITECTURE.md`. If it exceeds ~60 s, the documented fix is dropping and
rebuilding `av_trgm_idx` around the batch.

**R6 — `mutuals_norm()` depends on the `unaccent` dictionary staying put.** It is a `STABLE` function
used in `WHERE` clauses and by the projector, never in an index definition, so an `IMMUTABLE`-marking
hazard does not exist — but if someone edits `unaccent.rules` on the host, stored `text_norm` values
and new needles disagree. _Falsifier:_ `pnpm db:reproject` after any extension change; the equivalence
gate would catch a mid-flight edit. If `unaccent` is unavailable at all, `mutuals_norm` degrades to
`lower(btrim($1))` — one line, then a reproject, losing only accent-insensitivity.

**R7 — pg-boss is maintained by one person, and pooler safety is unmeasured.** _Falsifier:_ the
Stage-5 lifecycle test against a Supabase transaction-pooler connection string. **Still open after
Stage 5, deliberately (ADR-095):** the test is written and skips unless `POOLER_DATABASE_URL` is
set, and no managed instance exists yet. Closing it is one environment variable, not a research task.
_Mitigation already in place:_ the `JobQueue` port is three methods and one adapter file;
`DROP SCHEMA pgboss CASCADE` is a complete uninstall; Graphile Worker is named in
`ARCHITECTURE.md`.

**R8 — `strict: true` on structured outputs is a hint, and compliance varies by upstream provider for
the same model.** _Falsifier:_ the repair rate per prompt version, which is a `SELECT` against
`llm_call`. _Mitigation:_ always re-validate, `require_parameters: true`, one repair, and a CI walker
that now actually visits nullable objects (ADR-066).

**R9 — TanStack Table v9 is one month old (9.0.0 shipped 2026-08-04).** It is pinned because shadcn's
mandated data-table pattern is written against it, so the "boring" choice and the "current" choice
point the same way here — but the ecosystem around it is young. _Falsifier:_ Stage 2. If v9's feature
gating or `columnMeta` slot behaves differently than documented, the fallback is v8 plus a hand-ported
shadcn data-table, which costs about a day and no architecture.

**R10 — Node type stripping constrains what the code may contain, forever.** No `enum`, no parameter
properties, relative imports written with `.ts`. _Falsifier:_ a dependency that ships non-erasable
syntax in a workspace package, or a contributor who wants `tsx`. _Escape:_ ADR-008's esbuild bundle
already exists; extending it to the dev loop is a script change.

**R11 — The trace table holds user text in a second place.** Acceptable for a private single-user CRM
(the brief: "data privacy is not a design driver right now"), and `LLM_TRACE_BODIES=off` exists for
anyone who disagrees. It is not a security boundary and is not claimed to be one.

**R12 — Cron only fires while the process runs.** Structural for a laptop-hosted app. The boot
catch-up (ADR-060) is the mitigation, and it is Q6 below because it is a product behaviour, not an
implementation detail.

**R13 — Two people, no external reviewers, and a repo future AI sessions will edit.** The mitigations
that matter are mechanical, not documentary: the ESLint boundaries (ADR-009, ADR-071), the
`SLOT_COLUMNS` grep test, the `operations.ts` parity assertion, the `information_schema` drift test,
the projection equivalence gate, and `AttributeType` being _derived_ so a missing case is a compile
error. Every one of those exists because prose rules in a markdown table get broken about half the
time — as one of the rejected proposals demonstrated by breaking its own rule inside its own document.

---

## 14. Questions that genuinely need a human

Everything the brief already decided is not here, and everything I could decide myself I did.

### Already answered — recorded here so the answers are not lost

**Q1 — Working directory (Simon). ANSWERED 2026-09-03.** The project lives in
`/Users/simonfuhrbach/code/crm` on the branch `version/claude-v1`. The earlier German Next.js +
SQLite prototype stays on `main`, untouched and still runnable. Simon's instruction was explicit:
_"lass den code in main liegen (ignoriere den auch mal komplett) und schreib alles von null neu"_ —
so nothing is ported from `main`, not code, not fixtures, not data. The branch was cleared of the old
tree in the same commit that added these documents. The untracked local SQLite database in `data/`
was deliberately left in place and is not referenced by anything in this branch.

**Q1b — Old data (Simon). ANSWERED 2026-09-03.** The ~1,128 contacts in the old prototype's local
database are **not** migrated. Simon: _"lass die importe erstmal weg. es geht nicht um importe."_
The Stage 5 import wizard is still built, because the brief specifies it; it simply has no
old-database source. No one-off SQLite→Postgres migration is planned.

**Q1c — `asks` / `offers` shape (Simon). ANSWERED 2026-09-03.** They stay `tags`-typed attributes
exactly as §4.1 specifies, rather than becoming a first-class object with an explicit resolution
state. Simon's added requirement: **always carry the date.** That is already free — every tag element
is a `fact` with `valid_from` and `observed_at`, and removing a tag writes a superseding fact rather
than deleting history, so "asking since June 2025" and "stopped asking in March 2026" are both
recorded and rendered in the history popover (§4.5). The `asks`/`offers` cells therefore show the
since-date inline, not only on hover — a small addition to `AttributeCell` for these two attributes,
noted in the Stage 2 scope. The stricter alternative (a first-class Ask object with `resolved_at`)
was considered and rejected as over-engineering for Phase 1; §9's intro-suggestion rule
("only on an ask↔offer match") can read staleness from the fact log when that feature is built.

**Q2 — Postgres major (co-founder). WITHDRAWN 2026-09-03.** The deviation is no longer proposed. See
ADR-002: Docker Desktop is now installed and `pgvector/pgvector:pg16` was verified working, so the
repo ships Postgres 16 exactly as §3.1 fixes it.

### Asked, and how each was settled

Every one of these is answered except **Q7**, which is not needed until the LLM layer of Stage 6.

**Q3 — "No interaction in 90 days" (Simon). ANSWERED — see ADR-086.** §6.2 seeds that view. Does it include people you have
**never** contacted? Options: **(a)** exclude them, and seed a second view `Never contacted`
(recommended — the view means "people who have gone quiet", and the second list is arguably the more
actionable of the two); (b) include them, at the cost of a freshly imported 10k-row LinkedIn export
filling the view on day one. The compiler must pick one; it cannot be a per-chip toggle, because the
filter model is AND-only by design.

**Q4 — Import review grid: what is pre-selected for a near-certain duplicate (Simon). Answered 2026-09-04.** None of the three options as written. Simon asked for the row to be flagged and the user _told_: "this looks like a contact you already have — do you really want to import it?", with **not importing** as the default. So it is option (a)'s behaviour — re-importing the same export stays a no-op and nothing is silently overwritten — but stated as a question rather than as a silent skip, so the person sees why the row did not land. Stage 5 builds it that way.

**Q5 — Dark mode in Phase 1 (Simon). ANSWERED 2026-09-03 — both ship.** The recommendation below was
"tokens now, toggle in Stage 7"; Simon overrode it and asked for both modes with a three-state
switcher (light / dark / system, following the OS live). Built in Stage 2, which is also why
`apps/web/src/styles/contrast.test.ts` exists — it found a grey that was unreadable on grey. This
supersedes ADR-056's "dark tokens ship but there is no toggle". _Original wording:_ §5.1 does not
mention it; the tokens cost nothing and a tested toggle is about half a day.

**Q6 — Overnight jobs on a laptop (Simon). Answered 2026-09-04 — ADR-093.** He chose (a), run it
at startup when stale, on the condition that it is cheap. It is: 27 ms for the 156 contacts of
10,000 whose warmth can still move, and 0 ms when nothing is stale. It runs after the API is already
serving, so it delays no request.

**Q7 — LLM spending cap (Simon).** `LLM_DAILY_COST_LIMIT_USD` defaults to **$2.00/day**, enforced
before every request to the model provider; past it, AI features return a clear "daily limit reached"
message and everything else keeps working. Confirm the number, or name a different one. `0` disables
the cap entirely, which I do not recommend for a key that lives in a `.env` on a laptop.

_(One item is not a question but needs an acknowledgement: ADR-045 adds `phone_region` and `time_zone`
to the Profile in §6.6. Both are needed — phone numbers like `089 1234567` cannot be normalised
without a region, and warmth cannot decay on whole civil days without a timezone. `docs/BRIEF.md` is
updated in the same PR, per §2.1.)_

---

## 15. Stage 1 addenda — decisions the build itself forced

Three of the four questions §14 left open were answered by measurement rather than by discussion.
Each is a full ADR; they are numbered on from 083.

### ADR-084 — Five indexes behind foreign keys, because deletion was 4 seconds

**Context.** `pnpm db:check` generated 10,000 contacts × 60 attributes and measured every operator
shape. Every read was between 0.09 ms and 10.7 ms, comfortably inside the extrapolations §13 warned
were unverified. One shape was not: **deleting a single contact took 4.0 seconds**, and bulk deletion
was quadratic. Postgres indexes the _referenced_ side of a foreign key automatically, because it is a
primary key, but never the _referencing_ side — so every `ON DELETE CASCADE` and `ON DELETE SET NULL`
sequentially scanned a large table to find the rows it was about to touch. The performance harness had
been silently creating four such indexes for itself, purely so it could clean up after its own run;
that workaround is what exposed the gap.

**Options.** (1) Leave it: a personal CRM deletes rarely. (2) Index the four cascade paths.
(3) Index every unindexed referencing column.

**Choice.** Option 2, plus a fifth the record-deletion measurement could not see. Migration 0007 adds
`fact (superseded_by_id) WHERE NOT NULL`, `fact (target_record_id) WHERE NOT NULL`,
`attribute_value (fact_id)`, `record_link (fact_id)` and `fact (attribute_id)`.

**Consequences.** Deleting one contact went from **4.0 s to 1.03 ms**, re-measured on the same
dataset. The fifth index covers a different operation entirely: `fact_shape_fk` references
`attribute_definition`, and every index on `fact` leads with `record_id`, so **deleting an attribute
definition** — §6.7's flow, behind a dialog that promises to state how many records are affected —
scanned the whole fact log. `attribute_value` needed no equivalent because ADR-013 already leads all
nine of its indexes with `attribute_id`. Option 3 was rejected: the remaining unindexed referencing
columns are `workspace_id` (whose parent row is never deleted) and `option_id` (whose parent is
`ON DELETE RESTRICT` and archived rather than deleted, per ADR-016), so indexing them would cost write
throughput to speed up something that does not happen. `MISSING_FK_INDEXES` stays in the harness as an
empty seam, so a future finding can be reproduced by putting an index back before it becomes a
migration.

### ADR-085 — A plausibility predicate on the identifier write-through

**Context.** Found by the integration suite, not by reading the SQL. The projector's step 3 wrote
every `email`, `phone`, `linkedin_url` and `website` value into `identifier`, valid or not.
`identifier` is exactly what duplicate detection probes, and ADR-042 scores a shared identifier of
those kinds at 0.95 or above — so two contacts whose email field said `n/a` became identifier twins
scoring 0.97, landing in the `certain` band, the one band whose entire purpose is that it needs no
human judgement. The TypeScript write-through already declined such values; the SQL projector did not,
and the two disagreed.

**Options.** (1) Stop the projector writing identifiers and let `writeIdentifiers` own it — which
loses identifiers for any write that bypasses the application (raw psql, the bulk importer, a future
MCP client). (2) A plausibility predicate in SQL. (3) Leave it and filter at read time in the
duplicate matcher.

**Choice.** Option 2. Migration 0008 adds `mutuals_identifier_plausible(kind, value)` and ANDs it into
step 3, then deletes the rows the earlier behaviour had already written.

**Consequences.** This does **not** violate ADR-019's one-normaliser rule, and the distinction is the
whole reason the option is acceptable: the predicate decides only whether a value is an _identity
claim at all_, never what its canonical form is. Normalisation remains SQL-only and singular. It is
deliberately permissive — an email needs an `@` and a dot after it, a phone seven digits, a LinkedIn
handle the canonical `in/…` shape, a website a dot and a TLD — because real validation lives in
`packages/core` and runs on every path that matters, while this guard exists only for the paths that
bypass it. Verified against the live database: `n/a`, `-`, `none`, `not available`, `123` and `tbd`
are all refused, and `anna@northstar.vc`, `+4989123456789`, `in/anna-berger` and `northstar.vc` are
all accepted. Option 3 was rejected because it leaves the wrong data in the table and obliges every
future reader to remember the filter.

### ADR-086 — "No interaction in 90 days" and "Never contacted" are two views (answers Q3)

**Context.** §14's Q3 asked whether the seeded view includes people never contacted. The filter model
is AND-only by design (ADR-032), so one view cannot express "last interaction older than 90 days OR
no interaction at all" — `last_interaction_at` is NULL for someone never contacted, and
`older_than` compiles to `column < cutoff`, which NULL fails.

**Options.** (1) One view that silently means only "gone quiet". (2) Two views. (3) Add an OR group,
or a dedicated `is_stale` operator, to the filter model.

**Choice.** Option 2. `No interaction in 90 days` keeps the literal reading; `Never contacted` is
seeded beside it, filtered on `last_interaction_at is_empty` and sorted by most recently added.

**Consequences.** Both views now mean exactly what their names say, which option 1 could not claim.
`Never contacted` is arguably the more actionable of the pair: a freshly imported 10,000-row LinkedIn
export lands entirely in it rather than swamping the other one. Option 3 was rejected as a wire-format
change made to serve a seed script — if an OR group is ever wanted it should be wanted for its own
reasons. The seed's count assertion caught this change immediately when the expected view count was
still 4, which is the assertion working as designed.

### ADR-087 — The e2e database gets its own guard, and the reset stays one implementation

**Context.** ADR-079 says the Playwright run is "seeded from the same `resetDatabase()` the Vitest
projects use". Building it revealed that it cannot literally call that function. `resetDatabase`
reaches its database through `TEST_DATABASE_URL`, past `assertSafeTestDatabase`, which requires a
name ending in `_test` — and `database.test.ts` has asserted since Stage 1 that it **refuses**
`mutuals_e2e`, by name, as a deliberate case. It then clones per Vitest worker via `VITEST_POOL_ID`.
None of those three things exist under Playwright.

**Options.** (1) Widen the guard to accept `_e2e` as well, and flip the test that says it must not.
(2) Give Playwright its own truncate-and-restore. (3) Keep one reset, add a second narrow guard.

**Choice.** Option 3. `applyReset(db, truncate, baseline)` is extracted from `resetDatabase` and is
now the single implementation both suites call; `packages/db/src/test-support/e2e.ts` supplies the
connection and the guard around it. `assertSafeTestDatabase` and `assertSafeE2eDatabase` are two
narrow predicates over one parameterised check, and each refuses the other's database.

**Consequences.** Option 1 was the small diff and the wrong one: a single predicate accepting both
suffixes turns a mistyped variable into a silent cross-suite truncate, which is the exact failure the
`_test` guard exists to prevent. Option 2 would have satisfied ADR-079's letter and broken its
intent — what that ADR protects is that "reset" means the same thing in both suites, and a second
copy is how that stops being true. The Stage-1 test asserting `mutuals_e2e` is refused is unchanged
and still passing; nine new cases assert the e2e guard refuses `_dev`, `_test`, a worker clone, a
near-miss name and a remote host.

There is one wrinkle the Vitest path does not have. `captureBaseline` refuses to read a baseline off
a database that has been written to, and Vitest reads it from a template nothing ever writes to. The
e2e database has no template, so `globalSetup` resets it with the _previous_ run's snapshot before
capturing a new one. First run: no snapshot, and a freshly migrated database is already clean.
Falsifier: delete the snapshot from `tmpdir` while the e2e database holds rows, and the run fails
with `UnexpectedBaselineRowsError` rather than silently baking test data into the baseline. That is
the right failure, but it is a failure — recreate the database if it happens.

### ADR-088 — `verify:e2e`, and two corrections to ADR-082 it forced

**Context.** ADR-082 specified `verify:e2e` as "build, migrate `mutuals_e2e`, Playwright", and stated
in its consequences that `pnpm build` runs before e2e "because the e2e `webServer` previews a build
output the script previously never produced". Implementing it found that sentence to be aspirational:
the root `build` script was `pnpm --filter @mutuals/api build` and nothing else, so **CI had never
once built the SPA**, and `vite preview` would have served an empty directory.

**Options.** (1) Have the `webServer` command build, so the config is self-contained. (2) Fix the
root script so `pnpm build` means what ADR-082 says it means.

**Choice.** Option 2, plus a `globalSetup` assertion. `build` is now API **and** web, which also puts
the SPA build into `verify:static` and therefore into the CI job that has been silently skipping it.
`globalSetup` fails with an actionable sentence if `apps/web/dist/index.html` is missing rather than
letting nine specs time out against a blank page.

The second correction: `vite.config.ts` had `server.proxy` but no `preview.proxy`. ADR-011 rules out
CORS, so a previewed SPA had no route to Fastify at all and every spec would have failed on its first
`/api` call. `preview` now proxies, binds `127.0.0.1` explicitly — `localhost` resolves to `::1` here
and Playwright polls `127.0.0.1`, which cost one debugging round — and takes its ports from the
environment.

**Consequences.** An ADR describing a fix in the past tense is worse than one describing it in the
future tense, because nobody re-reads it to check. Both statements in ADR-082 are true now. The
e2e servers run on **3200/3201**, not 3000/3001, and `reuseExistingServer` is `false`: a developer
with `pnpm dev` running would otherwise have Playwright adopt those servers and drive the suite —
truncating between every test — against `mutuals_dev`.

### ADR-089 — Stage 2 ships inside PR #1, retitled, and PR #1 is still not merged

**Context.** §8.2 asks for one PR per stage. PR #1's head branch is `version/claude-v1`, which is the
working branch, so the four Stage 2 commits had already flowed into it before anyone noticed: the PR
titled "Stage 1 — Foundation" in fact contained Stage 1 and three quarters of Stage 2. GitHub allows
one open PR per head/base pair, so `docs/HANDOFF.md`'s instruction to "open the Stage 2 PR against
`main`" was not executable.

**Options.** (1) A stacked PR #2 from a new branch, based on `version/claude-v1`. (2) Let PR #1 grow
and retitle it. (3) Repoint PR #1 at a Stage-1-only branch, then open PR #2 for all of Stage 2.

**Choice.** Option 2, chosen by Simon on 2026-09-04 after the three were put to him.

**Consequences.** One review of fifteen commits instead of two smaller ones — the cost he accepted to
avoid Stage 2 being split across two PRs. **PR #1 is still never merged**: that instruction was about
the divergence from `main`, which is untouched and is revisited at Stage 7. Retitling and rewriting
the body is not merging. `docs/HANDOFF.md`'s "next step, verbatim" is corrected in this stage, because
a fresh session following it would otherwise try to open a PR that cannot exist.

### ADR-090 — Value history is one route on the record supertype, not one per object type

**Context.** §4.5's history popover asks the same question of a contact, an organization and of
anything a later stage adds: what did this field used to say, and who said so. `valueHistory()` had
existed in `packages/db` since Stage 1 with no HTTP route in front of it.

**Options.** (1) `GET /contacts/:id/history/:attributeId` and an organization twin, two operation
names. (2) One route on the supertype. (3) Widen `GET /contacts/:id` to embed history eagerly.

**Choice.** Option 2: `GET /records/:id/history/:attributeId`, operation `getValueHistory`. `record`
is a supertype with one id space (ADR-015), which is exactly what makes one route correct here — and
the 404 names the object type it _did_ find, because an id valid for a different kind of record is
the mistake a caller actually makes.

**Consequences.** Option 1 would have produced `getContactValueHistory` and
`getOrganizationValueHistory` differing only in the word in the middle, and a third the day
interactions get a detail page. Option 3 was rejected outright: a contact page shows twenty-odd
attributes and almost nobody opens any of their histories, so eager loading multiplies every page
view by twenty for a click that usually does not happen. The popover fetches when opened.

The wire shape carries a rendered `AttributeValue`, not the slot it came from. That keeps the
contract clear of the physical columns CLAUDE.md confines to one file, and it means the client draws
history with the same `AttributeCell` it draws the live value with — a superseded option is the same
chip it was when it was current. `serializeHistoryValue` reuses `valueOf`, so there is no second
rendering of a typed value to drift.

Two columns were added to the underlying query while doing this: the option key, and the four
`link_*` columns. Without them a relation's history could say the organization changed but not that
the job title had, which is most of what a work history is.

### ADR-091 — The browser's clock is `DisplayProvider`; the e2e clock is Playwright's

**Context.** `now`, `today` and `timeZone` are injected parameters everywhere in the domain and
nothing there reads the wall clock (ADR-081). The browser had no stated equivalent, and Stage 2 left
a `fixme` spec whose date assertions could not be exact without one.

**Options.** (1) Ship `now` from the API in a response field. (2) A test-only query parameter or
global the e2e run sets. (3) Name what already exists as the rule, and use Playwright's own clock.

**Choice.** Option 3. `ambientDisplay()` in `display-context.tsx` is the **single** place the browser
reads the wall clock; it refreshes once a minute and every formatter takes `today` as a parameter.
`DisplayProvider` is the injection point, and its `overrides` already say they exist for "a test that
pins `today`". For end-to-end determinism the suite uses `page.clock.setFixedTime()`, which freezes
`Date` inside the browser and therefore freezes `ambientDisplay()` without the application knowing.

**Consequences.** Option 2 is a test door in production code, which ADR-079 already refused once for
the database reset; refusing it again for the clock is the same argument.

**Corrected in Stage 4, by a test that failed.** The paragraph above said Playwright's clock gives
"end-to-end determinism". It does not: `page.clock` freezes `Date` **inside the browser** and the API
keeps its own. So anything the server derives — a follow-up's `state`, the date of the next
occurrence a recurring follow-up spawns — is still computed against the server's real today, and a
spec that pins the browser clock and then asserts a literal server-derived date is asserting what day
the machine thinks it is. `page.clock` makes _rendering_ deterministic and nothing else. The
follow-up spec now asserts the promise §4.1 actually makes — the series continues, one done and one
open, the open one later — rather than a date. Pinning the server's clock too would need the test
door this ADR exists to refuse. Option 1 couples rendering
a relative date to a round trip and still would not make a test deterministic. The rule this ADR
states, and which review should enforce: **anything the domain decides — warmth, whether a follow-up
is overdue, when the next occurrence falls — is computed server-side against the injected clock and
travels as data. The browser may read the clock to say "3 weeks ago" and for nothing else.**

Falsifier, and it was run rather than asserted — the first draft of this paragraph said "four
places" and there are seven. `grep -rn "new Date()\|Date\.now()" apps/web/src` should return exactly:

| Where                                                    | Why it is allowed                                                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attributes/display-context.tsx`                         | `ambientDisplay()` itself — the one read this ADR is about                                                                                                                            |
| `features/interactions/interaction-dialog.tsx` ×2        | Defaulting a `datetime-local` to now, and converting one back                                                                                                                         |
| `features/records/record-table.tsx`                      | A CSV filename                                                                                                                                                                        |
| `features/attributes-settings/list/attributes-table.tsx` | The same CSV filename helper                                                                                                                                                          |
| `features/attributes-settings/editor/draft.ts`           | A uniqueness suffix, not a time                                                                                                                                                       |
| `routes/index.tsx`                                       | "Good morning" — deliberately the reader's own clock, not the profile's timezone, because whether it is morning depends on where the reader is sitting and not on a workspace setting |

An eighth is a domain decision that has leaked into the client.

### ADR-092 — Derived columns are recomputed on write, scoped to the records that moved

**Context.** `contact_metrics` was written in two places: zeroed when a contact is created, and
recomputed for the whole workspace by `recomputeMetrics()` from the seed. Nothing recomputed it when
an interaction was logged. Stage 3 built §6.5's Relationship card on those columns and the e2e spec
for §8.1's third flow caught it immediately: log a meeting, and the card still reads zero.

**Options.** (1) Leave it to the nightly sweep of Stage 4. (2) A database trigger on
`interaction_contact`. (3) Recompute in the write path, scoped to the participants.

**Choice.** Option 3. `recomputeMetrics` gained an optional `scope`, so the seed and the eventual
sweep still call the one implementation unscoped, and the three interaction routes call it with just
the contacts and organizations involved. An edit passes the participants from _before_ the change as
well as after: moving an interaction from one person to another has to take the count off the first.

**Consequences.** Option 1 would have shipped a card that is always zero until a seed runs, which is
worse than no card. Option 2 puts warmth in SQL, and ADR-022 makes `computeWarmth()` in TypeScript
the only implementation precisely so that no SQL twin exists to drift from it — a trigger would have
had to either call out to TypeScript or become that twin.

The scope is the point, not an optimisation detail. Recomputing 10,000 contacts to move one person's
warmth is the same shape of mistake as the missing cascade indexes that made deleting a contact take
four seconds in Stage 1. A scoped run also deliberately does **not** stamp `workspace.metrics_swept_at`,
so Stage 4's nightly job cannot mistake one logged call for a sweep.

### ADR-093 — Warmth catches up at startup when it is stale, scoped to what can move (answers Q6)

**Context.** §14's Q6: the nightly warmth sweep is scheduled for 03:30 and the laptop is usually shut
then. Put to Simon on 2026-09-04, he chose "at startup when stale" **conditional on it being cheap** —
his words: "ich hab angst dass die app langsam wird". That condition is the decision.

**Options.** (a) On startup if the last sweep is more than 20 hours old. (b) On every startup.
(c) Only on the schedule, and accept staleness.

**Choice.** (a), scoped, and **after `listen`** so the API is already serving before it begins. A slow
sweep can therefore delay nothing; the worst case is warmth that is briefly a few hours out of date.

**Why it is cheap enough to be allowed.** Warmth changes on its own only where `computeWarmth` would
return something different tomorrow, and its only time-dependent input is decay on interactions
inside the window. A contact at 0 with nothing in the window is at a fixed point. So the sweep
touches "warmth is not already at rest, **or** there is an interaction still in the window".

Measured on this machine, 10,000 contacts × 60 attributes:

|                                        |                                   |
| -------------------------------------- | --------------------------------- |
| Movable contacts                       | **156** of 10,200                 |
| Sweep when stale                       | **27 ms**                         |
| Sweep when already fresh               | **0 ms** (one predicate, no work) |
| Recomputing all 10,200, for comparison | 396 ms                            |

**This is not the shortcut ADR-022 warns about.** That warning — written into `recomputeMetrics`'s own
docstring — is about a contact who goes quiet keeping last year's warmth for ever. Such a contact has
`warmth > 0`, so this predicate keeps recomputing them every day until they reach 0, which is the
correct resting value. What is skipped is only contacts already at it.

**Consequences.** The window is `WARMTH_WINDOW_DAYS + 1`: on the day a contact's last interaction
falls out of the window their score becomes 0, and a boundary excluding them that morning would
freeze them at yesterday's number. A failed sweep is logged at `warn` and swallowed — warmth a few
hours stale is a better day than an API that would not start. Option (b) was rejected on Simon's own
grounds: the app is opened many times a day and nine of those ten openings would do nothing but
work. Stage 4's scheduled sweep, when it exists, calls the same function unscoped.

### ADR-094 — Saved views, built: what ADR-048 left open, and one wrinkle it did not foresee

**Context.** ADR-048 settled the semantics in Stage 2 — the URL is the working copy, a view is a
named snapshot, dirty is deep equality over the canonical `(filters, sort, columns)` triple — and
Stage 4 had to build it. Most of the machinery was already there: `ViewSnapshot`,
`canonicalViewSnapshot` and `viewSnapshotsEqual` in `packages/core`, `retainSearchParams(['view'])`
on both list routes, the `saved_view` table with `sv_default_uq`, and the four operation names
reserved in `PLANNED_OPERATIONS`. The decisions left were smaller and are recorded here.

**What the snapshot is taken from.** Not `query.columns`. The URL omits `columns` entirely while the
table shows its defaults, so a snapshot read straight from the URL saves `null` — a view with no
columns — and then compares unequal to itself the moment the parameter becomes explicit.
`useViewState` takes the _effective_ columns, which is what the table is actually rendering. The
first version did not, and the e2e spec caught it as "a view is dirty the instant you save it".

**Where the view's name comes from in the breadcrumb.** A route loader returning `{ crumb }`, the
mechanism Stage 3 added for record detail pages, rather than a second one. Two consequences worth
knowing: it is `fetchQuery` and not `ensureQueryData`, because a view saved a moment ago has just
invalidated that key and the crumb must name it rather than the list from before it existed; and
every view mutation calls `router.invalidate()`, because the router caches loader data per
navigation and a rename would otherwise leave the old name in the crumb until the next click.

**Where the `⋮` items are built.** In `features/views`, passed into `table/data-table.tsx` through a
slot. The alternative was the generic table importing a saved-view hook, which is how a shared
component stops being shared. It keeps the three disabled placeholders when no slot is passed, so
the menu does not change shape between a page with views and one without.

**The wrinkle ADR-048 did not foresee.** Hiding a column and then showing it again does **not**
restore its position — the Columns menu appends a re-shown column to the end. That is defensible on
its own, but it interacts badly with views: a hide/show cycle leaves the view permanently dirty even
though the user has visibly undone their change. Left as it is for now, because changing where a
column reappears is a table-behaviour decision that belongs with §5.2's drag-reordering rather than
with views, and Simon has approved how the table behaves. Recorded so the next person meets it as a
known thing rather than a bug. The e2e spec therefore demonstrates canonical-vs-string dirtiness
with a filter, which is genuinely reversible, and additionally asserts that **searching does not
dirty a view** — `q` is not one of the three things a view stores.

**Consequences.** The management screen at Settings → Table views can rename, set the default and
delete, but deliberately cannot edit a view's filters or columns: the table is the only place a
snapshot is composed, and a second editor would be a second definition of what a view is. The
migration's comment describing `saved_view.columns` as `[{slug, width?}]` has never matched the
implementation, which stores plain slugs; an applied migration is not edited, so it is corrected
here instead.

---

## 16. Stage 5 scope decisions — settled before the build

Four decisions the Stage 5 handover left open or got wrong. Unlike §15's, none of these were forced
by a measurement: three are Simon's answers to questions put to him on 2026-09-04, and the fourth is
a correction to the acceptance test that reading the fixture produced. They are recorded before the
build rather than after it because the handover's verbatim prompt is the only thing that crosses a
session gap, and all four change what that prompt has to say.

### ADR-095 — The pooler lifecycle test ships gated, and R7 stays open

**Context.** ADR-058 chose pg-boss and claimed it is safe through Supabase's transaction pooler,
reasoning from `pg_advisory_xact_lock()` being transaction-scoped. §13's **R7** names the falsifier
precisely: a Stage-5 lifecycle test against a transaction-pooler connection string. No such string
exists. `.env.example` carries three local databases and nothing else, and nothing in the repository
references a managed instance.

**Options.** (1) Simon creates a free Supabase project now and the test runs for real. (2) The test
ships gated on an environment variable and skips when it is absent; R7 stays open. (3) Delete the
planned test and accept ADR-058's reasoning.

**Choice.** Option 2 (Simon, 2026-09-04). `POOLER_DATABASE_URL`, optional and unset by default,
commented out in `.env.example`. The lifecycle test skips with a message naming the variable.

**Consequences.** R7's entry now states that the test exists and what closes it, so the risk is open
with a one-line remedy rather than open with a research task. Writing the test and skipping it is the
whole point: a skipped test with a named reason is visible in every run's output, whereas an absent
test is visible nowhere, and this claim has already survived one stage on reasoning alone. Option 3
was rejected for the same reason — it would mark R7 closed on the evidence of nothing.
`env.test.ts` compares `.env.example` against the schema, so the variable has to be **optional with
no default**, a shape the env schema had not needed until now; a default would silently point the
pooler test at local Postgres and pass vacuously, which is the one outcome worse than skipping.

### ADR-096 — Import formats: CSV and XLSX now, vCard deferred and shown disabled

**Context.** §6.8 step 1 offers four source formats — `Generic CSV/Excel`, `LinkedIn Connections
export`, `Google Contacts CSV`, `Apple Contacts vCard (.vcf)` — and step 2 (**Sheet**) exists solely
to pick a sheet out of a multi-sheet workbook. ADR-054 put parsing on the server. Only CSV fixtures
exist.

**Options.** (1) CSV only; Excel and vCard in a later stage. (2) CSV and XLSX now, vCard later.
(3) All four, and cut Stage 5 into three sessions rather than two.

**Choice.** Option 2 (Simon, 2026-09-04). **`read-excel-file` 9.3.10** for XLSX — not `exceljs`,
which this ADR named before anyone installed it. The vCard entry in the dropdown renders **disabled
with a reason** rather than hidden — the same pattern Stage 2 used for the `Bulk import` menu item
itself, so the menu does not change shape when the format lands.

**Why not exceljs, measured.** It installs **79 packages** and reports six deprecated
subdependencies (`fstream`, `glob@7`, `inflight`, `lodash.isequal`, `rimraf@2`, `uuid@8`). Its nine
direct dependencies include `archiver` — a writer, and we only read — `fast-csv`, which duplicates
the CSV reader `packages/core` already has and tests, and _two_ separate zip libraries (`jszip` and
`unzipper`). `read-excel-file` installs **6 packages**, is MIT, cannot write at all, and its largest
dependency is `fflate`. Seventy-nine packages of transitive surface to unzip some XML is not a
trade this project should make on its own stated terms (§11 pins dependencies and separates verified
from assumed), and the streaming argument this ADR originally rested on does not survive contact
with the numbers: 10k rows of short strings is tens of megabytes, the rows are written to
`import_row` and dropped immediately, and the uploaded file is already in memory by the time
anything parses it.

**Consequences.** Step 2 stops being dead code. It fires only for a workbook with more than one
sheet, so without XLSX it could not be exercised at all, and an untested wizard step is worse than an
absent one. That forces a fixture: `fixtures/contacts_multi_sheet.xlsx`, generated by a committed
script (`fixtures/generate-xlsx.mjs`, using `write-excel-file` as a root devDependency) so the
binary is reproducible rather than opaque — a checked-in workbook nobody can regenerate is a fixture
that cannot be corrected. SheetJS's `xlsx` on npm is deliberately **not** used: recent releases
moved to the maintainers' own CDN and the registry copy is the stale pre-move build; `@e965/xlsx` is
a zero-dependency mirror of the current release but it is a _third-party_ mirror, and who maintains
it is a question this project should not have to answer to read a spreadsheet.

Deferring vCard also defers a real design question rather than only work: a vCard is a stream of
records with repeating typed fields, not a grid, so §6.8's one-card-per-source-column mapping UI has
no obvious meaning for it.

**Two things in `write-excel-file` v4 that look like success when they are not**, both found by
checking the output instead of the return value, and both worth knowing if the fixture is ever
regenerated: it returns a _writer_ object and silently ignores a `filePath` option, so the script
prints its success message and writes nothing; and the per-sheet name property is `sheet`, not
`name` — pass `name` and the sheets come out as "Sheet1", "Sheet2", "Sheet3", which is precisely the
workbook this fixture must not be. `read-excel-file` calls it `sheet` too, so the two agree once you
know.

### ADR-097 — Duplicates inside one batch get a row pointer beside the record pointer

**Context.** Migration 0005 gives `import_row` a `duplicate_of uuid REFERENCES record(id)`, and
`packages/core`'s `CandidatePool` is keyed on `recordId`. Both model exactly one thing: this row
matches a record that already exists. But every collision in
`fixtures/linkedin_connections_sample.csv` is row-against-row **inside the same file**, and the e2e
database is truncated before each spec, so nothing pre-exists. At Review time the earlier row has not
been committed and has no id.

**Options.** (1) Match inside a batch only at commit time, against records created earlier in the
same run; the Review grid shows no chips for them. (2) A nullable `duplicate_of_row` beside
`duplicate_of`, mutually exclusive. (3) Pre-create records at parse time so every row has an id.

**Choice.** Option 2. Migration **0009** adds `duplicate_of_row integer`, a `CHECK` that at most one
of the two pointers is set, and a foreign key on `(batch_id, duplicate_of_row)` back to `import_row`.
Not 0006 — 0006 to 0008 are `llm_call`, the cascade indexes and the identifier plausibility predicate.

Two things the migration adds that this ADR did not originally name. A **`duplicate_of_row <
row_number` check**, so a chain always has a first element: without it two rows can name each other
and "collapse to the first kept row" has no first row to find. And **`duplicate_detail jsonb`**,
holding `{band, confidence, rules, evidence, label}` — because the Review grid is paged and
recomputing the match per page load is 10k probes per scroll. It is the same opaque-blob reasoning as
`import_batch.mapping`: read whole, written whole, never filtered on. What _is_ filtered on is
"does this row have a duplicate at all", and both partial indexes serve that. A third check keeps
`duplicate_detail` from existing without a pointer to explain.

**Consequences.** Option 1 fails the acceptance test on the test's own terms — the chips it asserts
are for pairs that exist only inside the file — and worse, it would mean the _first_ import of a
LinkedIn export silently creates the duplicates the wizard exists to catch. Option 3 inverts the
design: rows would land before the user confirmed, and "nothing is saved before confirmation" is the
promise the Review step is there to keep. The row pointer costs one nullable column and buys a
distinction the UI should be making anyway — _"you already have this contact"_ and _"this file lists
this person twice"_ read differently to a person and deserve different wording.
`matchDuplicates` needs no change: an uncommitted row enters the pool under a synthetic
`row:<n>` id which the caller maps back, and the matcher never dereferences `recordId`.

**The consequence that is not obvious.** Pointing at an uncommitted row makes that row's own decision
load-bearing: if row 1 is skipped, row 2's "duplicate of row 1" is stale, and a naive
implementation imports neither. Resolution is positional and decided here rather than discovered
later — a chain collapses to its **first kept row**, recomputed whenever any decision in the chain
changes. Three rows for one person with the first two skipped means the third lands, not that all
three vanish.

### ADR-098 — Session A owns §6.8 entire; the split in the handover was wrong

**Context.** `docs/HANDOFF.md`'s verbatim prompt splits Stage 5 as "Session A — the wizard and what
lands" and "Session B — duplicates and merge". But §6.8's **step 4 contains duplicate detection**:
the chips, the per-row `Skip` / `Merge into existing` / `Create anyway` choice, and the bulk choice.
The documented split therefore cuts through the middle of one wizard step.

**Options.** (1) Keep the split: Session A ships a Review grid with no duplicate chips, and the
acceptance test stays `fixme` until Session B. (2) Session A owns §6.8 entire, including detection
and display; Session B owns §6.9 merge alone. (3) Three sessions.

**Choice.** Option 2 (Simon, 2026-09-04).

**Consequences.** The acceptance test goes live at the end of Session A rather than Session B, which
is the reason to prefer this: it is the only test that exercises the whole flow, and a stage half
that cannot run its own acceptance test has no gate. Session A grows by the database half of
duplicate matching — identifier probes **batched** per ADR-042, since one probe per identifier per
row is 20k+ round trips on a 10k export, and name candidates through `pg_trgm`. That query is the
missing half of `matchDuplicates`, which until now existed only in `packages/core` and its own unit
test. Session A also absorbs find-or-create for organizations, which nothing in
`packages/db/src/write/` does and which the LinkedIn preset requires in order to link with
`title = Position` and `from = Connected On`. Session B is then §6.9 alone, and the three merge names
stay in `PLANNED_OPERATIONS` through Session A.
**The acceptance test's numbers are wrong, and the handover repeats them.**
`e2e/specs/import-linkedin-csv.spec.ts` says _"the fixture holds two deliberate collisions"_ and
_"The file holds 6 data rows; two pairs collapse to one contact each, so 4 contacts land"_, and
asserts `Rows: 4`. Measured end to end — the real CSV reader, the real auto-mapper, `mutuals_norm`
from Postgres 16 and the real matcher, over an empty workspace:

| row | contact           | duplicate of | band       | confidence | rule                                 |
| --- | ----------------- | ------------ | ---------- | ---------- | ------------------------------------ |
| 2   | Anna Berger       | row 1        | `certain`  | 0.970      | `identifier` — same email            |
| 4   | Bjoern Hakansson  | row 3        | `certain`  | 0.990      | `identifier` — same LinkedIn profile |
| 8   | Marta Nowak       | row 7        | `probable` | 0.880      | `name_exact_org_same`                |
| 10  | J. Weber          | row 9        | `possible` | 0.700      | `name_initial_org_same`              |
| 12  | Ekatarina Volkova | row 11       | `possible` | 0.740      | `name_fuzzy_org_same`                |
| 15  | Lukas Mueller     | row 14       | `possible` | 0.740      | `name_fuzzy_org_same`                |

**31 data rows, not 6. Six pairs, not two. One error row** — `not-an-email` — and therefore **24
contacts land** when every flagged row is skipped, not 4. Every pair is row-against-row inside the
file, which is what ADR-097 exists for. The fixture is markedly better than the test written against
it, and carries four edge cases the comment never mentions: a multiline quoted `Position`, an empty
`First Name`, `not-an-email`, and an empty `Company`. That the system finds exactly the six
collisions its author built is the strongest evidence available that ADR-099's threshold is right.

Two further corrections. The spec reasons that the Håkansson pair is _"a fuzzy match, not an exact
one"_, which is wrong on §4.6's own terms — they share a `linkedin_url` exactly, and the matcher
agrees at 0.990. And the spec assumes the exact duplicate is _"preselected to merge"_, which **Q4
overruled**: nothing is pre-decided, the user is asked, and not importing is the default. The Marta
Nowak pair, built to exercise `emailMatchKey`'s gmail dot-and-plus folding, correctly lands
`probable` rather than `certain`, because that key is a duplicate signal and never a stored
identifier (ADR-042), so the ≥0.95-single-identifier gate caps it. The rewritten test asserts these
numbers.

_An earlier version of this ADR reported five pairs, scored with a bigram stand-in for
`similarity()` rather than with Postgres. Corrected here rather than quietly: the stand-in agreed on
the two identifier pairs and disagreed on every fuzzy one, which is exactly the failure mode that
made pinning the trigram implementation against Postgres worth doing._

### ADR-099 — The fuzzy name threshold is measured, and candidate generation is not the same number

**Context.** `FUZZY_NAME_THRESHOLD = 0.75` had stood in `packages/core` since Stage 1 with no
comment and no justification, used in exactly one place: the `name_fuzzy_org_same` rule. Stage 5
gave it its first real data, because the LinkedIn fixture contains six deliberate collisions and the
system found three of them.

**Options.** (1) Leave 0.75 and record that three of the fixture's collisions are undetectable.
(2) Lower the scoring threshold on measured evidence. (3) Lower it **and** separate the threshold
that generates candidates from the one that scores them.

**Choice.** Option 3. `FUZZY_NAME_THRESHOLD` becomes **0.65**, and a new
`NAME_CANDIDATE_THRESHOLD` of **0.45** governs which records enter the pool at all.

**The measurement.** `mutuals_norm` and `similarity()` on Postgres 16, over the fixture's collisions
and a set of pairs that are deliberately _not_ the same person:

| same person                           |            | different people                |            |
| ------------------------------------- | ---------- | ------------------------------- | ---------- |
| Björn Håkansson / Bjoern Hakansson    | 0.7368     | Rüdiger Weiß / Rudiger Weiss jr | **0.8235** |
| Ekaterina Volkova / Ekatarina Volkova | 0.7143     | Wei Zhang / Wei Zhao            | 0.5833     |
| Lukas Müller / Lukas Mueller          | 0.6875     | Jan Müller / Jan Möller         | 0.5714     |
| Jonas Weber / J. Weber                | **0.5385** | Anna Berger / Anna Bergmann     | 0.5625     |

**Consequences.** Three things follow, and only the first is a tuning decision.

There is an **empty gap between 0.5833 and 0.6875**, so 0.65 admits three true pairs and no new
false one — while 0.75 sat _above_ two collisions the fixture was built to contain. The rule also
requires the same organisation, and its confidence of 0.74 lands in `possible`, where Q4 has the
user asked rather than the row silently skipped. A false positive therefore costs one question and a
miss costs a duplicate contact, which is the failure the wizard exists to prevent.

**No threshold separates these two sets**: the highest similarity in the table is a false positive.
That is not an argument for keeping 0.75 — it is the reason the fallback is a rule table rather than
a score, and the reason `name_exact_org_diff` exists to be scored at 0.30 and never shown.

And the part that was a **bug rather than a setting**: using one number for both jobs made
`name_initial_org_same` unreachable in production. "J. Weber" scores 0.5385 against "Jonas Weber",
so the candidate never entered the pool and `isInitialForm` — which exists for exactly that case,
and is unit-tested — could never run. Core's own tests could not catch it, because they hand
`matchDuplicates` a pool directly; it took the database half existing for the gap to become visible.
Generation now asks "who could this be" and scoring decides, which is what ADR-042 already
described in prose.

This changes matching for the whole product, not only for the import: Session B's merge and Stage
6's quick capture call the same function. That is intended — it is the same improvement — and it is
why the numbers live in a comment beside the constant rather than only here.

### ADR-100 — What building §6.8 settled: the row overlay, and a check that blocked a delete

**Context.** ADR-095 to ADR-099 were decided before the build. Two more had to be made during it,
and both are the kind that only appear once the thing runs.

**`import_row.raw` is `{ cells, edits }`, and `cells` is never written to.** The Review grid edits
values, and the obvious implementation writes the edit where the grid reads it — into `mapped`. That
is wrong twice over. `mapped` is _derived_ from `raw` and is regenerated by every mapping change, so
an edit written there survives until the user goes back to step 3 and then vanishes with no message.
And `revertImportRow` — a name ADR-031 reserved in Stage 1 — has nothing to revert _to_ once the
file's own value has been overwritten. An overlay keyed by column index solves both: reverting is
deleting a key, find-and-replace writes the same overlay, and one code path leads from raw text to a
canonical value whether the text came from the file or from a person fixing a typo.

**Migration 0010 drops `import_row_detail_needs_a_pointer`, added in 0009.** It conflicted with a
constraint that had been there since 0005. `duplicate_of` references `record` with
`ON DELETE SET NULL`, so deleting a contact that a lingering batch had flagged a row against nulls
the pointer — and the new `CHECK` then refused the write. The user-visible failure is a contact that
cannot be deleted, with a message naming a table they have never heard of, because of a batch they
abandoned last week. The check was tidiness rather than an invariant, and being wrong in its
direction is harmless: an orphaned explanation is ignored by the reader, and `toRowDto` renders a
duplicate only when a pointer survives to explain. The two checks that carry weight stay — at most
one pointer kind, and a row pointer that always points backwards so a chain has a first element.

**Consequences.** Four bugs were found by running the thing rather than by reading it, and three of
them were silent. `jsonb_set` creates only the _last_ element of its path, so writing
`{edits, 3}` on a row with no `edits` key returned the row unchanged — no error, and an
`UPDATE … RETURNING` reporting the row as touched. The API test's inline job queue ran the handler
inside the transaction that enqueued it, which real pg-boss cannot do because a worker only ever
sees a committed job; the double was modelling the wrong thing, and the suite took 176 seconds to
fail with "connection terminated" before it took 9 to pass. And `organizationIds` was hard-coded
empty on the record probe, so `sharedOrg` was always false and neither name rule could fire against
an existing contact — re-importing a file found its diacritic and typo pairs _within_ the file and
missed the contacts they had already become, making idempotency quietly weaker than §6.8 requires.
None of these is visible in a diff. All four are now regression-tested.

Two smaller notes, both decided in code and recorded here so they are not rediscovered. The
worksheet a workbook opens on is the one with the most cells rather than the first, because a
workbook's first sheet is very often a `Notes` tab — the fixture is built that way on purpose so the
Sheet step cannot be passed by taking `sheets[0]`. And the Review banner counts duplicates without
naming their kind: a batch can hold both, and on a first import into an empty workspace every one of
them is a repeat inside the file, so "people you already have" would be plainly wrong on the
commonest path. The per-row question says which kind it is; the banner only counts.
