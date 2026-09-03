# DECISION SET: Repository layout, tooling, CI and local-dev story for Mutuals

**Status:** Proposed (Stage 0). Load-bearing for every package, for CI, and for the first thing a
contributor types after `git clone`.
**Scope:** package manager, workspace vs. task runner, package list and dependency direction,
TypeScript configuration, lint/format, CI, the "runs locally with one command" story on a Mac with no
Docker, and where environment variables live.
**Consistent with:** `storage-DECISION.md` (typed EAV over an append-only fact log; drizzle-kit
versioned migrations plus hand-authored SQL; `pnpm db:migrate` / `pnpm db:reproject` / `pnpm seed`;
a CI gate asserting a full reprojection is byte-identical; standing `EXPLAIN` regression assertions).

---

## 0. The decision set in one table

| # | Decision | Choice | Alternative rejected |
|---|---|---|---|
| T01 | Package manager | **pnpm 11.25.0**, pinned via `packageManager` + `devEngines`; installed with Corepack, `npm i -g pnpm@11.25.0` as the documented fallback | npm workspaces; Yarn 4; Bun; pnpm 12.3.1 |
| T02 | Task runner | **None.** pnpm workspaces + pnpm 11.25's built-in task scheduler (`tasks:` in `pnpm-workspace.yaml`) is the escalation step | Turborepo 2.10.12; Nx |
| T03 | Packages | `apps/api`, `apps/web`, `packages/core`, `packages/db`, `e2e` — five workspace entries, one-way dependency graph | 4 packages with e2e inside `apps/web`; 8-package "future-proof" split |
| T04 | TypeScript version | **6.0.3** (last JS-based compiler), not 7.0.2 | 7.0.2 (native Go port); 5.9.3 |
| T05 | TS configuration | One `tsconfig.base.json` + one tsconfig per package. **No project references** | Project references with `composite: true`; a single root tsconfig with `paths` |
| T06 | Running TypeScript | **Node 24's native type stripping** — `node --watch --env-file-if-exists`; workspace packages export raw `.ts`; no build step for `core`/`db` | `tsx` 4.23.13; precompiled `dist/` via tsup/unbuild |
| T07 | Lint & format | **ESLint 10.9.1 flat config + typescript-eslint 8.69.0 (type-aware) + Prettier 3.9.6** | Biome 2.5.12; oxlint |
| T08 | One-command dev | `pnpm dev` → a zero-dependency preflight script (`scripts/dev.mjs`) that finds/starts/migrates Postgres, then runs API + web in parallel. Vite proxies `/api` in dev; Fastify serves the built SPA in prod → **CORS never exists** | `docker compose up` running everything; two terminals; Supabase CLI |
| T09 | Postgres provisioning | Committed `docker-compose.yml` with **`pgvector/pgvector:pg16`, database service only**; Postgres.app as the primary no-Docker path; Homebrew documented with its **pgvector/PG-version trap** | Full-app compose; `embedded-postgres`; Supabase CLI (needs Docker) |
| T10 | Environment variables | **One `.env` at the repo root**, `.env.example` committed, `.env.test` for integration tests; loaded by Node's `--env-file-if-exists` and by Vite's `envDir`; validated by a Zod schema that fails fast at boot | Per-app `.env` files; the `dotenv` package; direnv |
| T11 | CI | GitHub Actions, three jobs (`check` / `integration` / `e2e`), `pnpm/setup@v2` with `runtime: node@24`, `pgvector/pgvector:pg16` as a service container | One monolithic job; a build matrix across Node versions |
| T12 | Node baseline | **Node 24 LTS**, floor `>=24.13.0` | Node 22 LTS; Node 26 |

---

## 1. Verified environment facts (measured on this machine, 2026-09-03)

```
node -v                 v24.20.0
npm -v                  11.19.0
corepack --version      0.35.0     (/opt/homebrew/bin/corepack — from Homebrew's node, not Node's bundle)
pnpm                    not installed
docker                  not installed
psql                    not installed
Postgres.app            not installed
brew                    /opt/homebrew/bin/brew
git                     2.50.1
```

Registry state at the time of writing (`npm view <pkg> version`):

```
pnpm 11.25.0 (dist-tag latest; latest-12 = 12.3.1)   turbo 2.10.12      typescript 7.0.2 (6.0.3, 5.9.3 also published)
vite 8.2.2            tailwindcss 4.3.3              @tailwindcss/vite 4.3.3   @vitejs/plugin-react 6.1.1
react 19.2.8          @tanstack/react-table 9.2.4    fastify 5.12.1     pg-boss 12.29.0    pg 8.23.0
drizzle-orm 0.45.2    drizzle-kit 0.31.10            drizzle-zod 0.8.3  zod 4.5.4
vitest 4.1.11         @playwright/test 1.62.1        eslint 10.9.1      @eslint/js 10.0.1
typescript-eslint 8.69.0   prettier 3.9.6            eslint-config-prettier 10.1.8
eslint-plugin-react-hooks 7.1.1   eslint-plugin-react-refresh 0.5.6    globals 17.12.0
@biomejs/biome 2.5.12  shadcn 4.20.1                 @types/node 26.4.1
GitHub Actions: actions/checkout v7.0.1 · actions/setup-node v7.0.0 · pnpm/setup v2.1.0
                pnpm/action-setup v6.0.10 (legacy, pnpm ≤10) · actions/upload-artifact v7.0.1
Homebrew: postgresql@16 = 16.15 · pgvector = 0.8.6, build_dependencies = ["postgresql@17","postgresql@18"]
Docker Hub: pgvector/pgvector tags pg15 · pg16 · pg17 · pg18 (currently pgvector 0.8.6)
```

Four things I **ran** rather than assumed, because the whole dev story rests on them:

```bash
# 1. Node 24.20 executes .ts with NO flag (type stripping is on by default)
$ node b.ts
type-stripping works: 3

# 2. ...but only erasable syntax. `enum E { A }` throws at parse time. -> tsconfig erasableSyntaxOnly
# 3. ...and it does NOT remap './a.js' -> a.ts. -> relative imports must be written './a.ts'
$ node d.ts
throw new ERR_MODULE_NOT_FOUND(...)

# 4. A workspace package that exports raw .ts, resolved through a node_modules symlink, works,
#    and `node --watch` restarts on edits to that package's source:
$ node --watch src/server.ts          # apps/api importing '@mutuals/core' -> packages/core/src/index.ts
cross-package TS import via node: 80
Change detected in '.../packages/core/src/index.ts'
Restarting 'src/server.ts'
cross-package TS import via node: 91
```

That last result is the single most consequential measurement in this document: it means
`packages/core` and `packages/db` need **no build step at all** in development, and the API dev server
needs **no loader, no watcher library and no bundler** — just `node --watch`.

---

## ADR-T01 — Package manager: pnpm 11.25.0, pinned in the repo

### Context
§3.1 of the brief fixes a monorepo; §3.2 names pnpm. What is genuinely undecided is *which* pnpm, and
how a contributor gets it, given that this Mac has no pnpm and Corepack's status has changed.

### Options
1. **pnpm 11.25.0** — the `latest` dist-tag. `engines.node: >=22.13`.
2. **pnpm 12.3.1** — published 2026-08-26, reachable as `latest-12` / `next-12`, but the `latest`
   dist-tag still points at 11.25.0.
3. **npm 11 workspaces** — zero install step, ships with Node.
4. **Yarn 4 / Bun** — Bun would also collapse the runtime and test-runner choices.

### Decision
pnpm **11.25.0** exactly, declared twice in the root `package.json`:

```jsonc
{
  "packageManager": "pnpm@11.25.0",
  "devEngines": {
    "runtime":        { "name": "node", "version": ">=24.13.0", "onFail": "error" },
    "packageManager": { "name": "pnpm", "version": "11.25.0",   "onFail": "error" }
  },
  "engines": { "node": ">=24.13.0" }
}
```

`packageManager` is what Corepack and `pnpm/setup@v2` read. `devEngines` (npm 11; keys `runtime`,
`packageManager`, `cpu`, `os`, `libc`; `onFail` ∈ `warn|error|ignore`, default `error`) is what makes a
contributor who types `npm install` out of habit get a clear error instead of a broken `node_modules`.

**Installation instructions in the README, in this order:**

```bash
# 1. Corepack (bundled with Node 24; REMOVED from Node 25+, where you install it yourself)
corepack enable pnpm      # then any `pnpm` in this repo resolves to 11.25.0 via packageManager

# 2. If corepack is unavailable (Node 25+, or a distro that strips it):
npm install -g pnpm@11.25.0

# 3. In CI we do neither — pnpm/setup@v2 installs the standalone binary.
```

### Why not the alternatives
- **pnpm 12** is released but the pnpm team has not promoted it to the `latest` dist-tag. Following
  `latest` is exactly what "prefer boring technology" means here. 12 also lands after 11.25 brought the
  feature that lets us *skip* Turborepo (ADR-T02), so there is nothing to chase.
- **npm workspaces** would remove an install step, and I gave it real weight. It loses on one specific
  point that matters to this repo: npm's flat, hoisted `node_modules` lets `apps/web` `import` from
  `drizzle-orm` or `pg` even though neither is its dependency. pnpm's isolated store makes the
  dependency direction in ADR-T03 a *resolution error*, not a code-review comment. For a project whose
  §3.1 rule is "the frontend talks to the backend only through the public API", having the package
  manager enforce it for free is worth the install step.
- **Bun** is disqualified by §3.1 ("Node.js with Fastify") and by "boring".
- **Yarn 4** is fine but has no advantage here and a smaller share of the docs a future contributor
  will find.

### Consequences
- pnpm 11 **no longer reads config from `package.json#pnpm`**, and `.npmrc` now carries only auth and
  registry settings. Everything else moves to `pnpm-workspace.yaml` in camelCase. We therefore ship
  **no `.npmrc` at all** — see §3 for the full `pnpm-workspace.yaml`.
- pnpm ≥10 does not run dependency build scripts unless approved. In pnpm 11 the key is `allowBuilds`
  (a map), with `strictDepBuilds: true` by default; `onlyBuiltDependencies` /
  `ignoredBuiltDependencies` / `neverBuiltDependencies` were **removed** in v11. The first `pnpm
  install` will report the unapproved builds; that list gets committed.
- A `pnpm-lock.yaml` is committed and CI installs frozen.

### Revisit when
pnpm promotes 12.x to `latest` **and** it has been there for a minor release or two.

---

## ADR-T02 — No task runner: pnpm workspaces alone

### Context
The default 2026 reflex is "pnpm workspaces + Turborepo". The question is whether a 5-package repo with
one dev command, no shared build outputs to cache, and a CI run measured in single-digit minutes gets
anything from a second orchestrator.

### Options
1. **pnpm alone** — `pnpm -r`, `--filter`, `--parallel`, and (new in 11.25) a real task scheduler.
2. **Turborepo 2.10.12** — task graph, content-addressed local cache, remote cache, `turbo watch`.
3. **Nx** — the same plus generators, plugins, a project graph and its own daemon.

### Decision
No task runner. Orchestration is:

```jsonc
// root package.json (scripts, abridged — full file in §3)
"dev":        "node scripts/dev.mjs",
"dev:apps":   "pnpm --filter \"./apps/*\" --parallel run dev",
"typecheck":  "pnpm -r run typecheck",
"build":      "pnpm -r run build",
"test:unit":  "vitest run --project core",
```

Where a real dependency order appears later, pnpm 11.25's own scheduler expresses it without a new
tool — this is the documented first escalation step, not Turborepo:

```yaml
# pnpm-workspace.yaml — available from pnpm 11.25.0; '^build' = build in each workspace dependency
tasks:
  build:
    dependsOn: ['^build']
    concurrency: 2
  test:
    dependsOn: ['build']
```

### Why not the alternatives
- **What Turborepo actually sells is caching**, and this repo has almost nothing to cache. Under ADR-T06
  `packages/core` and `packages/db` have no build output at all; `apps/api` has none;
  only `apps/web`'s `vite build` produces artifacts, and Vite 8 (Rolldown) builds it in seconds.
  Caching a fast task you run once per CI job is negative value.
- **Remote caching is the one big win, and it points at a proprietary service.** §3.1 says
  "no proprietary services in the critical path". Self-hosting a cache server to speed up a five-package
  repo is the definition of over-engineering.
- **Cost is not zero**: `turbo.json` is a second source of truth for env vars (`globalEnv`,
  `passThroughEnv`) that silently changes hashes when you forget it, a daemon, and one more thing a
  non-technical owner sees in an error message.
- **Nx** is a bigger version of the same trade with a steeper on-ramp.

### Consequences
- `pnpm -r run typecheck` runs all packages; ordering does not matter because nothing emits.
- CI parallelism comes from three GitHub jobs (ADR-T11), not from a task graph.
- Adding Turborepo later is additive: one `turbo.json`, one devDependency, root scripts rewritten from
  `pnpm -r run X` to `turbo run X`. Nothing about the package layout blocks it.

### Revisit when
CI wall-clock exceeds ~5 minutes, or the workspace passes ~8 packages, or a package gains a genuinely
slow build (codegen, a wasm step).

---

## ADR-T03 — Five packages and a one-way dependency graph

### Context
§3.1 suggests `apps/web`, `apps/api`, `packages/core`, `packages/db` and says the exact layout is my
call. Two things the brief says elsewhere constrain it hard: "the web app talks to the backend only
through the public API. No direct database access from the frontend" (§3.1), and "attribute definitions
drive everything — never hard-code a column" (§8.3), which means the filter model, the attribute type
table and the warmth function are shared vocabulary, not API-private code.

### Options
1. **Four packages**, e2e tests living inside `apps/web`.
2. **Five packages** — the four plus a top-level `e2e` harness.
3. **Eight packages** now: add `packages/ui`, `packages/llm`, `packages/jobs`, `packages/api-client`.

### Decision — five workspace entries

```
mutuals/
├─ apps/
│  ├─ api/          @mutuals/api    Fastify HTTP server, routes, OpenAPI, jobs runner, llm/ module
│  └─ web/          @mutuals/web    Vite + React SPA, shadcn components live here
├─ packages/
│  ├─ core/         @mutuals/core   domain: types, Zod schemas, the filter AST, attribute type table,
│  │                                slug rules, warmth, duplicate matching, recurrence, import mapping
│  └─ db/           @mutuals/db     drizzle schema, migrations, the filter→SQL compiler, projector,
│                                   repositories, seed, reproject
└─ e2e/             @mutuals/e2e    Playwright specs + DB reset helpers
```

Dependency direction — **enforced three ways**: pnpm's isolated `node_modules`, an ESLint
`no-restricted-imports` rule, and the absence of the dependency in `package.json`.

```
   apps/web  ──HTTP──▶  apps/api
       │                 │      │
       │ types only      │      │
       ▼                 ▼      ▼
  packages/core  ◀──  packages/db
       ▲                        ▲
       └──────── e2e ───────────┘   (dev-only: needs db to truncate/seed, core for fixtures)
```

- `packages/core` depends on **nothing in this repo** and on `zod` only. It must not import `node:*`,
  `pg`, `drizzle-orm` or `fastify` — it is shipped to the browser.
- `packages/db` depends on `core` (it compiles `core`'s filter AST into SQL, and the attribute type
  table in `core` is what tells it which typed slot to write).
- `apps/api` depends on `core` + `db`.
- `apps/web` depends on `core` **only**, and only for types, the filter AST and pure helpers.
- Nothing depends on `apps/*`.

### Why not the alternatives
- **e2e inside `apps/web` is the tempting four-package version, and it breaks the main rule.**
  Playwright has to truncate and reseed the database between specs, so it needs `@mutuals/db`. Putting
  it in `apps/web` would make `@mutuals/db` a devDependency of the web app — and then pnpm stops
  enforcing "no database access from the frontend", which is the one boundary the brief states twice.
  A separate `e2e` package keeps the enforcement mechanical. This is a real reason, not symmetry.
- **Eight packages now is over-engineering** and the brief forbids it explicitly. The named extension
  points instead:
  - `llm/` lives at `apps/api/src/llm/` in Stage 6 with the provider interface (`complete()`,
    `extract()`, `embed()`); it becomes `packages/llm` the day a second consumer (the MCP server, a
    CLI) needs it. Moving it is a directory rename plus one `package.json`.
  - `jobs/` lives at `apps/api/src/jobs/` (pg-boss workers) — §9's "a `jobs` package/folder with a
    scheduler stub" is satisfied by the folder.
  - `integrations/` at `apps/api/src/integrations/` with the `fetchSince(cursor)` interface.
  - `packages/ui` is deliberately *not* created: shadcn components are copied into
    `apps/web/src/components/ui/` because there is exactly one frontend. shadcn's `--monorepo` mode
    exists and adds a cross-workspace alias dance for zero benefit at one consumer.
  - `apps/mcp` (Stage 8) is a thin adapter over the API and gets its own app then.

### The typed-end-to-end seam
`packages/core` owns the request/response Zod schemas. `apps/api` implements them (and generates
OpenAPI from them); `apps/web` imports the inferred types from `@mutuals/core`. That gives the brief's
"the frontend should get types from the API without hand-writing them" with **no codegen step in the
dev loop**, while OpenAPI is still emitted for Python/MCP clients. The exact plugin choice belongs to
the API-style ADR; what this ADR fixes is only *where the contract lives* — in `core`, not in `api`,
because `apps/web` must never depend on `apps/api`.

### Consequences
- `packages/core` staying isomorphic is a rule that needs a guard; it gets an ESLint override banning
  `node:*` imports in that package.
- `e2e` is `private: true` and never published.

---

## ADR-T04 — TypeScript 6.0.3, not 7.0.2

### Context
`typescript@latest` is now **7.0.2** (published 2026-07-08), the native Go port: 8–12× faster full
builds, `--checkers`, `--builders`, `--singleThreaded`. The task brief explicitly asks whether that is
"boring technology" yet. It also asks whether to pin 5.x.

### Options
1. **7.0.2** — native, fastest, `latest`.
2. **6.0.3** (2026-04-16) — the final JS-based compiler; the deliberate migration bridge to 7, with
   `--stableTypeOrdering` to surface behavioural differences between the two compilers.
3. **5.9.3** (2025-09-30) — the previous line.

### Decision
Pin **`typescript@6.0.3`** as the single workspace TypeScript.

### Why
The deciding fact is not speed, it is an API:

> **TypeScript 7.0 ships without a stable programmatic API** (expected in 7.1). Tools that consume the
> TypeScript compiler API — typescript-eslint among them — cannot run on TypeScript 7 yet.

And the registry confirms it from the other side: `typescript-eslint@8.69.0` declares
`"typescript": ">=4.8.4 <6.1.0"`. So **choosing type-aware ESLint is choosing TypeScript ≤ 6.0.x**
(ADR-T07). The two decisions are one decision, and I would rather have `no-floating-promises` and
`no-misused-promises` on a codebase that is Fastify handlers, Drizzle transactions and pg-boss workers
than have `tsc --noEmit` finish in 0.4 s instead of 4 s on a repo this size.

5.9.3 is rejected because 6.0 *is* the bridge: it turns the deprecations (`moduleResolution: node`,
`baseUrl`, `outFile`) into errors we fix once, now, on a greenfield repo, instead of during a 7.x
migration. Starting on 5.9 means doing that work twice.

### Consequences
- `pnpm typecheck` runs the JS-based compiler. Measured on repos this size that is seconds; it is not
  on anyone's critical path.
- `moduleResolution: node` and `baseUrl` are unavailable — the config in ADR-T05 uses `nodenext` /
  `bundler` and package `exports`, which is where we want to be anyway.
- The migration to 7 is pre-planned and cheap: bump `typescript`, drop or replace typescript-eslint's
  type-aware layer, run the suite. Optionally add `"stableTypeOrdering": true` now to make the eventual
  diff empty.

### Revisit when
TypeScript **7.1** ships the stable API **and** typescript-eslint publishes a release whose peer range
admits it. Concretely: `npm view typescript-eslint peerDependencies` no longer says `<6.1.0`.

---

## ADR-T05 — One base tsconfig, one per package, no project references

### Context
Four TypeScript packages, two runtimes (Node, browser), and an "internal packages" model where
`packages/*` export raw `.ts` (ADR-T06).

### Options
1. **Base + per-package configs, no references** — typecheck each package independently.
2. **Project references** (`composite: true`, `tsc --build`) — incremental, enforces boundaries at the
   type layer.
3. **A single root tsconfig** with `paths` aliases.

### Decision — option 1.

`composite: true` requires declaration emit. Under ADR-T06 nothing emits, so references would force us
to reintroduce `dist/` + `.d.ts` for `core` and `db` *purely to satisfy the build system* — and then
editors would show stale types until a build ran. That is a real regression in the loop that matters
most (edit `core`, see the error in `api`). Boundaries are already enforced by pnpm and ESLint
(ADR-T03), which is the job people usually hire references for.

A single root tsconfig is rejected because `apps/web` needs `lib: DOM` and JSX and `apps/api` must not
have them — one config cannot express both without lying to one of them.

```jsonc
// tsconfig.base.json  (repo root)
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "nodenext",
    "moduleResolution": "nodenext",

    // strictness: the brief says "strict TypeScript"; these are the ones that catch real CRM bugs
    "strict": true,
    "noUncheckedIndexedAccess": true,     // rows[0] is T | undefined — this is a table app
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,   // the attribute-type switch is 12 cases wide
    "noUnusedLocals": true,
    "noUnusedParameters": true,

    // required by ADR-T06 (Node runs the .ts files directly)
    "erasableSyntaxOnly": true,           // no enums, no parameter properties, no namespaces
    "verbatimModuleSyntax": true,         // `import type` is never elided into a runtime import
    "isolatedModules": true,
    "allowImportingTsExtensions": true,   // relative imports are written './foo.ts'
    "rewriteRelativeImportExtensions": true,

    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": []
  }
}
```

Two deliberate omissions, stated so nobody "fixes" them later:

- **`exactOptionalPropertyTypes` is off.** It fights Drizzle's inferred insert types and React's
  optional props, and the noise-to-signal ratio at this scale is bad. `noUncheckedIndexedAccess`
  catches the class of bug we actually have.
- **`allowJs` is off** — there is no JavaScript in this repo except `scripts/dev.mjs` and
  `eslint.config.js`, both excluded.

```jsonc
// packages/core/tsconfig.json          (identical shape for packages/db, apps/api, e2e)
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },        // core: omit "types" entirely — it is isomorphic
  "include": ["src/**/*.ts"] }
```

```jsonc
// apps/web/tsconfig.json
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "module": "preserve",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "types": ["vite/client"],
    "paths": { "@/*": ["./src/*"] }                 // matches components.json for the shadcn CLI
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"] }
```

### Consequences
- Every relative import in Node-side code is written with its real extension: `./warmth.ts`. That is a
  visible, slightly unusual convention; it is the price of ADR-T06 and it is enforced by the compiler,
  so it cannot drift.
- Typecheck is `pnpm -r run typecheck`, each package independent, parallel-safe.

### Revisit when
`tsc --noEmit` across the repo exceeds ~10 s, at which point references (with emit) or TypeScript 7's
`--builders` become worth their cost.

---

## ADR-T06 — Node 24 native type stripping; workspace packages ship raw `.ts`

### Context
Three sub-questions that are really one: how does the API dev server run TypeScript, do
`packages/core` / `packages/db` need a build step, and what does `apps/web`'s bundler consume?

### Options
1. **Node native type stripping** + "internal packages" (packages' `exports` point at `src/*.ts`).
2. **`tsx` 4.23.13** as the dev runner, packages still raw `.ts`.
3. **Compiled packages**: `tsup`/`unbuild` emit `dist/*.js` + `.d.ts`; consumers import `dist`.

### Decision — option 1, verified by measurement (see §1).

```jsonc
// packages/core/package.json
{
  "name": "@mutuals/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".":            "./src/index.ts",
    "./attributes": "./src/attributes/index.ts",
    "./filters":    "./src/filters/index.ts"
  },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": { "zod": "4.5.4" }
}
```

```jsonc
// apps/api/package.json  (scripts only)
"scripts": {
  "dev":       "node --watch --env-file-if-exists=../../.env src/main.ts",
  "start":     "node --env-file-if-exists=../../.env src/main.ts",
  "typecheck": "tsc --noEmit"
}
```

That is the entire dev-runner story: no loader, no `nodemon`, no `tsx`, no `concurrently`, and
`--watch` already restarts on edits inside `packages/core` (measured).

### Why not the alternatives
- **`tsx`** is the boring answer and I nearly took it. It buys `.js`→`.ts` extension remapping and
  `tsconfig.paths` support. It costs a dependency, an ESM loader hook in the process, and a second
  transform implementation that must agree with `tsc`. With Node 24 as an LTS that strips types by
  default, the loader is the thing that is now unusual. Recorded as the fallback: if any of the
  constraints below becomes painful, `"dev": "tsx watch src/main.ts"` is a one-line revert.
- **Compiled `dist/`** is the correct answer for a *published* library and the wrong one here. It puts
  a build between "save `core/src/warmth.ts`" and "see the API behave differently", and it makes
  stack traces point at generated code. The day `@mutuals/core` is published to npm, add a `tsdown`
  build and a `publishConfig.exports` override — that is additive and touches one file.

### Consequences (the constraints this buys, all compiler-enforced)
1. **`erasableSyntaxOnly: true`** — no `enum`, no parameter properties, no `namespace`. Union-of-string
   literal types replace enums, which is what we want anyway next to Postgres enums and Zod.
2. **Relative imports carry `.ts`.** Node does not remap `./a.js` (measured: `ERR_MODULE_NOT_FOUND`).
3. **No `tsconfig.paths` in Node-side packages** — Node does not read tsconfig. Cross-package imports
   go through package `exports`; intra-package imports are relative. `apps/web` may use `@/*` because
   Vite resolves it.
4. `packages/core`'s consumers must all be able to transpile `.ts`: Node 24 ✓ (measured), Vite 8 ✓
   (linked workspace sources are treated as project source), Vitest 4 ✓. Known Vite gotcha to apply if
   it bites: `optimizeDeps.exclude: ['@mutuals/core']`.
5. **Production runs the same way** (`node src/main.ts`). Type stripping is a stable Node 24 feature;
   the parse cost is milliseconds. If a deployment target ever wants a single artifact, add a bundle
   step then.

---

## ADR-T07 — ESLint 10 flat config + typescript-eslint (type-aware) + Prettier

### Context
The brief names ESLint and Prettier (§3.2). The task asks me to genuinely weigh Biome. Biome 2.5.12 is
one binary that formats and lints JS/TS/JSX/JSON/CSS, has 500+ rules, nested configs for monorepos, and
— uniquely — type-aware rules that do **not** need the TypeScript compiler.

### Options
1. **ESLint 10.9.1 + typescript-eslint 8.69.0 + Prettier 3.9.6** (+ `eslint-config-prettier` 10.1.8,
   `eslint-plugin-react-hooks` 7.1.1, `eslint-plugin-react-refresh` 0.5.6, `globals` 17.12.0).
2. **Biome 2.5.12** alone.
3. **oxlint** for speed + Prettier for formatting.

### Decision — option 1.

### Why
Three reasons, in order of weight:

1. **The rules I actually want are nursery in Biome.** `noFloatingPromises` — the single most valuable
   rule for a codebase of `await`-heavy Fastify handlers, Drizzle transactions and pg-boss workers — is
   documented as *"part of the nursery group… experimental and the behavior can change at any time"*.
   typescript-eslint's `no-floating-promises` and `no-misused-promises` are a decade old and boring.
   The storage design leans on transaction ordering (supersede-then-insert inside one transaction); a
   dropped `await` there is a data-corruption bug, not a lint nit.
2. **The brief names ESLint and Prettier.** Deviating needs a strong reason; "one binary instead of
   three dev dependencies" is not one at this size.
3. **Ecosystem.** shadcn/ui, React and Vite documentation all assume ESLint. A non-technical owner
   pasting an error into a search engine gets more hits.

The honest cost, stated: it is 8 dev dependencies and a version matrix, it is slower, and it pins
TypeScript to ≤6.0.x (ADR-T04). Biome would decouple those. **The revisit trigger is explicit and
mechanical** (below), because I expect this to be the ADR most worth reversing in a year.

```js
// eslint.config.js  (repo root — ESLint 10 flat config)
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier/flat';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**', '**/build/**', '**/.vite/**', '**/coverage/**',
      'packages/db/drizzle/**',        // generated + hand-authored SQL migrations
      'e2e/playwright-report/**', 'e2e/test-results/**',
    ],
  },

  js.configs.recommended,

  // ── Node-side packages: type-aware linting ───────────────────────────────
  {
    files: ['apps/api/**/*.ts', 'packages/**/*.ts', 'e2e/**/*.ts', 'scripts/**/*.mjs'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',  // the 12 attribute types
    },
  },

  // ── packages/core must stay isomorphic: it is bundled into the browser ───
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['node:*', 'pg', 'drizzle-orm', 'drizzle-orm/*', 'fastify'],
          message: '@mutuals/core is shipped to the browser. Keep it pure: no Node, no db, no HTTP.' },
      ]}],
    },
  },

  // ── §3.1 API-first, enforced: the web app never touches the database ────
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-restricted-imports': ['error', { patterns: [
        { group: ['@mutuals/db', '@mutuals/db/*', 'pg', 'drizzle-orm', 'drizzle-orm/*'],
          message: 'The web app talks to the public API only (brief §3.1). Import types from @mutuals/core.' },
      ]}],
    },
  },

  // shadcn components are copied in verbatim and adapted; do not fight their style
  { files: ['apps/web/src/components/ui/**'], rules: { 'react-refresh/only-export-components': 'off' } },

  prettier,   // must be last: turns off every rule that argues with the formatter
);
```

```jsonc
// .prettierrc.json
{ "singleQuote": true, "semi": true, "printWidth": 100, "trailingComma": "all" }
```

Prettier runs as a **separate command**, never as an ESLint rule (that pattern is deprecated and makes
lint output unreadable):

```jsonc
"lint":   "eslint . && prettier --check .",
"format": "prettier --write . && eslint . --fix",
```

### Consequences
- No git hooks in Stage 1. CI is the gate; hooks are a per-contributor preference and `lint-staged` +
  `simple-git-hooks` can be added in ten lines if the loop gets annoying. (Explicitly considered and
  deferred — it is two more dev dependencies for a two-person team with fast CI.)
- Type-aware linting needs `projectService`, so `eslint` is slower than `biome check` by an order of
  magnitude. At ~200 files, that is seconds.

### Revisit when
Any one of: (a) we want TypeScript 7 before typescript-eslint supports it; (b) `pnpm lint` exceeds
~30 s; (c) Biome promotes `noFloatingPromises` and `noMisusedPromises` out of nursery. Migration is
mechanical (`biome migrate eslint --write`) and the ignore lists above translate directly.

---

## ADR-T08 — `pnpm dev`: one command, no Docker required

### Context
§3.1: "Runs locally with one command (`docker compose up` or a single `pnpm dev`)." §12: Simon, who is
not a developer, must be able to start the app on his own laptop. **This Mac has no Docker, no
Postgres, no psql.** So the one command has to (a) find or start a database, (b) create and migrate it,
(c) start two processes, and (d) when it cannot, print instructions a non-developer can follow.

### Options
1. **A preflight script** that probes the database, starts compose *if Docker exists*, migrates, then
   runs both apps.
2. **`docker compose up` running everything** (db + api + web).
3. **Two terminals** (`pnpm --filter api dev`, `pnpm --filter web dev`) and a README.
4. **Supabase CLI** for the local stack.

### Decision — option 1.

Options 2 and 4 both require Docker, which is precisely the machine we must support. Option 3 fails
§12 (the product owner is not a developer). So:

```jsonc
// root package.json
"dev":      "node scripts/dev.mjs",
"dev:apps": "pnpm --filter \"./apps/*\" --parallel run dev",
```

```js
// scripts/dev.mjs — zero dependencies on purpose: this is the first thing that runs after `git clone`,
// and it has to work even if `pnpm install` has not finished doing anything clever.
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
try { process.loadEnvFile(join(root, '.env')); } catch { /* no .env yet: fall through to the hint below */ }

if (!process.env.DATABASE_URL) {
  console.error(
    '\n  No .env found.\n' +
    '  Run:  cp .env.example .env      then start again with:  pnpm dev\n');
  process.exit(1);
}

const { hostname, port } = new URL(process.env.DATABASE_URL);
const host = hostname || 'localhost';
const dbPort = Number(port || 5432);

const reachable = (h, p, ms = 750) => new Promise((resolve) => {
  const socket = connect({ host: h, port: p });
  const finish = (ok) => { socket.destroy(); resolve(ok); };
  socket.setTimeout(ms);
  socket.once('connect', () => finish(true));
  socket.once('error',   () => finish(false));
  socket.once('timeout', () => finish(false));
});

const have = (cmd) => spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
const run  = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!(await reachable(host, dbPort))) {
  if (have('docker') && existsSync(join(root, 'docker-compose.yml'))) {
    console.log(`\n  Postgres is not answering on ${host}:${dbPort} — starting the container…\n`);
    run('docker', ['compose', 'up', '-d', '--wait', 'db']);   // --wait blocks until healthcheck passes
  } else {
    console.error(`
  Mutuals needs a Postgres 16+ with the pgvector extension, and nothing is
  listening on ${host}:${dbPort}.

  Pick ONE of these (all take about two minutes):

  A) Postgres.app  — easiest on a Mac, ships pgvector, no Terminal needed
     1. Download from https://postgresapp.com and drag it to Applications
     2. Open it and click "Initialize"
     3. In Terminal, once:
          /Applications/Postgres.app/Contents/Versions/latest/bin/createuser -s mutuals
          /Applications/Postgres.app/Contents/Versions/latest/bin/createdb  -O mutuals mutuals

  B) Homebrew
          brew install postgresql@18 pgvector      # NOT @16: Homebrew's pgvector bottle
          brew services start postgresql@18        # is built against postgresql@17/@18
          createuser -s mutuals && createdb -O mutuals mutuals

  C) Docker (if you install Docker Desktop, 'pnpm dev' does the rest by itself)
          docker compose up -d db

  Then run 'pnpm dev' again.
`);
    process.exit(1);
  }
}

run('pnpm', ['db:migrate']);                                     // creates the DB if missing, then migrates
spawn('pnpm', ['run', 'dev:apps'], { stdio: 'inherit', cwd: root })
  .on('exit', (code) => process.exit(code ?? 0));
```

`pnpm db:migrate` is `@mutuals/db`'s migrate entry point and does an `ensureDatabase()` first: connect
to the maintenance `postgres` database, `CREATE DATABASE` if absent, then run drizzle's migrator (which
runs both the drizzle-kit-generated files and the hand-authored SQL files from
`storage-DECISION.md` §2, in one numbering).

### CORS never exists — a consequence worth stating
- **Dev:** the Vite dev server proxies `/api` to the Fastify port, so the browser only ever talks to
  `localhost:5173`.
- **Prod:** Fastify serves `apps/web/dist` as static files and `/api/v1/*` itself — one origin.

That removes an entire class of configuration and an entire class of bug, and it means
`VITE_API_URL` defaults to the empty string (same origin) rather than a hostname anyone has to keep in
sync.

### Consequences
- `scripts/dev.mjs` is load-bearing UX and must be kept working; it gets a smoke test in CI
  (`node --check` plus a run against the service container).
- Windows/Linux contributors: `which` is not portable to Windows. The script is documented as
  macOS/Linux; Windows contributors use WSL or Docker. (Acceptable: the two users are on macOS, and
  the compose path covers everyone else.)

---

## ADR-T09 — Postgres: compose for the database only, Postgres.app as the no-Docker path

### Context
The storage design needs Postgres **≥16** with `pgcrypto`, `pg_trgm`, `btree_gin`, `unaccent` and
`vector`. Three local paths must be documented, and the deployed instance is Supabase-as-managed-Postgres.

### Options
1. **Compose runs the database only**; apps run on the host.
2. **Compose runs everything** (db + api + web with bind mounts).
3. **`embedded-postgres`** (npm downloads a Postgres binary) for a true zero-install path.

### Decision — option 1.

```yaml
# docker-compose.yml — development dependency only. The app itself runs on the host (`pnpm dev`).
# No `version:` key: it has been obsolete since Compose v2.
name: mutuals

services:
  db:
    image: pgvector/pgvector:pg16      # pgvector 0.8.6 on Postgres 16 — the version floor we support
    container_name: mutuals-db
    environment:
      POSTGRES_USER: mutuals
      POSTGRES_PASSWORD: mutuals
      POSTGRES_DB: mutuals
    ports:
      - '${DB_PORT:-5432}:5432'        # override DB_PORT in .env if 5432 is already taken
    volumes:
      - mutuals-pgdata:/var/lib/postgresql/data
    healthcheck:                        # `docker compose up --wait` blocks on this
      test: ['CMD-SHELL', 'pg_isready -U mutuals -d mutuals']
      interval: 2s
      timeout: 3s
      retries: 30

volumes:
  mutuals-pgdata:
```

The image ships the extension **files**; `CREATE EXTENSION` stays in migration 0001, exactly as
`storage-DECISION.md` §2.1 specifies, so every path (compose, Postgres.app, Homebrew, Supabase) goes
through the same migration.

### The Homebrew trap, verified
`brew info --json=v2 pgvector` reports `build_dependencies: ["postgresql@17", "postgresql@18"]`. The
bottle installs its `vector.so`/`vector.control` for **postgresql@17 and @18**, not for
`postgresql@16` (16.15 in Homebrew). So the naive `brew install postgresql@16 pgvector` produces a
server where `CREATE EXTENSION vector` fails. The README must say `postgresql@18` for the Homebrew
path — which is why **Postgres.app is the recommended no-Docker path**: it bundles pgvector, needs no
compilation, and has a GUI a non-developer can use. (`pg_trgm`, `unaccent`, `btree_gin` and `pgcrypto`
are core contrib modules and are present on all three paths.)

### Why not the alternatives
- **Compose running everything** costs bind-mount filesystem latency on macOS (the HMR loop is the
  thing we most want fast), forces a Node image rebuild on every dependency change, and — decisively —
  does nothing for the machine we actually have, which has no Docker.
- **`embedded-postgres`** is genuinely tempting for "zero install", and it is disqualified by the one
  thing we cannot do without: it ships stock Postgres binaries with no pgvector, and no supported way
  to add a compiled extension. It would work for Phase 1 (the vector column is always NULL) and break
  in Stage 8, i.e. exactly the trap the storage ADR spends a section warning about.

### Consequences
- **CI runs Postgres 16** — the declared floor — while local machines will mostly be on 17/18. That
  asymmetry is the right direction (CI is the stricter environment), and it is the reason to *keep*
  16 in CI rather than track whatever developers happen to run.
- Supabase is a `DATABASE_URL` and nothing else; the storage ADR already forbids Supabase SDK/RLS/Edge.
  Its connection string needs `?sslmode=require`, noted in `.env.example`.

---

## ADR-T10 — One `.env` at the repo root

### Context
§3.1: "`.env.example` for every secret." Two runtimes (Node, Vite) and a test database mean the naive
answer (a `.env` per app) creates three files that drift.

### Options
1. **One root `.env`** + `.env.example` + `.env.test`.
2. **Per-app `.env` files** (`apps/api/.env`, `apps/web/.env`).
3. A secrets manager / direnv.

### Decision — option 1.

- **API and scripts:** `node --env-file-if-exists=../../.env src/main.ts`. Node 24 has this natively
  (verified: it loads the file and prints a friendly note when it is missing, exit 0). **No `dotenv`
  dependency anywhere in the repo.**
- **Web:** `envDir` points at the repo root; Vite exposes only `VITE_`-prefixed variables to the
  client (`envPrefix` default `VITE_`). Non-prefixed variables used *by the config itself* (the proxy
  target) are read with `loadEnv(mode, root, '')`, which never reaches the browser bundle.
- **Tests:** `.env.test` holds `DATABASE_URL` pointing at `mutuals_test`, loaded by Vitest's
  `globalSetup`. The integration suite refuses to run if `DATABASE_URL` does not end in `_test` — the
  cheapest possible guard against wiping a real database.
- **Validation:** one Zod schema, parsed once at boot in `apps/api/src/env.ts`, so a missing key is a
  startup error with a field list rather than `undefined` reaching Postgres.

```ts
// apps/api/src/env.ts — Zod 4 (top-level format functions; z.string().url() is deprecated in v4)
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url(),                    // verified: z.url() accepts postgres://user:pw@host:5432/db
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Stage 6 — absent in Stage 1, so `.optional()`; the LLM module refuses to start without them.
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_BASE_URL: z.url().default('https://openrouter.ai/api/v1'),
  LLM_MODEL_EXTRACTION: z.string().optional(),
  LLM_MODEL_QA: z.string().optional(),
  LLM_MODEL_SUMMARY: z.string().optional(),
  LLM_MODEL_EMBEDDING: z.string().optional(),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}
export const env = parsed.data;
```

### `.env.example` (committed, complete, no real values)

```dotenv
# ─────────────────────────────────────────────────────────────────────────────
#  Mutuals — copy this file to `.env` and fill it in.   cp .env.example .env
#  `.env` is git-ignored. Never commit real keys.
# ─────────────────────────────────────────────────────────────────────────────

# ── Database ────────────────────────────────────────────────────────────────
# Any Postgres >= 16 with: pgcrypto, pg_trgm, btree_gin, unaccent, vector (pgvector).
# The migrations create the extensions; you only need a database and a superuser.
DATABASE_URL=postgres://mutuals:mutuals@localhost:5432/mutuals

# Host port that docker-compose publishes. Change it if 5432 is already in use.
DB_PORT=5432

# Integration tests wipe this database on every run. It MUST NOT be your dev database;
# the test suite refuses to start unless the name ends in `_test`.
TEST_DATABASE_URL=postgres://mutuals:mutuals@localhost:5432/mutuals_test

# Supabase (shared instance) — used as plain managed Postgres, nothing else:
# DATABASE_URL=postgres://postgres.<ref>:<password>@<host>.supabase.com:5432/postgres?sslmode=require

# ── API ─────────────────────────────────────────────────────────────────────
NODE_ENV=development
API_HOST=127.0.0.1
API_PORT=3000
LOG_LEVEL=info

# ── Web ─────────────────────────────────────────────────────────────────────
WEB_PORT=5173
# Empty = same origin. In dev the Vite proxy forwards /api to API_PORT; in production
# the API serves the built frontend. Only set this if you host the two separately.
VITE_API_URL=

# ── LLM — everything goes through OpenRouter (brief §3.1) ───────────────────
# Get a key at https://openrouter.ai/keys (keys start with `sk-or-`).
# Not needed before Stage 6: without it, the AI features are disabled, the rest works.
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
# Sent as HTTP-Referer / X-Title so usage shows up under this app in OpenRouter's dashboard.
OPENROUTER_APP_URL=https://getmutuals.ai
OPENROUTER_APP_TITLE=Mutuals

# One model per task, so a cheap model can do extraction while a strong one answers questions.
# Model ids are configuration, never code — pick any id from https://openrouter.ai/models
LLM_MODEL_EXTRACTION=
LLM_MODEL_QA=
LLM_MODEL_SUMMARY=
LLM_TIMEOUT_MS=30000

# ── Embeddings (Stage 8; the vector column exists in Stage 1 but stays NULL) ─
# Same interface, separate base URL, because OpenRouter's embedding coverage is thin.
# NOTE: pgvector's HNSW/IVFFlat indexes cap at 2000 dimensions for `vector`
# (4000 for `halfvec`). A 3072-dimension model needs halfvec or dimension reduction.
EMBEDDINGS_BASE_URL=
EMBEDDINGS_API_KEY=
EMBEDDINGS_MODEL=
EMBEDDINGS_DIMENSIONS=1536

# ── Background jobs (pg-boss, in the same Postgres — brief §3.2) ────────────
PGBOSS_SCHEMA=pgboss
JOBS_ENABLED=true
```

### Consequences
- `--env-file-if-exists=../../.env` hard-codes the depth of `apps/api`. Acceptable and visible; if a
  package ever moves, the script breaks loudly at startup.
- Real process environment always wins over the file (Node's behaviour), so CI and production hosting
  need no special case.
- Nothing secret can reach the browser without someone deliberately renaming it to `VITE_*`.

---

## ADR-T11 — CI: three jobs on GitHub Actions

### Options
1. **Three jobs**: `check` (lint/typecheck/unit, no DB) · `integration` (Postgres service) · `e2e`.
2. **One job** doing everything sequentially.
3. A Node-version matrix.

### Decision — option 1. Fast feedback on the failures that happen most (lint/types), and a clean
signal about which layer broke. A matrix is rejected: `engines` pins Node 24, so a second Node version
tests a configuration we do not support.

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  # pnpm/setup@v2 runs `pnpm install` itself; CI defaults to a frozen lockfile.
  DO_NOT_TRACK: '1'

jobs:
  check:
    name: lint · typecheck · unit tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/setup@v2                 # installs pnpm 11.25.0 from `packageManager` + Node 24
        with:
          runtime: node@24
          cache: true
          require-lockfile: true
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test:unit
      - run: node --check scripts/dev.mjs   # the first thing a contributor runs must at least parse

  integration:
    name: integration (Postgres 16 + pgvector)
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: mutuals
          POSTGRES_PASSWORD: mutuals
          POSTGRES_DB: mutuals_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U mutuals -d mutuals_test"
          --health-interval 2s --health-timeout 3s --health-retries 30
    env:
      DATABASE_URL: postgres://mutuals:mutuals@localhost:5432/mutuals_test
      TEST_DATABASE_URL: postgres://mutuals:mutuals@localhost:5432/mutuals_test
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/setup@v2
        with: { runtime: node@24, cache: true, require-lockfile: true }
      - run: pnpm db:migrate           # must succeed from an empty database (storage ADR §10.1)
      - run: pnpm db:migrate           # ...and be a no-op the second time
      - run: pnpm seed
      - run: pnpm test:integration
      # The gates the storage decision asks for, as one command:
      #  - `pnpm db:reproject` rebuilds every derived table from `fact` and asserts byte-identity
      #  - no row has a NULL workspace_id
      #  - EXPLAIN regressions: each of the nine attribute_value indexes is chosen for its operator,
      #    and both sort directions produce NULLS LAST without a spilled sort
      - run: pnpm db:check

  e2e:
    name: end-to-end (Playwright)
    runs-on: ubuntu-latest
    needs: [check]
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: mutuals
          POSTGRES_PASSWORD: mutuals
          POSTGRES_DB: mutuals_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U mutuals -d mutuals_test"
          --health-interval 2s --health-timeout 3s --health-retries 30
    env:
      DATABASE_URL: postgres://mutuals:mutuals@localhost:5432/mutuals_test
      TEST_DATABASE_URL: postgres://mutuals:mutuals@localhost:5432/mutuals_test
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/setup@v2
        with: { runtime: node@24, cache: true, require-lockfile: true }
      - run: pnpm db:migrate && pnpm seed
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm test:e2e
      - uses: actions/upload-artifact@v7
        if: ${{ !cancelled() }}
        with:
          name: playwright-report
          path: e2e/playwright-report/
          retention-days: 7
```

Notes on the choices inside that file:
- **`pnpm/setup@v2`** replaces `actions/setup-node` + `pnpm/action-setup`. `pnpm/action-setup`'s own
  README says: *"For pnpm v11 and newer, use `pnpm/setup` instead."* It installs the standalone pnpm
  binary, installs the runtime via `pnpm runtime set`, caches the store, and runs `pnpm install` by
  default — four steps become one.
- **`permissions: contents: read`** and a `concurrency` group are the two hardening lines every public
  repo should have; for a public repo, pinning actions to commit SHAs is the next step and is noted in
  `docs/DECISIONS.md` rather than done now.
- Playwright browsers are installed per run rather than cached: chromium-only is ~30 s, and a stale
  browser cache is a worse failure than a slow install.

---

## ADR-T12 — Node 24 LTS as the baseline

### Options
1. **Node 24 LTS** (`>=24.13.0`).
2. **Node 22 LTS** — the broadest compatibility.
3. **Node 26** — newest.

### Decision — Node 24 LTS, `engines.node: ">=24.13.0"`, `.nvmrc` = `24`, `devEngines.runtime`
= `node@>=24.13.0`, CI on `node@24`.

ADR-T06 depends on type stripping being on by default and behaving identically everywhere; Node 24 is
the LTS where that is true, and it is what is already installed here (24.20.0). Node 22 would work but
would leave us on a line whose type-stripping behaviour differs. Node 26 is rejected for a reason
worth writing down: **Corepack is no longer bundled from Node 25 onwards**, so the standard
`corepack enable pnpm` onboarding step silently stops existing — a bad first five minutes for a
non-technical user. Node 24 keeps it.

---

## 2. The repository tree

```
mutuals/
├─ .github/
│  └─ workflows/ci.yml
├─ apps/
│  ├─ api/
│  │  ├─ src/
│  │  │  ├─ main.ts               # boot: env → db pool → fastify → routes → pg-boss
│  │  │  ├─ env.ts                # the Zod schema from ADR-T10
│  │  │  ├─ routes/v1/            # contacts, organizations, interactions, follow-ups,
│  │  │  │                        # attribute-definitions, views, import-batches, search, ask, stats
│  │  │  ├─ plugins/              # auth slot (§7), error shape, request logging
│  │  │  ├─ jobs/                 # pg-boss workers: import, warmth sweep, summaries   (§9 stub)
│  │  │  ├─ llm/                  # Stage 6 — provider interface, prompt versions, cost log, traces
│  │  │  └─ integrations/         # Stage 8 — fetchSince(cursor) interface               (§9 stub)
│  │  ├─ package.json
│  │  └─ tsconfig.json
│  └─ web/
│     ├─ src/
│     │  ├─ components/ui/        # shadcn, copied in and adapted
│     │  ├─ components/data-table/# the ONE DataTable (§5.2), driven by attribute definitions
│     │  ├─ features/             # contacts, organizations, follow-ups, settings, import, dashboard
│     │  ├─ lib/api-client.ts     # the only place fetch() is called
│     │  └─ main.tsx
│     ├─ components.json          # shadcn CLI config
│     ├─ index.html
│     ├─ vite.config.ts
│     ├─ package.json
│     └─ tsconfig.json
├─ packages/
│  ├─ core/
│  │  ├─ src/
│  │  │  ├─ attributes/           # the 12 types, value_kind mapping, slug rules, reserved words
│  │  │  ├─ filters/              # the filter AST + operator table, shared by API, UI and the LLM
│  │  │  ├─ warmth.ts             # computeWarmth(), k = ln4/10.445 ≈ 0.1327, + calibration test
│  │  │  ├─ dedupe.ts             # identifier-first matching with confidence scores
│  │  │  ├─ recurrence.ts         # next occurrence of a recurring follow-up
│  │  │  ├─ import/               # header synonyms, presets (LinkedIn, Google, vCard), value mapping
│  │  │  └─ index.ts
│  │  ├─ package.json             # exports "./src/index.ts" — raw TypeScript (ADR-T06)
│  │  └─ tsconfig.json
│  └─ db/
│     ├─ drizzle/                 # migrations: drizzle-kit generated + hand-authored .sql, one numbering
│     ├─ src/
│     │  ├─ schema/               # drizzle table definitions (the TS source of truth for types)
│     │  ├─ compile/              # filter AST → SQL (the three-query read path from the storage ADR)
│     │  ├─ project.ts            # the projector: fact → attribute_value / record_link / metrics
│     │  ├─ migrate.ts            # ensureDatabase() + migrator            → pnpm db:migrate
│     │  ├─ reproject.ts          # full rebuild + byte-identity assertion → pnpm db:reproject
│     │  ├─ check.ts              # CI gates: reprojection, NULL workspace_id, EXPLAIN regressions
│     │  └─ seed.ts               # ~200 contacts / 60 orgs / 500 interactions / 40 follow-ups
│     ├─ drizzle.config.ts
│     ├─ package.json
│     └─ tsconfig.json
├─ e2e/
│  ├─ tests/                      # create attribute → filter · import LinkedIn CSV with a duplicate ·
│  │                              # contact → interaction → recurring follow-up · saved view round-trip
│  ├─ playwright.config.ts
│  ├─ package.json
│  └─ tsconfig.json
├─ fixtures/
│  ├─ linkedin_connections_sample.csv
│  └─ google_contacts_sample.csv
├─ scripts/
│  └─ dev.mjs                     # ADR-T08
├─ docs/                          # PLAN.md · BRIEF.md · DECISIONS.md · ARCHITECTURE.md · API.md · refs/
├─ .editorconfig
├─ .env.example
├─ .gitignore                     # .env  .env.*  !.env.example  node_modules  dist  coverage
│                                 # e2e/test-results  e2e/playwright-report  *.tsbuildinfo
├─ .nvmrc                         # 24
├─ CLAUDE.md
├─ LICENSE                        # MIT
├─ README.md
├─ docker-compose.yml
├─ eslint.config.js
├─ package.json
├─ pnpm-lock.yaml
├─ pnpm-workspace.yaml
├─ .prettierrc.json  .prettierignore
├─ tsconfig.base.json
└─ vitest.config.ts
```

There is **no `.npmrc`**: in pnpm 11 that file carries only auth and registry settings, and we have
neither.

---

## 3. The real config files

### 3.1 `pnpm-workspace.yaml`

```yaml
packages:
  - apps/*
  - packages/*
  - e2e

# pnpm 11 no longer reads settings from package.json#pnpm, and .npmrc now holds only
# auth/registry. Everything else lives here, in camelCase.

# Exact, reproducible dependency versions in the lockfile AND in package.json.
savePrefix: ''

# Workspace packages resolve to the local source, never to the registry.
linkWorkspacePackages: deep

# pnpm >= 10 does not run dependency build scripts unless they are approved here.
# `pnpm install` prints the pending ones on first run; commit whatever it reports.
# (In v11 the key is `allowBuilds`; onlyBuiltDependencies / ignoredBuiltDependencies were removed.)
allowBuilds:
  esbuild: true                 # drizzle-kit's bundler
  '@tailwindcss/oxide': true    # Tailwind 4's native engine
strictDepBuilds: true           # default; fail the install rather than silently skipping a build

# Fail loudly instead of resolving a peer range by guessing.
strictPeerDependencies: true
dedupePeerDependents: true

# `pnpm run` re-checks that node_modules matches the lockfile before running a script,
# which is what stops "works on my machine after a rebase".
verifyDepsBeforeRun: install

# Available from pnpm 11.25 — the built-in task graph (ADR-T02's escalation step).
# Commented out on purpose: nothing in this repo builds anything another package consumes yet.
# tasks:
#   build:
#     dependsOn: ['^build']
#   test:
#     dependsOn: ['build']
```

### 3.2 Root `package.json`

```jsonc
{
  "name": "mutuals",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "packageManager": "pnpm@11.25.0",
  "engines": { "node": ">=24.13.0" },
  "devEngines": {
    "runtime":        { "name": "node", "version": ">=24.13.0", "onFail": "error" },
    "packageManager": { "name": "pnpm", "version": "11.25.0",   "onFail": "error" }
  },
  "scripts": {
    "dev":              "node scripts/dev.mjs",
    "dev:apps":         "pnpm --filter \"./apps/*\" --parallel run dev",

    "build":            "pnpm -r run build",
    "typecheck":        "pnpm -r run typecheck",
    "lint":             "eslint . && prettier --check .",
    "format":           "prettier --write . && eslint . --fix",

    "test":             "vitest run",
    "test:unit":        "vitest run --project core",
    "test:integration": "vitest run --project db --project api",
    "test:e2e":         "pnpm --filter @mutuals/e2e run test",

    "db:up":            "docker compose up -d --wait db",
    "db:down":          "docker compose down",
    "db:generate":      "pnpm --filter @mutuals/db run generate",
    "db:migrate":       "pnpm --filter @mutuals/db run migrate",
    "db:reproject":     "pnpm --filter @mutuals/db run reproject",
    "db:check":         "pnpm --filter @mutuals/db run check",
    "db:reset":         "pnpm --filter @mutuals/db run reset",
    "seed":             "pnpm --filter @mutuals/db run seed"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "eslint": "10.9.1",
    "eslint-config-prettier": "10.1.8",
    "eslint-plugin-react-hooks": "7.1.1",
    "eslint-plugin-react-refresh": "0.5.6",
    "globals": "17.12.0",
    "prettier": "3.9.6",
    "typescript": "6.0.3",
    "typescript-eslint": "8.69.0",
    "vitest": "4.1.11",
    "@types/node": "26.4.1"
  }
}
```

`savePrefix: ''` means every version above is exact, with no `^`. For a two-person open-source project
where a silent minor bump can break a build on someone else's clone, reproducibility beats
auto-updating; Dependabot/Renovate proposes upgrades as reviewable PRs instead.

### 3.3 Per-package manifests (the parts that matter)

```jsonc
// packages/db/package.json
{
  "name": "@mutuals/db",
  "version": "0.1.0", "private": true, "type": "module",
  "exports": { ".": "./src/index.ts", "./schema": "./src/schema/index.ts" },
  "scripts": {
    "generate":  "drizzle-kit generate",
    "migrate":   "node --env-file-if-exists=../../.env src/migrate.ts",
    "reproject": "node --env-file-if-exists=../../.env src/reproject.ts",
    "check":     "node --env-file-if-exists=../../.env src/check.ts",
    "reset":     "node --env-file-if-exists=../../.env src/reset.ts",
    "seed":      "node --env-file-if-exists=../../.env src/seed.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@mutuals/core": "workspace:*",
    "drizzle-orm": "0.45.2",
    "pg": "8.23.0"
  },
  "devDependencies": { "drizzle-kit": "0.31.10", "@types/pg": "8.15.6" }
}
```

```jsonc
// apps/web/package.json
{
  "name": "@mutuals/web",
  "version": "0.1.0", "private": true, "type": "module",
  "scripts": {
    "dev": "vite", "build": "vite build", "preview": "vite preview", "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@mutuals/core": "workspace:*",          // types + filter AST ONLY — never @mutuals/db
    "@tanstack/react-table": "9.2.4",
    "react": "19.2.8",
    "react-dom": "19.2.8"
  },
  "devDependencies": {
    "@tailwindcss/vite": "4.3.3",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.5",
    "@vitejs/plugin-react": "6.1.1",
    "tailwindcss": "4.3.3",
    "vite": "8.2.2"
  }
}
```

### 3.4 `apps/web/vite.config.ts`

```ts
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';   // Tailwind 4 is a Vite plugin; there is no tailwind.config.js
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  // '' as the prefix loads EVERY variable for use inside this config file.
  // It does not widen what reaches the browser: `envPrefix` (default 'VITE_') governs that.
  const env = loadEnv(mode, repoRoot, '');

  return {
    plugins: [react(), tailwindcss()],
    envDir: repoRoot,                                  // one .env for the whole monorepo (ADR-T10)
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      port: Number(env.WEB_PORT ?? 5173),
      // Same-origin in dev, so CORS never has to exist (ADR-T08).
      proxy: { '/api': { target: `http://127.0.0.1:${env.API_PORT ?? 3000}` } },
    },
    build: { outDir: 'dist', sourcemap: true },
    // If a linked workspace package ever gets pre-bundled and goes stale, uncomment:
    // optimizeDeps: { exclude: ['@mutuals/core'] },
  };
});
```

Vite 8 notes that apply here: Rolldown is the default bundler (no opt-in), the package is ESM-only,
`rollupOptions` is renamed `rolldownOptions`, and Node 20.19+/22.12+ is required — all satisfied.

### 3.5 `vitest.config.ts` (root)

```ts
import { defineConfig } from 'vitest/config';

// Vitest 4 removed `vitest.workspace.ts` and the top-level `workspace` option;
// `projects` inside the root config replaces both.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'core', root: './packages/core', environment: 'node',
                include: ['src/**/*.test.ts'] } },

      { test: { name: 'db',   root: './packages/db',   environment: 'node',
                include: ['src/**/*.test.ts'],
                globalSetup: './test/global-setup.ts',   // creates + migrates the _test database
                // one connection-owning process: these tests truncate tables
                pool: 'forks', poolOptions: { forks: { singleFork: true } } } },

      { test: { name: 'api',  root: './apps/api',      environment: 'node',
                include: ['src/**/*.test.ts'],
                globalSetup: '../../packages/db/test/global-setup.ts',
                pool: 'forks', poolOptions: { forks: { singleFork: true } } } },
    ],
  },
});
```

---

## 4. Verified vs. assumed

**Verified by running it on this machine:**
Node 24.20.0 strips types with no flag · `enum` is rejected (`erasableSyntaxOnly` is required) ·
`./a.js` is not remapped to `a.ts` · a workspace package exporting raw `.ts` resolves through a
`node_modules` symlink · `node --watch` restarts on edits inside that linked package ·
`--env-file-if-exists` loads a file and tolerates a missing one · `process.loadEnvFile` exists ·
Zod 4.5.4 exposes top-level `z.url()`/`z.email()`/`z.uuid()` and `z.url()` accepts a `postgres://` URL ·
corepack 0.35.0 present, pnpm/docker/psql/Postgres.app absent · Homebrew `pgvector` 0.8.6 declares
`build_dependencies: ["postgresql@17","postgresql@18"]` while `postgresql@16` is 16.15.

**Verified against the registry / official docs:**
every version in §1 · pnpm 11 moved settings from `package.json#pnpm` and `.npmrc` into
`pnpm-workspace.yaml` · `allowBuilds` replaced `onlyBuiltDependencies` (removed in v11), with
`strictDepBuilds` defaulting to true · pnpm 11.25 added the `tasks:` scheduler with `dependsOn` and
`^` · `pnpm/action-setup`'s README directs pnpm ≥11 users to `pnpm/setup` · `pnpm/setup@v2` inputs
(`version`, `runtime`, `cache`, `install`, `require-lockfile`, `working-directory`) and its reading of
`packageManager` / `devEngines` · TypeScript 7.0.2 ships without a stable programmatic API until 7.1,
so typescript-eslint cannot run on it · `typescript-eslint@8.69.0` peers on `typescript >=4.8.4 <6.1.0` ·
TypeScript 6.0.3 is the final JS-based compiler and deprecates `moduleResolution: node` / `baseUrl` /
`outFile` · Vite 8 defaults to Rolldown, is ESM-only, needs Node 20.19+/22.12+ · Vitest 4 replaced
`workspace` with `projects` · Vite's `envDir` / `envPrefix` semantics · Biome's `noFloatingPromises` is
a nursery rule · Postgres.app bundles pgvector · `pgvector/pgvector:pg16` exists (pgvector 0.8.6) ·
npm's `devEngines` shape (`onFail` ∈ warn|error|ignore) · OpenRouter base URL and the
`HTTP-Referer` / `X-Title` attribution headers with `OPENROUTER_APP_URL` / `OPENROUTER_APP_TITLE`.

**Assumed, with the fallback named:**
- **shadcn CLI 4.20.1 works against Vite 8 + Tailwind 4.3 + React 19.** Assumed from the docs, not run.
  Fallback: copy components from the docs by hand — that is how shadcn works anyway.
- **drizzle-kit 0.31.10's `defineConfig` shape** (`dialect: 'postgresql'`, `schema`, `out`,
  `dbCredentials.url`). The ORM ADR owns this; the storage ADR already plans hand-authored `.sql` under
  drizzle-kit's numbering for everything drizzle-kit cannot express.
- **`allowBuilds` needs exactly `esbuild` and `@tailwindcss/oxide`.** The first `pnpm install` prints
  the real list; commit that.
- **Vite serves the linked raw-`.ts` `@mutuals/core` without extra config.** Standard "internal
  packages" behaviour; fallback is `optimizeDeps.exclude`, already written into the config as a comment.
- **`pnpm lint` stays under ~30 s with type-aware rules at Stage 7 size.** Trigger for ADR-T07's
  revisit if not.

---

## 5. Open questions for humans

1. **This directory already contains a different project.** `/Users/simonfuhrbach/code/crm` holds a
   Next.js 16 + better-sqlite3 prototype (`app/`, `components/`, `db/`, `mcp/`, `package.json` named
   `mutuals`, five "Meilenstein" commits). The brief's own Step 0 says to confirm the folder before
   touching anything, and none of this ADR set can be applied without an answer: does the monorepo
   replace that prototype in place (same repo, history kept, one large restructuring commit), or start
   in a fresh directory with the prototype kept for reference?
2. **Postgres floor: keep 16, or move to 17/18?** The brief says 16 and CI is written for
   `pgvector/pgvector:pg16`. But Homebrew's pgvector bottle targets 17/18, Postgres.app ships 18, and
   Supabase provisions newer majors. Nothing in the storage design needs anything above 15. Keeping 16
   as the floor means CI is stricter than every developer machine (good) at the cost of a documented
   version mismatch; raising the floor to 17 simplifies the Homebrew instructions.
3. **Where does the shared/deployed instance run?** Supabase is fixed as the database, but the brief
   never says where the API process lives. It decides whether Stage 7 needs a `Dockerfile`, a
   `Procfile` or nothing at all, and whether "the API serves the built SPA" (ADR-T08) holds in
   production or a static host is introduced with CORS after all.
