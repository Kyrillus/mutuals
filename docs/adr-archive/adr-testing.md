# DECISION SET: Testing strategy for Mutuals

**Status:** Proposed (Stage 0). Load-bearing for `packages/test-support`, `.github/workflows/`, and every
stage's "green CI" gate.
**Depends on:** `storage-DECISION.md` (typed EAV projection over an append-only fact log). Every choice
here is consistent with it, and §9 of this document reports **three defects in that document's projector**
that only a projection-equivalence gate would have surfaced.
**Environment this was written for:** macOS 15 (Darwin 25.5.0), arm64, Node v24.20.0, Homebrew 6.0.21,
**no Docker**, **no pnpm**, **no local Postgres**.

---

## 0. The decision in one paragraph

**One runner, one database engine, three test shapes, one command.** Vitest 4.1.11 runs unit and
integration tests as two *projects* in one config; Playwright 1.62.1 runs four end-to-end flows.
Testcontainers is ruled out because it requires a Docker daemon that this machine does not have and
that a non-technical product owner should not be asked to install — instead `pnpm db:up` provisions a
**project-local Postgres 16 cluster** (its own data directory, its own port, no system service, no
sudo) from Homebrew binaries, with pgvector 0.8.6 compiled against it because Homebrew's `pgvector`
formula builds only for PG 17 and 18. Test isolation is a **template database cloned once per Vitest
worker**, reset between tests by `TRUNCATE` + re-running the baseline seed — not by wrapping tests in a
transaction, which the storage design's explicit `BEGIN`/`COMMIT`/`SET LOCAL` write path makes
impossible. Integration tests drive the **real Fastify app against the real database** through
`app.inject()`. CI is GitHub Actions with the `pgvector/pgvector:0.8.6-pg16-trixie` service container,
because neither the official `postgres` image nor the runner's preinstalled PostgreSQL 16.15 ships
pgvector. Coverage is measured everywhere and **gated only on the six domain modules the brief names**.
Green CI is exactly one command, `pnpm verify`, and it is the same command locally and in the workflow.

---

## 1. Verified vs assumed

Written in the same style as `storage-DECISION.md`, because the same rule applies: a number nobody
measured is a hypothesis.

### 1.1 Verified against the registry, the vendor docs, or this machine

| Fact | How verified |
|---|---|
| `vitest@4.1.11`, `@vitest/coverage-v8@4.1.11`, `@playwright/test@1.62.1`, `pg@8.23.0`, `drizzle-orm@0.45.2`, `drizzle-kit@0.31.10`, `fastify@5.12.1`, `pg-boss@12.29.0`, `light-my-request@6.6.0`, `eslint@10.9.1`, `typescript-eslint@8.69.0`, `prettier@3.9.6`, `pnpm@11.25.0` | `npm view <pkg> version` on this machine |
| `@faker-js/faker` dist-tags are `latest: 10.6.0`, **`stable: 10.5.0`**, `next: 10.6.0` — `latest` and `next` point at the same version, so `latest` is not the conservative pick | `npm view @faker-js/faker dist-tags --json` |
| Vitest 4 replaced `workspace` with **`test.projects`**; removed `poolOptions`, `poolMatchGlobs`, `environmentMatchGlobs`, `coverage.all`, `coverage.extensions`, `coverage.ignoreEmptyLines`, `minWorkers`; renamed `maxThreads`/`maxForks` → **`maxWorkers`** and `singleThread`/`singleFork` → `maxWorkers: 1, isolate: false`; V8 coverage is now AST-aware by default; coverage reports **only files imported during the run unless `coverage.include` is set** | vitest.dev/guide/migration.html |
| Vitest 4 `coverage.thresholds` accepts `lines`/`functions`/`branches`/`statements`, `perFile`, `autoUpdate`, `100`, **and glob-pattern keys** whose values inherit the global settings | vitest.dev/config/coverage |
| `VITEST_POOL_ID` is bounded `1..maxWorkers` (the `JEST_WORKER_ID` equivalent); `VITEST_WORKER_ID` is unbounded and increases per created worker | vitest issue #667, #1469, #9058 |
| Playwright 1.62 adds **`testConfig.retryStrategy: 'immediate' \| 'isolated'`**; `failOnFlakyTests` exists as a config option since 1.52 and as `--fail-on-flaky-tests` since 1.45; `webServer` accepts an **array** of `{command, url, name, env, cwd, timeout, reuseExistingServer, stdout, gracefulShutdown}` | playwright.dev/docs/release-notes, /docs/test-webserver |
| `pgvector/pgvector:0.8.6-pg16-trixie` exists (pushed 2026‑08‑13); so do `0.8.6-pg16`, `0.8.6-pg16-bookworm`, `pg16` | Docker Hub tags API, 32 `pg16` tags listed |
| pgvector's own GitHub Actions guidance is either a `pgvector/pgvector:pgNN` **service image** or `sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y && sudo apt-get install postgresql-NN-pgvector` on the runner; macOS is `brew install pgvector` | github.com/pgvector/setup-pgvector |
| `ubuntu-24.04` runner has **PostgreSQL 16.15 preinstalled but the service disabled**, Docker 28.0.4 available, Node 22.23.2 primary with 24.19.0 cached | actions/runner-images Ubuntu2404-Readme |
| Homebrew `pgvector@0.8.6` **build-depends only on `postgresql@17` and `postgresql@18`** — there is no PG16 build in the bottle | `brew info --json=v2 pgvector` on this machine |
| Homebrew `postgresql@16` is 16.15, keg-only, with an `arm64_tahoe` bottle (binary install, no compile) | `brew info --json=v2 postgresql@16` |
| Xcode Command Line Tools, `clang 21.0.0` and `/usr/bin/make` are present on this machine, so a pgvector source build against PG16 has its toolchain | `xcode-select -p`, `clang --version`, `which make` |
| Postgres.app 2.9.6 bundles PostgreSQL **14, 15, 16, 17, 18** and includes pgvector from PG15 onward; installable as `brew install --cask postgres-app` | `brew info --cask postgres-app`, postgresapp.com/extensions |
| `typescript@7.0.2` ships **only** `bin/tsc` (a Go-binary launcher), `dist/api/{sync,async}` (a JSON-RPC API over vendored `vscode-jsonrpc`) and `lib/version.cjs`. There is **no `lib/typescript.js`** — the classic synchronous programmatic API is gone | `npm pack typescript@7.0.2` + `tar tzf` on this machine |
| `typescript-eslint@8.69.0` peer-depends on `typescript: ">=4.8.4 <6.1.0"` and `eslint: "^8.57.0 \|\| ^9.0.0 \|\| ^10.0.0"` — TypeScript 7 is **mechanically excluded** | `npm view typescript-eslint@8.69.0 peerDependencies` |
| Microsoft's own TS 7.0 guidance for tools that import `typescript` is the npm alias `"typescript": "npm:@typescript/typescript6@^6.0.0"`; `@typescript/typescript6@6.0.2` is published with a plain `latest` tag | devblogs.microsoft.com "Announcing TypeScript 7.0 RC"; `npm view @typescript/typescript6 dist-tags` |
| TS 7's native compiler drops `target: es5`, `downlevelIteration`, `moduleResolution: node/node10/classic`, `module: amd/umd/system/none`, and **`baseUrl`** | same blog post |
| `drizzle-kit generate --custom` creates an empty, correctly numbered migration **registered in the journal**, applied by `drizzle-kit migrate` — the supported home for the hand-authored SQL that `storage-DECISION.md` §2 needs | orm.drizzle.team/docs/kit-custom-migrations |
| Latest action majors: `actions/checkout@v7.0.1`, `actions/setup-node@v7.0.0`, `pnpm/action-setup@v6.0.10`, `actions/cache@v6.1.0`, `actions/upload-artifact@v7.0.1` | GitHub releases API |
| `DROP DATABASE ... WITH (FORCE)` exists (PostgreSQL 13+), so a worker database can be recycled without hunting connections | PostgreSQL docs |

### 1.2 Assumed, with a stated fallback

- **The pgvector 0.8.6 source build against Homebrew `postgresql@16` succeeds on arm64 macOS.** Not run
  here (it installs software on the owner's machine; see Open Question 2). Fallback ladder, in order:
  Postgres.app cask (bundles PG16 **with** pgvector, zero compiling) → `postgresql@17` +
  `brew install pgvector` (bottled) with CI still proving the PG16 floor → Docker, if the owner installs
  it. **Stage 1 gate: `pnpm db:up` on a clean machine, timed, recorded in `docs/ARCHITECTURE.md`.**
- **`VITEST_POOL_ID` is populated inside `setupFiles`.** vitest#9058 reports it missing in *custom
  environment* `setup()`; we use the stock `node` environment and read it in a setup file. The harness
  throws a named error if it is unset rather than silently sharing one database, and falls back to
  `maxWorkers: 1` via `MUTUALS_TEST_WORKERS=1`.
- **`thresholds.perFile` applies to glob-scoped threshold groups**, not only to the global group. The
  docs say glob groups inherit global settings; whether `perFile` is one of them is not stated. Stage 1
  confirms with a deliberately under-covered fixture file; if it does not, the gate becomes an aggregate
  and a second script enforces a per-file floor.
- **Every timing in §8** (reset ≈ 20 ms, integration suite ≈ 40 s, CI ≈ 6 min). Extrapolated from
  statement shapes, exactly as `storage-DECISION.md` §9 extrapolated its latencies. Stage 1 replaces
  them with measurements.
- **Plan choice is reproducible between this laptop and an `ubuntu-24.04` runner** once `work_mem`,
  `random_page_cost`, `effective_cache_size` and `jit` are pinned per session and the perf database is
  `ANALYZE`d. Fallback if not: the EXPLAIN assertions become "an index scan on one of *these* indexes"
  rather than a single named index, and the strict form runs only in the nightly job.

---

## 2. ADR-T1 — Vitest 4.1.11 is the only test runner; unit and integration are two projects

### Context
The brief wants unit tests with high coverage on domain logic and integration tests against a real
database. Those are different beasts — one is pure and parallel and runs in 200 ms, the other needs a
database handle, a Fastify instance and a reset hook — but making them two *runners* means two configs,
two coverage reports, two watch modes and two mental models.

### Options
1. **Vitest 4.1.11 with `test.projects`** — one config, one CLI, `--project unit` / `--project integration`.
2. **Node's built-in `node:test` + `tsx`** — zero dependencies, ships with Node 24.
3. **Jest 30** — the most documented runner in existence.
4. **Vitest for unit, a bespoke script for integration.**

### Choice
Vitest 4.1.11, with four projects declared in one root `vitest.config.ts`: `unit`, `integration`,
`perf`, and (stubbed, off by default) `web`.

### Reasoning
- Vite 8 is already in the stack for `apps/web`; Vitest shares its transform pipeline, so there is no
  second TypeScript/ESM build story to maintain. `node:test` would need its own loader story for TS
  path aliases and would leave the frontend without a runner anyway.
- `test.projects` is the mechanism that replaced `workspace` in Vitest 4 and is *the* documented way to
  run heterogeneous suites from one config. This is the single most likely thing to be got wrong from
  stale memory, which is why it is spelled out below.
- Jest 30 is more documented but is a second toolchain next to Vite, and its ESM story is still the
  weaker one. "Boring" here means "one build pipeline", not "the oldest tool".
- Watch mode matters for the domain work the brief cares most about (the filter compiler): editing
  `compile.ts` should re-run 45 assertions in under a second, which is what the `unit` project gives.

**No component-testing layer in Phase 1.** The brief asks for unit, integration and four e2e flows, and
`storage-DECISION.md` warns against building what the stage does not need. Pure UI logic worth a test
(the filter-chip serialiser, the column-visibility reducer, relative-date resolution) is *domain* logic
and moves into `packages/core`, where the `unit` project tests it in a `node` environment with no DOM.
The `web` project exists in the config as a commented stub so adding it later is a diff, not a decision.

### Config (real)

```ts
// vitest.config.ts  — repository root
import { defineConfig } from 'vitest/config'

const INTEGRATION_WORKERS = Number(process.env.MUTUALS_TEST_WORKERS ?? '4')

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
          setupFiles: ['./test/setup.unit.ts'],
          // Domain logic must not touch the clock, the network or the filesystem.
          testTimeout: 5_000,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['apps/api/test/**/*.itest.ts', 'packages/db/test/**/*.itest.ts'],
          globalSetup: ['./test/global-setup.integration.ts'],
          setupFiles: ['./test/setup.integration.ts'],
          maxWorkers: INTEGRATION_WORKERS, // one Postgres database per worker — see ADR-T3
          fileParallelism: true,
          isolate: true,
          testTimeout: 15_000,
          hookTimeout: 60_000,
          retry: 0,                        // a flaky integration test is a bug, not a retry candidate
        },
      },
      {
        test: {
          name: 'perf',
          environment: 'node',
          include: ['perf/**/*.ptest.ts'],
          globalSetup: ['./test/global-setup.perf.ts'],
          maxWorkers: 1,                   // plan stability requires no competing load
          testTimeout: 180_000,
        },
      },
      // { test: { name: 'web', environment: 'jsdom', include: ['apps/web/src/**/*.test.tsx'] } },
    ],
    coverage: { /* ADR-T11 */ },
  },
})
```

### Consequences
- One `vitest` dependency, one `--ui`, one coverage report across projects.
- `pnpm test:unit` is safe to run with no database at all — that is enforced (ADR-T12): the `unit`
  project's setup file poisons `pg` so importing it throws.
- Vitest 4's pool rewrite means any copied-from-memory `poolOptions.threads.singleThread` config is a
  hard error. The config above is the corrected shape.

---

## 3. ADR-T2 — No Docker: a project-local Postgres 16 cluster, provisioned by `pnpm db:up`

### Context
The brief offers "a Postgres container (docker compose) or the Supabase CLI — your call". **Both
require a Docker daemon, and this machine has none.** The Supabase CLI runs its local stack in
containers, so it is ruled out by the same fact. Meanwhile the product owner is non-technical and must
be able to run the app with one command, and the repo is MIT open source, so a stranger on Linux must
be able to do the same.

### Options
1. **Testcontainers (`@testcontainers/postgresql@12.1.0`)** — the industry default for "a real database
   per test run".
2. **`embedded-postgres`** (Zonky binaries, npm) — downloads a real Postgres and runs it from Node, no
   Docker.
3. **Postgres.app** (`brew install --cask postgres-app`) — bundles PG 14–18 *including pgvector*.
4. **Homebrew `postgresql@16` + pgvector 0.8.6 built from source, in a project-local data directory.**
5. **Ask the owner to install Docker Desktop / OrbStack** and use the brief's container path.
6. **A shared remote Postgres** (a Supabase project) for dev and tests.

### Choice
**Option 4 as the scripted default, with option 3 as the documented no-compile fallback and option 1/5
auto-detected**: `pnpm db:up` uses `docker compose up -d db` *if a Docker daemon is already reachable*,
and otherwise builds a local cluster under `.pgdata/` on port `55432`.

### Reasoning
- **Testcontainers is ruled out, not disliked.** It needs a Docker daemon. Installing Docker Desktop on
  the owner's Mac to run `pnpm test` is a 700 MB VM, a background daemon, a licence question, and a
  thing a non-technical person now has to keep alive. It stays *supported* — if `docker info` succeeds,
  the compose path is used, so a contributor who already has Docker gets the familiar experience — but
  it is not a requirement.
- **`embedded-postgres` is ruled out on a hard technical fact:** the Zonky binaries it downloads do not
  include pgvector, and `storage-DECISION.md` §2.9 puts `embedding vector(1536)` in the Phase-1 schema.
  Migrations would fail at `CREATE EXTENSION vector`. Making the vector column a Stage-6 migration would
  unlock it, but that contradicts an already-accepted decision, and buying a test-only convenience with
  a change to the production schema is the wrong trade.
- **Postgres.app is genuinely attractive** — it bundles PG16 *and* pgvector, so it is the shortest path
  to a working machine — but it is a macOS GUI application, useless to a Linux contributor, and it
  installs a cluster outside the repository that the harness cannot recreate deterministically. It is
  the fallback, documented in the README, not the default.
- **Homebrew is chosen because it is the only option that is scriptable, sudo-free, version-exact and
  mirrored on Linux.** `postgresql@16` has an arm64 bottle (verified), so PostgreSQL itself is a binary
  download. Only pgvector needs compiling, and only because Homebrew's `pgvector` formula build-depends
  on `postgresql@17` and `postgresql@18` and has no PG16 build (verified). pgvector is ~4 000 lines of
  C with no dependencies beyond `pg_config`; the toolchain is present on this machine (verified).
- **A remote shared Postgres is ruled out for tests**: tests must be able to `DROP DATABASE`, must run
  offline, and must not have two developers truncating each other's rows.
- **The cluster is project-local on purpose.** Data directory `./.pgdata`, port `55432`, unix socket
  inside the repo, `trust` auth, `listen_addresses=127.0.0.1`, **not** a `brew services` daemon. So
  `rm -rf .pgdata` is a full reset, nothing collides with an existing system Postgres, and there is no
  login-item to explain to a non-technical owner.

### The script (real)

```bash
#!/usr/bin/env bash
# scripts/db-up.sh — idempotent. `pnpm db:up` calls it.
set -euo pipefail

PGPORT="${PGPORT:-55432}"
PGDATA="${PGDATA:-$PWD/.pgdata}"
PGVECTOR_REF="v0.8.6"          # >= 0.8.2 required for hnsw.iterative_scan (storage-DECISION §2.9)

log() { printf '\033[2m[db:up]\033[0m %s\n' "$*"; }

# 0. Already reachable? (covers CI's service container and any externally managed cluster.)
if [ -n "${DATABASE_URL:-}" ] && command -v pg_isready >/dev/null 2>&1 \
   && pg_isready -q -d "$DATABASE_URL" 2>/dev/null; then
  log "DATABASE_URL already reachable — nothing to do"; exit 0
fi

# 1. Docker, if the developer already runs it.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  log "docker detected — using compose"
  exec docker compose up -d --wait db
fi

# 2. Locate PostgreSQL 16 binaries.
case "$(uname -s)" in
  Darwin)
    PGHOME="$(brew --prefix postgresql@16 2>/dev/null || true)"
    if [ ! -x "${PGHOME:-/nonexistent}/bin/initdb" ]; then
      log "installing postgresql@16 via Homebrew (bottled, no compile)"
      brew install postgresql@16
      PGHOME="$(brew --prefix postgresql@16)"
    fi ;;
  Linux)
    PGHOME=/usr/lib/postgresql/16
    if [ ! -x "$PGHOME/bin/initdb" ]; then
      log "installing postgresql-16 + pgvector from the PGDG apt repository"
      sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
      sudo apt-get install -y postgresql-16 postgresql-16-pgvector postgresql-contrib-16
    fi ;;
  *) echo "Unsupported OS. Install PostgreSQL 16 + pgvector and set DATABASE_URL." >&2; exit 1 ;;
esac
export PATH="$PGHOME/bin:$PATH"

# 3. pgvector. Homebrew's formula builds only for postgresql@17/@18 (verified), so build 0.8.6 here.
EXTDIR="$(pg_config --sharedir)/extension"
if [ ! -f "$EXTDIR/vector.control" ]; then
  log "building pgvector $PGVECTOR_REF against $(pg_config --version)"
  tmp="$(mktemp -d)"
  git clone --depth 1 --branch "$PGVECTOR_REF" https://github.com/pgvector/pgvector.git "$tmp/pgvector"
  make -C "$tmp/pgvector" PG_CONFIG="$PGHOME/bin/pg_config"
  make -C "$tmp/pgvector" PG_CONFIG="$PGHOME/bin/pg_config" install
  rm -rf "$tmp"
fi

# 4. Cluster. Locale pinned so local and CI collate and case-fold identically (see §7 and ADR-T6).
if [ ! -d "$PGDATA" ]; then
  log "initdb -> $PGDATA"
  initdb -D "$PGDATA" -U mutuals --auth=trust \
         --encoding=UTF8 --lc-collate=C --lc-ctype=C >/dev/null
fi

pg_ctl -D "$PGDATA" -l "$PGDATA/server.log" -w start \
  -o "-p $PGPORT -k $PGDATA -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off \
      -c full_page_writes=off -c jit=off"

createdb -h 127.0.0.1 -p "$PGPORT" -U mutuals mutuals_dev 2>/dev/null || true
log "ready: postgres://mutuals@127.0.0.1:$PGPORT/mutuals_dev"
```

`fsync=off`, `synchronous_commit=off` and `full_page_writes=off` are **development and test settings
only** — they trade crash safety, which a disposable local cluster does not need, for roughly an order
of magnitude on the write-heavy import tests. The compose file and the CI service get the same flags.
A comment in `docker-compose.yml` and in this script says so in one line each, because a stranger
cloning the repo must not copy them into production.

### Consequences
- `pnpm db:up && pnpm db:migrate && pnpm seed && pnpm dev` is the whole local setup, no Docker.
- First run costs a Homebrew download plus a ~15 s pgvector compile. Subsequent runs are ~1 s.
- The Linux path needs `sudo` once for apt; documented in `CONTRIBUTING.md`. macOS needs none.
- Windows is not supported for development in Phase 1 (Open Question 4).
- The PG16 floor is proven by CI, not by the laptop: if the fallback ladder lands a developer on PG17
  or Postgres.app's PG18, the workflow still runs 16 on every push.

---

## 4. ADR-T3 — Template database, one clone per worker, `TRUNCATE` + baseline between tests

### Context
Integration tests must start from a known state. `storage-DECISION.md` makes the obvious approach
illegal: the write path is *explicit* SQL transactions (`BEGIN; SELECT … FOR UPDATE; UPDATE; INSERT;
SELECT project_record(…); COMMIT;`), the importer uses `SET LOCAL mutuals.defer_projection = 'on'`, and
the projector's correctness argument depends on real statement boundaries and an `AFTER STATEMENT`
trigger with a transition table.

### Options
1. **Wrap each test in a transaction and roll back** (the Rails/Django default).
2. **`CREATE DATABASE … TEMPLATE` per test** — perfect isolation, ~150–300 ms each.
3. **One template database, cloned once per Vitest worker; `TRUNCATE` + re-seed the baseline between
   tests.**
4. **A schema per test** (`SET search_path`), one database.
5. **No reset; every test creates uniquely named data.**

### Choice
Option 3.

### Reasoning
- **Option 1 is not merely slow here, it is wrong.** If the harness opens a transaction and hands the
  connection to the app, the app's own `BEGIN` produces `WARNING: there is already a transaction in
  progress` and is a no-op, and its `COMMIT` commits *the harness's* transaction — isolation is gone and
  the next test sees the previous test's rows. `SET LOCAL mutuals.defer_projection` would then be scoped
  to the outer transaction and leak across the rest of the test. Rewriting `BEGIN`/`COMMIT` into
  `SAVEPOINT`/`RELEASE` with a proxying pool is the standard trick and it is exactly the "clever
  technology" the brief tells us to avoid — and it still cannot reproduce the two-concurrent-writers
  test that `storage-DECISION.md` §10.6 demands, because both writers would share one transaction.
- **Option 2 is correct but pays a file copy on every test.** At ~250 integration tests that is 40–75 s
  of pure `createdb`.
- **Option 3 keeps the correctness of option 2 at roughly a tenth of the cost.** `TRUNCATE` of ~20 small
  tables plus re-running a ~60-row baseline should be ~15–25 ms. Every test still gets a real,
  independently connectable database with the app's own pool and its own transactions.
- **Option 4 (schema per test)** breaks the design: `CREATE EXTENSION vector` is database-scoped, the
  hand-authored migrations name `public`, and `search_path` juggling inside a `SECURITY INVOKER`
  plpgsql function is a footgun.
- **Option 5** is how test suites rot. It also cannot test `is empty`, counts, or the
  "Rows: 2,236" footer, all of which are assertions about the *whole* table.

### Implementation (real)

```ts
// packages/test-support/src/database.ts
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

const ADMIN_URL  = process.env.TEST_ADMIN_URL
  ?? 'postgres://mutuals@127.0.0.1:55432/postgres'
export const TEMPLATE_DB = 'mutuals_test_template'
const BASELINE = readFileSync('packages/db/seed/baseline.sql', 'utf8')

const ident = (n: string) => `"${n.replace(/"/g, '""')}"`
const urlFor = (db: string) => new URL(`/${db}`, ADMIN_URL).toString()

async function onAdmin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: ADMIN_URL })
  await c.connect()
  try { return await fn(c) } finally { await c.end() }
}

/** Run once per `vitest run`, from globalSetup. Migrations are expensive; do them once. */
export async function buildTemplateDatabase(): Promise<void> {
  await onAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${ident(TEMPLATE_DB)} WITH (FORCE)`)
    await c.query(`CREATE DATABASE ${ident(TEMPLATE_DB)}
                   ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`)
  })
  const c = new Client({ connectionString: urlFor(TEMPLATE_DB) })
  await c.connect()
  try {
    await migrate(drizzle(c), { migrationsFolder: 'packages/db/drizzle' })
    await c.query(BASELINE)          // workspace + profile + the seeded attribute definitions/options
    await c.query('ANALYZE')          // so the first EXPLAIN in a clone is not planning on zeroes
  } finally { await c.end() }
}

export async function cloneTemplate(name: string): Promise<string> {
  await onAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`)
    await c.query(`CREATE DATABASE ${ident(name)} TEMPLATE ${ident(TEMPLATE_DB)}`)
  })
  return urlFor(name)
}

export function workerDatabaseUrl(): string {
  const raw = process.env.VITEST_POOL_ID
  if (!raw) {
    throw new Error(
      'VITEST_POOL_ID is unset. Integration tests need one database per worker. ' +
      'Run with MUTUALS_TEST_WORKERS=1 if your Vitest build does not provide it.')
  }
  return urlFor(`mutuals_test_w${Number(raw)}`)
}

/** Between tests. Deliberately not DROP/CREATE: the app's pool stays valid across this. */
export async function resetDatabase(c: Client): Promise<void> {
  await c.query(TRUNCATE_EVERYTHING)
  await c.query(BASELINE)
}

const TRUNCATE_EVERYTHING = `
DO $$
DECLARE stmt text;
BEGIN
  SELECT 'TRUNCATE TABLE ' || string_agg(format('%I.%I', schemaname, tablename), ', ')
         || ' RESTART IDENTITY CASCADE'
    INTO stmt
    FROM pg_tables
   WHERE (schemaname = 'public' AND tablename <> '__drizzle_migrations')
      OR (schemaname = 'pgboss' AND tablename NOT IN ('version'));
  IF stmt IS NOT NULL THEN EXECUTE stmt; END IF;
END $$;`
```

The truncate list is **derived from `pg_tables`, never hand-maintained**. A table added in a future
migration is reset automatically; a hand-written list is a silent cross-test leak waiting to happen.
`CASCADE` is required because `attribute_value.option_id` and `fact.option_id` are `ON DELETE RESTRICT`
(`storage-DECISION.md` §4.7) — a per-table truncate would fail on the FK.

```ts
// test/global-setup.integration.ts
import { buildTemplateDatabase, cloneTemplate } from '@mutuals/test-support/database'

export default async function setup(): Promise<void> {
  const workers = Number(process.env.MUTUALS_TEST_WORKERS ?? '4')
  await buildTemplateDatabase()
  for (let i = 1; i <= workers; i++) await cloneTemplate(`mutuals_test_w${i}`)
}
```

```ts
// test/setup.integration.ts  — runs inside each worker
import { beforeAll, beforeEach, afterAll } from 'vitest'
import { createTestApp, type TestApp } from '@mutuals/test-support/app'

let app: TestApp
beforeAll(async () => { app = await createTestApp() })   // ONE Fastify + ONE pool per worker
beforeEach(async () => { await app.reset() })            // TRUNCATE + baseline, ~20 ms
afterAll(async () => { await app.close() })
globalThis.__mutuals = () => app
```

### Consequences
- Migrations run **once** per `vitest run`, not once per worker and not once per test.
- A worker's Fastify app and pg pool survive every reset, so app start-up cost is paid four times total.
- **This imposes a constraint on the API**: any in-memory cache (most obviously the attribute-definition
  registry the filter compiler needs) must be invalidated by `TRUNCATE`, which fires no application
  code. The rule, enforced by a test: **the definition registry is either read per request or keyed by a
  `bump` token stored in the `workspace` row**, which the reset restores. `apps/api/test/cache.itest.ts`
  creates an attribute, resets, and asserts the old attribute is gone from `GET /attribute-definitions`.
- Debugging is easy: a failing test leaves `mutuals_test_w2` on disk with the exact state; `psql
  mutuals_test_w2` just works. Worker databases are dropped at the start of the next run, not the end of
  this one, on purpose.

---

## 5. ADR-T4 — Integration tests drive the real Fastify app via `app.inject()`, on the real database

### Context
"Integration tests for the API against a REAL database covering each resource's happy path, validation
errors and dynamic filter/sort on custom attributes."

### Options
1. **`app.inject()`** (Fastify's built-in `light-my-request@6.6.0`) against a real database.
2. **`app.listen({ port: 0 })` + `supertest` or `fetch`** — a real TCP socket.
3. **Call the service layer directly**, skipping HTTP.

### Choice
Option 1 as the default; option 2 for the small set of tests where the socket is the thing under test.

### Reasoning
- `inject()` exercises the **entire** Fastify pipeline — routing, the Zod type-provider's request
  validation, serialisation, the error handler, hooks, and the auth middleware slot §7 reserves — while
  skipping only the kernel. That is the whole of "the API" as the brief means it.
- It is ~1 ms faster per call than a socket round trip and needs no port allocation, which matters when
  four workers run in parallel.
- **Option 3 is rejected outright**: it would not catch a wrong status code, a missing field in the
  response schema, a Zod coercion difference, or a filter that the query-string parser mangles — and the
  query-string filter model is precisely the fragile surface the brief singles out.
- Option 2 is kept for exactly two things, where `inject()` is not equivalent: **multipart/streamed CSV
  upload** for the 10k-row import (`inject` buffers the payload, so it cannot prove the streaming path),
  and any future SSE/long-poll endpoint. One `describe` block, one real server, `workers: 1`.

### Shape (real)

```ts
// packages/test-support/src/app.ts
import { buildApp } from '@mutuals/api/app'
import { Client } from 'pg'
import { workerDatabaseUrl, resetDatabase } from './database.js'
import { fakeLlm } from './fake-llm.js'

export async function createTestApp() {
  const databaseUrl = workerDatabaseUrl()
  const app = await buildApp({
    databaseUrl,
    llm: fakeLlm(),          // ADR-T12: no network, ever
    jobs: 'inline',          // pg-boss handlers run synchronously; no polling in tests
    now: () => FIXED_NOW,    // ADR-T12
    logger: false,
  })
  await app.ready()
  const admin = new Client({ connectionString: databaseUrl })
  await admin.connect()
  return {
    app,
    admin,
    reset: () => resetDatabase(admin),
    close: async () => { await app.close(); await admin.end() },
  }
}
```

```ts
// apps/api/test/contacts.itest.ts
import { describe, it, expect } from 'vitest'
import { api } from '@mutuals/test-support'
import { anAttribute, aContact } from '@mutuals/test-support/factories'

describe('GET /api/v1/contacts', () => {
  it('filters and sorts on a user-defined number attribute', async () => {
    await anAttribute({ slug: 'check_size', type: 'number', objectType: 'contact' })
    await aContact({ firstName: 'Anna', values: { check_size: 250_000, city: 'München' } })
    await aContact({ firstName: 'Bo',    values: { check_size: 750_000, city: 'Munich'  } })
    await aContact({ firstName: 'Cleo',  values: { city: 'Berlin' } })

    const res = await api().get('/api/v1/contacts', {
      filter: [{ slug: 'city', op: 'contains', value: 'munich' }],
      sort:   { slug: 'check_size', direction: 'desc' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().data.map((r) => r.display_name)).toEqual(['Bo', 'Anna'])
    expect(res.json().meta.total).toBe(2)          // Q3, the footer count
  })

  it('refuses to sort on a non-sortable type instead of silently ignoring it', async () => {
    await anAttribute({ slug: 'notes2', type: 'long_text', objectType: 'contact' })
    const res = await api().get('/api/v1/contacts', { sort: { slug: 'notes2', direction: 'asc' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().errors[0]).toMatchObject({ field: 'sort.slug', code: 'not_sortable' })
  })
})
```

The first test is not decoration: `'München'` and `'Munich'` both matching `'munich'` is the
`lower(unaccent(btrim(·)))` contract from `storage-DECISION.md` §2.5, asserted end-to-end through the
query string, the compiler, the index and the projector.

### Per-resource template
Every resource (contacts, organizations, interactions, follow-ups, attribute-definitions, views,
import-batches, search, ask, quick-capture) gets one `*.itest.ts` with the same five blocks, so a
missing block is visible in review:
1. happy path create → read back → list;
2. validation errors (per-field shape, exact codes);
3. the dynamic filter/sort matrix for that object type;
4. the destructive path with its count-before-delete contract (§5.4 of the brief);
5. the "not found" / wrong-object-type path.

### Consequences
- No `supertest` dependency for 95 % of tests.
- Response *shape* is additionally pinned by an OpenAPI contract test: the generated document is a
  committed snapshot, and a diff fails CI, so a breaking API change cannot land silently on the MCP
  server or a CLI client (§7 of the brief).

---

## 6. ADR-T5 — Factories are typed builders that go through the real write path

### Context
Tests need contacts with custom attribute values. There are two ways to make one: insert rows, or use
the product's own write path.

### Options
1. **Typed builder functions in `packages/test-support`** that call the API/`packages/core` write path.
2. **A factory library** (`fishery@2.4.0`, `factory.ts`, `rosie`).
3. **Raw SQL inserts** into `record`/`contact`/`fact`/`attribute_value`.
4. **A committed SQL dump** restored per test.

### Choice
Option 1, over `@faker-js/faker@10.5.0` (the `stable` dist-tag, not `latest` — see §1.1) with a fixed
seed.

### Reasoning
- **Option 3 is the trap.** Inserting straight into `attribute_value` would let a test pass while the
  projector is broken, and would silently skip the `fact` supersession, the identifier write-through and
  the `search_document` rebuild. Every fixture must be built the way a user builds it, so that fixture
  construction is itself a test of the write path. (One deliberate exception: the perf generator in
  ADR-T8 uses the *bulk* path, because that is the path a 10k import actually takes.)
- **Option 2 buys little.** Fishery's value is sequences, traits and associations; here the associations
  are the product's own relation model and the "traits" are attribute values, both of which a
  30-line typed builder expresses more clearly than a library's DSL. Rejected as a dependency that
  earns less than it costs.
- **Option 4** couples every test to a schema snapshot that must be regenerated on every migration.
- Faker gives realistic names, cities and companies — which matters, because the duplicate matcher and
  the trigram search behave differently on `Müller` than on `test_user_1`. It is **seeded** so runs are
  reproducible (ADR-T12).

### Shape (real)

```ts
// packages/test-support/src/factories.ts
import { faker } from '@faker-js/faker'

export interface ContactSpec {
  firstName?: string
  lastName?: string
  /** slug -> value, in the API's wire shape. Unknown slugs throw at build time. */
  values?: Record<string, unknown>
  organization?: { name: string; title?: string; from?: string; isPrimary?: boolean }
  provenance?: { createdVia: 'manual' | 'import' | 'api' | 'agent'; importBatchId?: string }
}

/** Creates a contact through POST /api/v1/contacts. Returns the API's representation. */
export async function aContact(spec: ContactSpec = {}): Promise<ContactDto> {
  const body = {
    first_name: spec.firstName ?? faker.person.firstName(),
    last_name:  spec.lastName  ?? faker.person.lastName(),
    values:     spec.values ?? {},
    ...
  }
  const res = await api().post('/api/v1/contacts', body)
  if (res.statusCode !== 201) throw new FactoryError('aContact', body, res)
  return res.json()
}

export async function anAttribute(spec: AttributeSpec): Promise<AttributeDto> { /* POST … */ }
export async function anInteraction(spec: InteractionSpec): Promise<InteractionDto> { /* … */ }
export async function aFollowUp(spec: FollowUpSpec): Promise<FollowUpDto> { /* … */ }
export async function anOrganization(spec: OrgSpec): Promise<OrgDto> { /* … */ }

/** The one deliberate low-level factory: builds fact history that no API can produce in one call. */
export async function withFactHistory(
  recordId: string, slug: string, history: FactHistoryEntry[]): Promise<void> { /* … */ }
```

`FactoryError` prints the request body and the validation response. A factory that fails because the
API changed must say *why* in the first line of output; the single biggest cost of a hand-rolled factory
layer is opaque setup failures, and this is the cheapest possible mitigation.

**Scenario builders**, one level up, are what tests actually call for the interesting cases:

```ts
export const scenarios = {
  /** Anna, at Northstar since 2023, three interactions, one overdue quarterly follow-up. */
  warmInvestor: () => Promise<{ contact: ContactDto; org: OrgDto; followUp: FollowUpDto }>,
  /** Two contacts sharing an email — the certain-duplicate case for §6.8. */
  identifierDuplicate: () => Promise<[ContactDto, ContactDto]>,
  /** Same normalised name + same current organization, no shared identifier — the fallback case. */
  nameOnlyDuplicate: () => Promise<[ContactDto, ContactDto]>,
  /** One record with a value for every one of the twelve attribute types. */
  everyType: () => Promise<{ contact: ContactDto; defs: Record<AttributeType, AttributeDto> }>,
}
```

`scenarios.everyType()` is the fixture behind the filter matrix (ADR-T6) and the hydration test, and it
is the reason adding a thirteenth attribute type would fail loudly in a dozen places rather than
silently in none.

### Consequences
- Every fixture is a small integration test of the write path.
- Fixture construction costs an HTTP-shaped call each (~2–4 ms with `inject`), so a test that needs 50
  contacts should call the bulk factory, not loop. `manyContacts(n)` uses the importer's set-based path.
- `packages/test-support` is a real workspace package with its own `tsconfig`, imported only by tests,
  and excluded from the published build.

---

## 7. ADR-T6 — The filter compiler is tested three ways, and normalisation gets a contract test

### Context
The brief singles out "filter → query compilation" for high coverage. `storage-DECISION.md` §5.3
specifies ~45 (type, operator) cases across a closed set of eight column literals, and §10.8 asks for
"≥ 45 unit tests … asserting the emitted SQL string and parameter array, with no database".

A golden SQL test proves the compiler emits what we wrote down. It does **not** prove the SQL means
what we think, and it does **not** prove the index is used. Those are three different failures.

### Options
1. **Golden SQL string + parameter array only** (no database) — fast, exhaustive, cheap.
2. **Database-level assertions only** — "these filters return these ids".
3. **Both, plus EXPLAIN plan assertions (ADR-T8), with a completeness check tying them together.**

### Choice
Option 3.

### Reasoning
- Golden tests catch the injection-shaped change (a slug reaching a SQL identifier), the accidental
  operator swap, and the parameter that stopped being bound — in 40 ms, with no database, in watch mode.
- Semantic tests catch the case where the SQL is *valid and wrong*: `number ≠ x` accidentally including
  empties, `single_select is not one of` accidentally excluding them (the two conventions
  `storage-DECISION.md` §3.4 deliberately chose between), `tags contains all of` counting duplicates.
- Neither catches the rewrite that is correct but drops to a sequential scan, which is the failure the
  brief's "must feel instant" clause is about. That is ADR-T8.
- The three are tied together by a **completeness assertion**, so the suite cannot silently lose a case:

```ts
// packages/core/src/filters/compile.test.ts
import { OPERATORS_BY_TYPE, compileFilter } from './compile.js'

const CASES = [ /* one entry per (type, operator), each with expected sql + params */ ]

it('covers every (type, operator) pair the product exposes', () => {
  const covered = new Set(CASES.map((c) => `${c.type}:${c.op}`))
  const required = Object.entries(OPERATORS_BY_TYPE)
    .flatMap(([type, ops]) => ops.map((op) => `${type}:${op}`))
  expect([...required].filter((k) => !covered.has(k))).toEqual([])
})

it('single_select "is not one of" is NOT EXISTS, and therefore includes empty records', () => {
  const { sql, params } = compileFilter(defs.job_role, 'is_not_one_of', ['investor', 'angel'])
  expect(sql).toBe(
    'NOT EXISTS (SELECT 1 FROM attribute_value v ' +
    'WHERE v.record_id = r.id AND v.attribute_id = $1 AND v.option_id = ANY($2::uuid[]))')
  expect(params).toEqual([defs.job_role.id, [OPT.investor, OPT.angel]])
})

it('never puts user input anywhere but a bind parameter', () => {
  for (const evil of ["'; DROP TABLE record; --", 'city"', '%_\\', ' ']) {
    for (const c of CASES) {
      const { sql, params } = compileFilter(defs[c.type], c.op, [evil])
      expect(sql).not.toContain(evil)
      expect(params.flat()).toContain(expect.anything())
    }
  }
})
```

Adding a thirteenth attribute type therefore fails `covers every (type, operator) pair` before it fails
anything else.

### The normalisation contract test — the highest-value test in the suite

`storage-DECISION.md` §5.3 says the needle is normalised **in `packages/core`** and the index is built
from `lower(unaccent(btrim(·)))` **in SQL**. If those two implementations ever disagree by one
character, filters silently return fewer rows — the exact failure mode the whole storage decision was
chosen to avoid. Nothing else in the suite would catch it.

```ts
// packages/db/test/normalisation-contract.itest.ts
import { normaliseText } from '@mutuals/core/text'

const FIXTURES = [
  'München', 'MÜNCHEN', '  Anna  Berger ', 'Ärztin', 'Æther', 'Łódź', 'İstanbul', 'Straße',
  'São Paulo', 'Ægir', 'Ωμέγα', 'Кириллица', 'áccent', '  ', 'ÉCOLE', 'ﬁligree', '🙂 emoji',
]

it.each(FIXTURES)('TypeScript and Postgres normalise %j identically', async (input) => {
  const { rows } = await admin.query(
    'SELECT lower(unaccent(btrim($1::text))) AS pg', [input])
  expect(normaliseText(input)).toBe(rows[0].pg)
})
```

This also pins the cluster locale decision from ADR-T2: `lc_ctype` changes what `lower()` does to
non-latin characters, so if a developer's cluster was initialised with a different locale, this test
fails on the Greek and Cyrillic fixtures with a readable diff instead of producing a subtly broken
search three stages later. A companion assertion checks the database itself:

```ts
it('the test database uses the pinned encoding and locale', async () => {
  const { rows } = await admin.query(
    `SELECT pg_encoding_to_char(encoding) enc, datcollate, datctype
       FROM pg_database WHERE datname = current_database()`)
  expect(rows[0]).toMatchObject({ enc: 'UTF8', datcollate: 'C', datctype: 'C' })
})
```

### Consequences
- ~60 no-database unit tests, ~45 database-backed matrix tests, ~17 normalisation assertions.
- The golden strings are written as plain `toBe` on a single-line normalised SQL string, not inline
  snapshots: a snapshot that can be auto-updated with `-u` is not a gate.

---

## 8. ADR-T7 — The projection-equivalence gate compares a canonical content digest, not raw rows

### Context
`storage-DECISION.md` §4.6 makes this the whole safety argument for keeping a derived copy: "*Stage 1's
test suite runs `db:reproject` after every fixture load and after the API mutation suite, and asserts
the result is byte-identical.*"

Taken literally, that assertion **cannot pass**, and finding out why is exactly what a testing decision
is for.

### The problem
1. `attribute_value.id` is `gen_random_uuid()` and `updated_at` is `now()`. A reproject regenerates
   both. Raw rows can never be byte-identical.
2. `identifier` is *not* a projection. §4.5 step 3 inserts `ON CONFLICT DO NOTHING` and §4.6 says
   identifiers accumulate — "keeps every handle ever seen". A full reproject of a record whose email
   changed produces a **subset** of the identifier rows that exist. Comparing it as a projection would
   fail on correct behaviour.
3. **`search_document.body` is non-deterministic.** §4.5 step 4 builds it from three `string_agg(...)`
   calls **with no `ORDER BY`**. `string_agg` without `ORDER BY` has unspecified input order, so the
   incremental projection and the full reproject can produce the same words in a different order — and
   `tsv` is `GENERATED ALWAYS` from it, so the generated column differs too.
4. **`attribute_value.position` is non-deterministic on ties.** §4.5 uses
   `row_number() OVER (PARTITION BY f.attribute_id ORDER BY f.value_key, f.observed_at)`. In a `COPY`
   import every fact shares one `now()`, so `observed_at` ties and the row numbering is arbitrary; the
   incremental path and the bulk path can assign different positions to the same tags.

Items 3 and 4 are **defects in the projector**, not in the test. They must be fixed in Stage 1:
`string_agg(… ORDER BY v.attribute_id, v.value_key)` in all three aggregates, and `, f.id` appended as
the final tiebreaker in both `row_number()` windows. Without those fixes the gate is unimplementable and
tag order in the UI is arbitrary between an import and an edit.

### Options
1. **Row-by-row equality of the derived tables** — impossible, see above.
2. **A canonical content digest** over the columns that are genuinely derived, excluding surrogate keys
   and timestamps, with `identifier` asserted by a different rule.
3. **`pg_dump --data-only` diff** of the derived tables.

### Choice
Option 2.

```sql
-- packages/db/test/sql/projection_digest.sql  (created in the test database only)
CREATE OR REPLACE FUNCTION test_projection_digest() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(string_agg(chunk, '|' ORDER BY chunk)) FROM (
    SELECT concat_ws(':', 'av', v.record_id, v.attribute_id, v.value_key, v.position, v.fact_id,
                     coalesce(v.text_value,''), coalesce(v.text_norm,''), coalesce(v.text_sort,''),
                     coalesce(v.num_value::text,''), coalesce(v.date_value::text,''),
                     coalesce(v.bool_value::text,''), coalesce(v.option_id::text,'')) AS chunk
      FROM attribute_value v
    UNION ALL
    SELECT concat_ws(':', 'rl', l.from_record_id, l.attribute_id, l.to_record_id,
                     coalesce(l.title,''), coalesce(l.valid_from::text,''),
                     coalesce(l.valid_to::text,''), l.is_primary, l.position, l.fact_id)
      FROM record_link l
    UNION ALL
    SELECT concat_ws(':', 'sd', d.record_id, d.title, d.body) FROM search_document d
  ) s;
$$;
```

`identifier` is asserted by its own two invariants rather than by the digest:

```ts
it('every live email/phone/url value has an identifier row, and no identifier outlives its record', async () => {
  const orphans = await admin.query(
    `SELECT i.id FROM identifier i LEFT JOIN record r ON r.id = i.record_id WHERE r.id IS NULL`)
  expect(orphans.rowCount).toBe(0)

  const missing = await admin.query(`
    SELECT v.record_id, d.slug FROM attribute_value v
      JOIN attribute_definition d ON d.id = v.attribute_id
     WHERE (d.type IN ('email','phone') OR d.slug IN ('linkedin_url','website'))
       AND NOT EXISTS (SELECT 1 FROM identifier i
                        WHERE i.record_id = v.record_id AND i.value = v.text_norm)`)
  expect(missing.rows).toEqual([])
})
```

The gate itself:

```ts
// apps/api/test/projection-equivalence.itest.ts  — runs last, on the accumulated state
it('a full reproject reproduces the incremental projection exactly', async () => {
  const before = await digest()
  await reprojectEverything(admin)          // the same code path as `pnpm db:reproject`
  expect(await digest()).toBe(before)
})
```

and, in CI, once more over the whole seeded dataset (`pnpm db:reproject:verify`) after the integration
project has finished, so the gate sees state produced by hundreds of different mutations rather than by
one fixture.

### Consequences
- The gate is implementable, and it is a real gate: it would have caught the two projector defects above.
- Two Stage-1 tasks are created (`ORDER BY` inside the `string_agg`s; `f.id` tiebreaker in both
  `row_number()`s) and must be reflected back into `docs/DECISIONS.md`, since they change SQL that
  `storage-DECISION.md` presents as final.

---

## 9. ADR-T8 — EXPLAIN tests assert plan shape, never latency; the 10k suite is nightly

### Context
`storage-DECISION.md` §10.4/§10.5 requires `EXPLAIN (ANALYZE, BUFFERS)` recorded for every operator and
"standing EXPLAIN regression assertions that each of the nine indexes is chosen for its operator and
that both sort directions produce NULLS LAST without a spilled sort". §9 says every latency figure in
that document is an extrapolation.

### Options
1. **Latency budgets in CI** ("Q1 under 10 ms or fail").
2. **Plan-shape assertions**: the named index appears, no `Seq Scan` on `attribute_value`, no disk sort.
3. **Both, with latency as a nightly trend and plan shape as the hard gate.**
4. **No performance tests; measure by hand at Stage 7.**

### Choice
Option 3.

### Reasoning
- A GitHub-hosted runner is a noisy, shared, throttled 4-vCPU VM. A 10 ms budget there is a coin flip,
  and a coin-flip gate gets disabled within two weeks — which is worse than having no gate, because the
  team then believes it has one.
- **Plan shape is stable and is the thing we actually care about.** "Uses `av_attr_date_idx`" and
  "`Sort Space Type` is not `Disk`" are properties of the planner given the data and the settings, not
  of the machine's mood. If a refactor turns an `EXISTS` into a `JOIN` and loses the semi-join pull-up
  (`storage-DECISION.md` §5.2), the plan changes and the test fails, on any machine.
- Latency still has to be *seen*, so the nightly job records timings into a committed
  `perf/baseline.json` and prints a table in the job summary. A regression there opens an issue; it does
  not block a PR.

```ts
// perf/explain.ptest.ts
import { planFor, usesIndex, hasSeqScanOn, hasDiskSort } from '@mutuals/test-support/explain'

beforeAll(async () => {
  // Pinned so the plan is a function of the data, not of the host.
  await perfDb.query(`SET work_mem = '4MB'; SET random_page_cost = 1.1;
                      SET effective_cache_size = '4GB'; SET jit = off;
                      SET join_collapse_limit = 16; SET from_collapse_limit = 16;
                      SET geqo_threshold = 20;`)
})

const OPERATOR_INDEX_MATRIX = [
  { name: 'short_text contains',      filter: …, index: 'av_trgm_idx' },
  { name: 'short_text equals',        filter: …, index: 'av_attr_text_idx' },
  { name: 'number between',           filter: …, index: 'av_attr_num_idx' },
  { name: 'date before',              filter: …, index: 'av_attr_date_idx' },
  { name: 'yes_no is yes',            filter: …, index: 'av_attr_bool_idx' },
  { name: 'single_select is one of',  filter: …, index: 'av_attr_opt_idx' },
  { name: 'tags contains any of',     filter: …, index: 'av_attr_key_idx' },
  { name: 'is empty (anti-join)',     filter: …, index: 'av_attr_rec_idx' },
  { name: 'relation has any of',      filter: …, index: 'rl_uq' },
]

it.each(OPERATOR_INDEX_MATRIX)('$name is served by $index', async ({ filter, index }) => {
  const plan = await planFor(buildListQuery({ filter }))
  expect(usesIndex(plan, index)).toBe(true)
  expect(hasSeqScanOn(plan, 'attribute_value')).toBe(false)
})

it.each(['asc', 'desc'] as const)('sorting %s puts NULLS LAST and never spills to disk', async (dir) => {
  const plan = await planFor(buildListQuery({ sort: { slug: 'check_size', direction: dir } }))
  expect(hasDiskSort(plan)).toBe(false)
  expect(sortKeysOf(plan)).toEqual([`sv.num_value ${dir.toUpperCase()} NULLS LAST`, `r.id ${dir.toUpperCase()}`])
})
```

```ts
// packages/test-support/src/explain.ts
export async function planFor(q: { sql: string; params: unknown[] }): Promise<PlanNode> {
  const { rows } = await perfDb.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.sql}`, q.params)
  return rows[0]['QUERY PLAN'][0].Plan
}
const walk = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(walk)]
export const usesIndex   = (p: PlanNode, name: string) => walk(p).some((n) => n['Index Name'] === name)
export const hasDiskSort = (p: PlanNode) =>
  walk(p).some((n) => n['Node Type'] === 'Sort' && n['Sort Space Type'] === 'Disk')
export const hasSeqScanOn = (p: PlanNode, rel: string) =>
  walk(p).some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === rel)
```

### The perf database is separate and never truncated
Plan choice depends on statistics. The `perf` project builds `mutuals_perf` **once** from the 10k × 60
generator (via the importer's set-based bulk path, so it also exercises §4.6), runs `VACUUM ANALYZE`, and
reuses it across runs unless `--force` is passed. It is never `TRUNCATE`d, because truncating and
regenerating is the fastest way to get a database whose statistics do not match its contents.

`pnpm perf:record` writes `EXPLAIN (ANALYZE, BUFFERS)` text for every matrix entry plus the three Q1
filter shapes into `docs/ARCHITECTURE.md` between marker comments, satisfying `storage-DECISION.md`
§10.4 as a repeatable command rather than a one-off paste.

### Consequences
- CI stays honest: a plan regression fails a PR, a timing wobble does not.
- The nightly job costs ~6 minutes and runs on `schedule` and `workflow_dispatch` only.
- The generator is a real deliverable (`pnpm perf:generate`), reusable for manual "does it feel instant"
  checks at Stage 7.

---

## 10. ADR-T9 — CI: GitHub Actions with a `pgvector/pgvector:0.8.6-pg16-trixie` service container

### Context
The question "does GitHub Actions' postgres service have pgvector?" has a specific answer worth stating
plainly, because it is the most common way this setup breaks.

**No, twice over.** The `ubuntu-24.04` runner does ship **PostgreSQL 16.15**, but with the service
disabled *and without pgvector*. And the popular `services: postgres: image: postgres:16` recipe uses
the official Docker image, which also has no pgvector. `CREATE EXTENSION vector` fails in both. What
*is* available in both is `pg_trgm`, `btree_gin` and `unaccent`, which come from `postgresql-contrib`.

### Options
1. **`image: pgvector/pgvector:0.8.6-pg16-trixie`** as the service container.
2. **Start the runner's preinstalled PG 16.15 and apt-install pgvector** from PGDG
   (`sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y && sudo apt-get install
   postgresql-16-pgvector`) — pgvector's own documented runner recipe.
3. **Build a custom image** and push it to GHCR.
4. **Drop pgvector from Phase 1** so any postgres image works.

### Choice
Option 1, with option 2 written into `CONTRIBUTING.md` as the recipe for forks and self-hosted runners.

### Reasoning
- Option 1 is one line, is the vendor's own first recommendation, pins the extension version exactly
  (`0.8.6` ≥ the `0.8.2` floor `storage-DECISION.md` §2.9 requires for `hnsw.iterative_scan`), and pins
  the Postgres major to the brief's 16 regardless of what the runner image does next quarter.
- Option 2 adds ~40 s of apt on every run and couples CI to whatever PostgreSQL major the runner image
  ships — a silent upgrade from 16 to 17 would go unnoticed.
- Option 3 is real infrastructure to own for zero benefit over a published, maintained image.
- Option 4 changes the product schema to make CI easier. Wrong direction.

### The preflight step matters more than the image
The single most useful CI step is the one that fails with a sentence a human can act on:

```ts
// scripts/check-db.ts   —  `pnpm db:check`
const REQUIRED = ['vector', 'pg_trgm', 'btree_gin', 'unaccent', 'pgcrypto'] as const
const { rows: [v] } = await c.query('SHOW server_version_num')
if (Number(v.server_version_num) < 160000)
  fail(`Postgres ${v.server_version_num} is older than the 16.0 floor this schema targets.`)

const { rows } = await c.query(
  'SELECT name FROM pg_available_extensions WHERE name = ANY($1)', [REQUIRED])
const missing = REQUIRED.filter((r) => !rows.some((x) => x.name === r))
if (missing.length) fail(
  `Missing Postgres extensions: ${missing.join(', ')}\n` +
  `  macOS  : pnpm db:up   (installs postgresql@16 and builds pgvector 0.8.6)\n` +
  `  Ubuntu : sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y && \\\n` +
  `           sudo apt-get install postgresql-16-pgvector postgresql-contrib-16\n` +
  `  CI     : services.postgres.image must be pgvector/pgvector:0.8.6-pg16-trixie`)
```

This is also `storage-DECISION.md` §10.10 ("migration 0002 fails loudly if `btree_gin` or `unaccent` is
unavailable") moved one step earlier, where the error is cheaper.

### The workflow (real)

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push: { branches: [main] }
  pull_request:
  workflow_dispatch:

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  MUTUALS_TEST_WORKERS: '4'
  TEST_ADMIN_URL: postgres://postgres:postgres@127.0.0.1:5432/postgres
  DATABASE_URL: postgres://postgres:postgres@127.0.0.1:5432/mutuals_dev

jobs:
  verify:
    name: lint · typecheck · unit · integration
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    services:
      postgres:
        # The official `postgres:16` image and the runner's preinstalled PG 16.15 both LACK pgvector.
        image: pgvector/pgvector:0.8.6-pg16-trixie
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_INITDB_ARGS: "--encoding=UTF8 --lc-collate=C --lc-ctype=C"
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s --health-timeout 5s --health-retries 20
          --tmpfs /var/lib/postgresql/data:rw
        ports: ['5432:5432']
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6           # reads `packageManager` from package.json
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc          # 24.20.0 — same as the developers' machines
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:check
      - run: pnpm verify:static              # format:check + lint + typecheck
      - run: pnpm test:unit --coverage
      - run: pnpm test:integration
      - run: pnpm db:reproject:verify        # ADR-T7, over the accumulated mutation state
      - uses: actions/upload-artifact@v7
        if: always()
        with: { name: coverage, path: coverage/, retention-days: 7 }

  e2e:
    name: playwright
    runs-on: ubuntu-24.04
    timeout-minutes: 25
    services:
      postgres:
        image: pgvector/pgvector:0.8.6-pg16-trixie
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_INITDB_ARGS: "--encoding=UTF8 --lc-collate=C --lc-ctype=C"
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s --health-timeout 5s --health-retries 20
        ports: ['5432:5432']
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - id: pw
        run: echo "version=$(node -p "require('@playwright/test/package.json').version")" >> "$GITHUB_OUTPUT"
      - uses: actions/cache@v6
        with:
          path: ~/.cache/ms-playwright
          key: pw-${{ runner.os }}-${{ steps.pw.outputs.version }}
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm db:check && pnpm db:migrate
      - run: pnpm build
      - run: pnpm test:e2e
      - uses: actions/upload-artifact@v7
        if: ${{ !cancelled() }}
        with: { name: playwright-report, path: playwright-report/, retention-days: 7 }
```

```yaml
# .github/workflows/nightly.yml — the 10k perf suite, never on the PR path
name: Nightly perf
on:
  schedule: [{ cron: '0 3 * * *' }]
  workflow_dispatch:
jobs:
  perf:
    runs-on: ubuntu-24.04
    timeout-minutes: 45
    services: { postgres: { image: pgvector/pgvector:0.8.6-pg16-trixie, ... } }
    steps:
      - ...
      - run: pnpm perf:generate           # 10k contacts x 60 attributes, via the bulk import path
      - run: pnpm perf:record             # rewrites the EXPLAIN block in docs/ARCHITECTURE.md
      - run: pnpm test:perf                # plan-shape assertions
      - run: node scripts/perf-summary.mjs >> "$GITHUB_STEP_SUMMARY"
```

Notes on details that matter:
- `--tmpfs /var/lib/postgresql/data` puts the CI cluster in RAM. Combined with the `db:up` durability
  flags this is the cheapest available speed-up for the truncate-heavy integration suite.
- `POSTGRES_INITDB_ARGS` pins encoding and locale to match `pnpm db:up`, so the normalisation contract
  test (ADR-T6) is comparing like with like.
- `e2e` is a separate job so a broken UI does not delay the lint/type/unit signal, and so the Playwright
  browser cache is scoped to the job that needs it.
- Node is pinned by `.nvmrc`. The runner caches 24.19.0; pinning 24.20.0 costs ~10 s of download and buys
  "the same Node everywhere", which is the trade this project should make.

### Consequences
- Expected wall clock: `verify` ~5–7 min, `e2e` ~6–9 min, in parallel.
- Branch protection requires both jobs (Open Question 1).
- Nothing in CI reaches the network except the package registry, the Playwright CDN and Docker Hub.

---

## 11. ADR-T10 — Playwright 1.62.1, Chromium only, seeded from Node, one worker, isolated retries

### Context
Four flows, named in §8.1 of the brief:
1. create attribute → appears in the table → filter by it;
2. import a LinkedIn CSV fixture end to end, with a duplicate;
3. create contact → add interaction → add follow-up → mark done (a recurring one creates the next);
4. saved view round-trip.

The hard part is not the browser. It is getting the app to a known database state on each test without
inventing a second seeding mechanism.

### Options for seeding
1. **A test-only HTTP route** `POST /__test__/reset`, enabled by an env var.
2. **Call `resetDatabase()` / `seedE2E()` directly from the Playwright fixture**, since Playwright tests
   are ordinary Node processes.
3. **Shell out to `pnpm seed` between tests.**
4. **Mock the API entirely** (MSW / `page.route`) so no database is involved.

### Choice
Option 2.

### Reasoning
- Option 2 needs **zero test-only code in the product**. That is decisive: a reset endpoint is a route
  that deletes everything, and the only thing standing between it and production is an env-var check that
  someone will eventually get wrong. Playwright's test process can `import { resetDatabase } from
  '@mutuals/test-support/database'` and talk to Postgres directly — the same helper the Vitest
  integration project uses, so there is exactly one seeding implementation in the repo.
- The API's connection pool survives a `TRUNCATE` (rows go, tables stay), so the running server does not
  need to be restarted between tests. The one caveat is the same one as ADR-T3: **no unbounded in-memory
  caches in the API**, which is already a test.
- Option 4 is rejected on principle for e2e: a mocked API would pass while the filter compiler returns
  the wrong rows, which is the single most valuable thing these four flows can catch.
- Option 3 costs a process spawn (~2 s) per test for no benefit over option 2.

### Config (real)

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test'

const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL
  ?? 'postgres://mutuals@127.0.0.1:55432/mutuals_e2e'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,                       // one database, one server, four tests — parallelism buys nothing
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  retryStrategy: 'isolated',        // 1.62: retries run alone at the end, so flakes cannot pass by luck
  failOnFlakyTests: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    timezoneId: 'Europe/Berlin',    // must match the profile timezone the API uses for relative dates
    locale: 'en-GB',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      name: 'api',
      command: 'pnpm --filter @mutuals/api start',
      url: 'http://127.0.0.1:3333/health',
      env: {
        DATABASE_URL: E2E_DATABASE_URL,
        MUTUALS_LLM_PROVIDER: 'fake',
        MUTUALS_FIXED_NOW: '2026-03-12T09:00:00Z',
        NODE_ENV: 'test',
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
    },
    {
      name: 'web',
      command: 'pnpm --filter @mutuals/web preview --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
```

```ts
// e2e/fixtures.ts
import { test as base, expect } from '@playwright/test'
import { Client } from 'pg'
import { resetDatabase, seedE2E, type E2EData } from '@mutuals/test-support/database'

export const test = base.extend<{ seed: E2EData }>({
  seed: [async ({}, use) => {
    const db = new Client({ connectionString: process.env.E2E_DATABASE_URL! })
    await db.connect()
    await resetDatabase(db)
    const data = await seedE2E(db)     // faker seed 42, fixed clock — byte-identical every run
    await use(data)
    await db.end()
  }, { auto: true }],
})
export { expect }
```

```ts
// e2e/attribute-to-filter.spec.ts   (flow 1)
import { test, expect } from './fixtures'

test('a new attribute becomes a column and a filter', async ({ page }) => {
  await page.goto('/settings/objects/contacts/attributes')
  await page.getByRole('button', { name: 'Add new' }).click()
  await page.getByLabel('Title').fill('Check size')
  await expect(page.getByLabel('Slug')).toHaveValue('check_size')   // slug auto-suggestion
  await page.getByLabel('Type').selectOption('number')
  await page.getByRole('button', { name: 'Save' }).click()

  await page.goto('/contacts')
  await page.getByRole('button', { name: /^Columns/ }).click()
  await page.getByRole('checkbox', { name: 'Check size' }).check()
  await expect(page.getByRole('columnheader', { name: 'Check size' })).toBeVisible()

  await page.getByRole('button', { name: 'Add filter' }).click()
  await page.getByRole('option', { name: 'Check size' }).click()
  await page.getByRole('combobox', { name: 'Operator' }).selectOption('gt')
  await page.getByLabel('Value').fill('500000')
  await page.getByRole('button', { name: 'Apply' }).click()

  await expect(page).toHaveURL(/filter=/)                            // filters live in the URL
  await expect(page.getByTestId('row-count')).toHaveText(/Rows: \d+/)
})
```

### Flake policy
`retries: 2` **plus** `failOnFlakyTests: true` looks contradictory and is not: the retries exist to
produce a trace of the failure, and `failOnFlakyTests` makes sure a pass-on-retry still fails the build.
Playwright 1.62's `retryStrategy: 'isolated'` runs those retries alone at the end, which removes the
"passed because the machine was quieter" class of false green. With four deterministic flows against a
fixed clock, a fixed seed and no network, a flake is a real bug. The escape valve is
`test.fixme()` with a linked issue, reviewed at every stage gate — never a silent `retries` bump.

### Consequences
- Chromium only. Cross-browser matters for a public marketing site, not for a single-user internal tool
  whose two users run Chrome and Safari; adding WebKit later is one line in `projects`.
- Traces and videos are uploaded on failure and retained 7 days. They contain the seeded fake network,
  never real contacts — worth stating because the product is a personal address book (Open Question 1).
- `pnpm test:e2e` locally reuses an already-running dev server; in CI it always starts a fresh one.

---

## 12. ADR-T11 — Coverage is measured everywhere and gated only on the modules the brief names

### Context
"Unit tests with high coverage on domain logic (attribute validation, slug generation, filter→query
compilation, duplicate matching, recurrence computation, import mapping/preset logic)." Warmth (§4.7)
joins that list. The brief does not ask for a global coverage number, and a global number is the metric
most likely to produce assertion-free tests written to move a percentage.

### Options
1. **A single global threshold** (the classic 80 %).
2. **No thresholds; report only.**
3. **One glob-scoped threshold group covering exactly the named domain modules, per file, plus reporting
   everywhere else.**
4. **100 % on `packages/core`.**

### Choice
Option 3, enforced.

### Reasoning
- A global gate averages a well-tested pure function together with a Fastify plugin and a React
  component, so the number stops meaning anything and starts being gamed.
- Option 2 lets the domain rot quietly, which is exactly what the brief's "these are the parts that break
  silently" warns against.
- Option 4 buys the last 5 % at the price of testing defensive `throw` branches that exist to be
  unreachable. `functions: 100` captures the real intent — *every exported function has at least one
  test* — without the busywork.
- `perFile: true` matters: without it, one 400-line well-covered file hides a 40-line untested sibling.

```ts
// vitest.config.ts (coverage section)
coverage: {
  provider: 'v8',                                 // AST-aware by default in Vitest 4
  reporter: ['text-summary', 'html', 'json-summary', 'lcov'],
  reportsDirectory: './coverage',
  // Vitest 4 reports only imported files unless `include` is set — an untested file
  // would otherwise be invisible rather than red.
  include: [
    'packages/core/src/**/*.ts',
    'packages/db/src/**/*.ts',
    'apps/api/src/**/*.ts',
  ],
  exclude: ['**/*.test.ts', '**/*.itest.ts', '**/index.ts', '**/*.d.ts', 'packages/test-support/**'],
  thresholds: {
    perFile: true,
    autoUpdate: false,                            // the ratchet is a deliberate PR, never automatic
    // The only enforced gate: exactly the modules §8.1 names, plus warmth (§4.7).
    'packages/core/src/{attributes,slug,filters,dedupe,recurrence,import,warmth}/**/*.ts': {
      statements: 95, lines: 95, branches: 90, functions: 100,
    },
  },
},
```

There are deliberately **no global `lines`/`branches` keys**: everything outside that glob is reported,
uploaded as an artifact, and looked at, but does not fail a build.

**The ratchet.** The numbers only go up, and only in a PR that says why. `autoUpdate: false` makes that a
human decision. Lowering one requires a line in `docs/DECISIONS.md`.

**What coverage does not measure, and what replaces it.** Integration and e2e coverage is tracked by the
per-resource template in ADR-T4 (five named blocks per resource, visible in review) and by the
completeness assertions in ADR-T6 — structural guarantees, not percentages.

### Consequences
- The gate is small, meaningful and hard to game.
- If Vitest's `perFile` turns out not to apply to glob groups (§1.2), a ten-line script over
  `coverage/coverage-summary.json` enforces the per-file floor instead, and the config comment says so.

---

## 13. ADR-T12 — Determinism: fixed clock, fixed seed, fixed timezone, a fake LLM, zero network

### Context
Three things in this product are non-deterministic by nature and all three feed the tests the brief cares
most about: the clock (`warmth` decays, follow-ups are overdue, "last 30 days" filters resolve), random
data (faker), and the LLM (§4.8 extraction, ask, summaries).

### Options
1. **`vi.useFakeTimers()` per test.**
2. **Inject a `now()` clock into the app and the database session.**
3. **Record and replay real OpenRouter responses** (`nock@14`, MSW, or Polly).
4. **A hand-written fake LLM provider behind the existing `llm/` interface.**
5. **Call the real model in CI.**

### Choice
Option 2 for time, option 4 for the LLM, with recorded fixtures as the *inputs* to the fake.

### Reasoning
- **Time.** `vi.useFakeTimers()` cannot fake `now()` inside Postgres, and half the time-dependent logic
  lives there (`contact_metrics`, `follow_up.due_at`, the `is overdue` filter). So the clock is a
  constructor parameter: `buildApp({ now })` in TypeScript, and `SET LOCAL mutuals.now = $1` read by a
  `mutuals_now()` SQL function that the schema uses instead of bare `now()` wherever a *business*
  timestamp is produced (`observed_at`, `completed_at`, metrics recomputation). Audit columns
  (`created_at`) keep real `now()`. `MUTUALS_FIXED_NOW=2026-03-12T09:00:00Z` in tests and e2e.
  *This is a schema-touching consequence of the testing decision and must land in Stage 1.*
- **Timezone.** `TZ=UTC` for unit and integration; `Europe/Berlin` for e2e, because relative-date
  shortcuts ("last 30 days") resolve against the profile timezone (`storage-DECISION.md` §5.3) and a UTC
  e2e run would never exercise the off-by-one-day case. Both are set explicitly; neither is inherited.
- **Faker** is seeded once per file in `test/setup.unit.ts` and `setup.integration.ts`
  (`faker.seed(42)`), so a failure reproduces.
- **The LLM.** §3.2 of the brief already requires "one internal `llm/` module with typed inputs and
  outputs, prompt versioning, cost logging and a replayable trace". The fake is therefore not test
  scaffolding — it is a second implementation of an interface the product needs anyway:

```ts
// packages/test-support/src/fake-llm.ts
export function fakeLlm(overrides: Partial<Record<LlmTask, unknown>> = {}): LlmProvider {
  const calls: LlmCall[] = []
  return {
    calls,
    async complete(task, input, schema) {
      calls.push({ task, input })
      const canned = overrides[task] ?? fixtureFor(task, input)   // fixtures/llm/*.json
      // The fixture is validated against the SAME Zod schema the real provider's output is validated
      // against, so a fixture cannot drift away from the contract it is standing in for.
      return schema.parse(canned)
    },
    async embed() { throw new Error('embed() is out of scope in Phase 1') },
  }
}
```

  Fixtures under `fixtures/llm/` are **recorded once from the real OpenRouter** by
  `pnpm llm:record` (a developer command, never CI) and committed. Validating them through the
  production Zod schema is what stops the classic "our mock has drifted from reality" rot.
- **Option 5 is rejected for the PR path**: it is slow, costs money per push, needs a secret in a public
  repo's workflow, and makes the suite fail when a provider has a bad afternoon. Whether a *nightly*
  real-model contract check is worth funding is Open Question 3.

### Enforcement, not convention

```ts
// test/setup.unit.ts
import { faker } from '@faker-js/faker'
faker.seed(42)
process.env.TZ = 'UTC'

// Domain logic is pure. If a unit test reaches for a database or a socket, that is the bug.
vi.mock('pg', () => { throw new Error('packages/core must not import pg — move this to an .itest.ts') })

const realFetch = globalThis.fetch
globalThis.fetch = (...args) => {
  throw new Error(`Network access from a test: ${String(args[0])}. Use the fake provider.`)
}
```

The same `fetch` guard is installed in `setup.integration.ts` with an allowlist of `127.0.0.1`. A test
that silently talks to the internet is a test that will fail on someone else's laptop.

### Consequences
- The whole suite runs on a plane.
- `mutuals_now()` is a small, real change to the schema and to `docs/DECISIONS.md`.
- The LLM stages (6) get meaningful tests: "given this recorded extraction, the *deterministic code*
  matches Anna Berger to the existing contact and proposes a new organization" — which is precisely the
  boundary §3.2 draws ("the LLM extracts; code decides") and precisely what the fake makes testable.

---

## 14. ADR-T13 — Green CI is one command: `pnpm verify`

### Context
"CI must be green before you report a stage as done." That sentence needs a definition that a
non-technical owner can run and that the workflow runs verbatim, or the two drift.

### Options
1. **A list of scripts in the README** that CI happens to run.
2. **A single aggregate script**, run identically locally and in CI.
3. **`turbo run` with a task graph and remote caching.**

### Choice
Option 2, named `verify`.

### Reasoning
- One command means the answer to "is it green?" is not a matter of opinion.
- **Not named `ci`.** `pnpm <name>` shorthand resolves built-in commands before scripts, and shipping a
  script whose name might collide with a future pnpm subcommand is a trap for the person least able to
  debug it. `pnpm verify` has no such risk.
- **Turbo is rejected for now.** At four packages, `tsc --build` project references already give
  incremental builds, and turbo adds a second dependency graph to keep in sync with pnpm's. Revisit if a
  full `verify` passes ~10 minutes locally; it is a two-hour change when that day comes.

```jsonc
// package.json (root)
{
  "packageManager": "pnpm@11.25.0",
  "scripts": {
    "db:up":               "bash scripts/db-up.sh",
    "db:check":            "tsx scripts/check-db.ts",
    "db:migrate":          "drizzle-kit migrate",
    "db:reproject":        "tsx scripts/reproject.ts",
    "db:reproject:verify": "tsx scripts/reproject.ts --verify",
    "seed":                "tsx scripts/seed.ts",

    "format:check": "prettier --check .",
    "lint":         "eslint . --max-warnings=0",
    "typecheck":    "tsc --build --pretty false",
    "verify:static": "pnpm format:check && pnpm lint && pnpm typecheck",

    "test:unit":        "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:e2e":         "playwright test",
    "test:perf":        "vitest run --project perf",
    "test:watch":       "vitest --project unit",

    "verify": "pnpm verify:static && pnpm test:unit --coverage && pnpm test:integration && pnpm db:reproject:verify && pnpm test:e2e"
  }
}
```

**"Green CI" means, in order, and all of them:**

| # | Gate | Command | Fails when |
|---|---|---|---|
| 1 | Formatting | `prettier --check .` | any file is unformatted |
| 2 | Lint | `eslint . --max-warnings=0` | any error **or warning** |
| 3 | Types | `tsc --build` | any type error in any package |
| 4 | Unit | `vitest run --project unit --coverage` | a failure, or a coverage threshold in ADR-T11 |
| 5 | Integration | `vitest run --project integration` | a failure; `retry: 0`, so a flake is a failure |
| 6 | Projection equivalence | `db:reproject:verify` | the derived tables are not reproducible from `fact` |
| 7 | OpenAPI contract | (inside 5) | the generated document differs from the committed snapshot |
| 8 | E2E | `playwright test` | a failure, **or a flaky pass** (`failOnFlakyTests`) |

Not gates, deliberately: the nightly perf suite (ADR-T8), bundle size, and Lighthouse. Each would add
noise proportional to the runner rather than to the change.

`pnpm verify` requires a reachable database, so the README's first line is
`pnpm install && pnpm db:up && pnpm db:migrate && pnpm verify`.

### Consequences
- The workflow is a thin wrapper: one `pnpm verify:static`, one `pnpm test:unit`, and so on, so a green
  local run and a green CI run mean the same thing.
- Warnings are errors. This is deliberate: a lint warning nobody has to fix is a lint rule nobody reads.

---

## 15. ADR-T14 — The toolchain uses TypeScript 6.0.2 via the `@typescript/typescript6` alias, not 7.0.2

### Context
The registry says `typescript@7.0.2` is current. TypeScript 7 is the Go rewrite. Because `typecheck` is
gate 3 of green CI and `lint` is gate 2, the compiler choice is part of this decision set.

### The blocking fact
`typescript@7.0.2`'s tarball contains `bin/tsc` (a launcher for a Go binary), `dist/api/{sync,async}`
(a JSON-RPC API over a vendored `vscode-jsonrpc`) and `lib/version.cjs`. **There is no
`lib/typescript.js`** — the synchronous programmatic API that every type-aware tool loads is simply not
there. `typescript-eslint@8.69.0` declares `"typescript": ">=4.8.4 <6.1.0"`, so it does not merely
degrade on TS 7; it refuses to install. Microsoft's own guidance is that a stable programmatic API
arrives "at least several months from now with TypeScript 7.1", and their recommended interim setup is
an npm alias.

### Options
1. **`typescript@7.0.2` + ESLint with type-aware rules disabled.**
2. **`"typescript": "npm:@typescript/typescript6@6.0.2"` — one compiler, TS 6, everything works.**
3. **Both, aliased**: TS 6 under the `typescript` name for tooling, TS 7 under `typescript-7` for a fast
   `tsc`.
4. **Stay on `typescript@5.9.3`.**

### Choice
Option 2.

### Reasoning
- Option 1 loses `no-floating-promises` and `no-misused-promises` — in a codebase that is Fastify handlers,
  pg transactions and pg-boss jobs, those two rules catch a whole class of real bug. Trading them for a
  compiler that saves four seconds on a four-package repo is a bad trade.
- Option 3 works but installs two packages that both provide a `tsc` binary, so every invocation has to
  use an explicit path and the `packageManager`-managed bin links become a thing to explain. That is
  "clever", and the brief asks for boring.
- Option 4 leaves the project two majors behind and outside the deprecation alignment that TS 6 exists to
  provide.
- Option 2 gives type-aware lint, a stable programmatic API for Vitest's `--typecheck` and any future
  codegen, and a documented, vendor-blessed single-line upgrade path: when 7.1 ships a stable API and
  `typescript-eslint` widens its peer range, the alias is deleted.

```jsonc
{
  "devDependencies": {
    "typescript": "npm:@typescript/typescript6@6.0.2",
    "eslint": "10.9.1",
    "typescript-eslint": "8.69.0",
    "prettier": "3.9.6"
  }
}
```

**Compiler options this forces now, so the TS 7 move is a no-op later** (TS 7 drops these): no `baseUrl`
— use `paths` relative to the tsconfig; `moduleResolution: "nodenext"` for the packages and the API,
`"bundler"` for `apps/web`; no `target: es5`, no `downlevelIteration`, no `module: amd/umd/system`.
Writing the config that way today means the upgrade is a version bump.

**Upgrade trigger, written down:** when `typescript-eslint`'s peer range admits `^7`, run `pnpm verify`
with the alias removed; if green, remove it.

### Consequences
- One TypeScript version in the lockfile.
- `pnpm typecheck` is `tsc --build` on the JS compiler — a few seconds on this repo, not the 10× win TS 7
  advertises. Accepted, and reversible in one line.
- `eslint.config.ts` can use `tseslint.configs.recommendedTypeChecked` for `packages/core` and
  `apps/api`, and the cheaper non-type-checked preset for config files.

---

## 16. Repository layout

```
mutuals/
├─ apps/
│  ├─ api/
│  │  ├─ src/**/*.ts               # unit tests live beside the code:  foo.ts + foo.test.ts
│  │  └─ test/*.itest.ts           # integration: one file per resource, five named blocks each
│  └─ web/
├─ packages/
│  ├─ core/src/{attributes,slug,filters,dedupe,recurrence,import,warmth,text}/…  # the gated modules
│  ├─ db/
│  │  ├─ drizzle/                  # versioned migrations, incl. `generate --custom` SQL files
│  │  ├─ seed/baseline.sql         # workspace + profile + seeded attribute definitions (reset re-runs this)
│  │  └─ test/*.itest.ts           # projector, normalisation contract, concurrency, idempotency
│  └─ test-support/                # database lifecycle, factories, scenarios, fake LLM, explain helpers
├─ e2e/                            # four Playwright specs + fixtures.ts
├─ perf/                           # *.ptest.ts + the 10k generator (nightly only)
├─ fixtures/
│  ├─ linkedin_connections_sample.csv
│  ├─ google_contacts_sample.csv
│  ├─ apple_contacts_sample.vcf
│  └─ llm/*.json                   # recorded OpenRouter responses, validated by production Zod schemas
├─ scripts/{db-up.sh,check-db.ts,reproject.ts,seed.ts,perf-summary.mjs}
├─ vitest.config.ts
├─ playwright.config.ts
└─ .github/workflows/{ci.yml,nightly.yml}
```

Naming: `*.test.ts` = no database, `*.itest.ts` = database, `*.spec.ts` = Playwright, `*.ptest.ts` =
performance. The suffix *is* the routing rule in `vitest.config.ts`, so a test cannot land in the wrong
project by accident.

---

## 17. Expected cost (extrapolated, to be replaced with measurements in Stage 1)

| | Estimate | Basis |
|---|---|---|
| `TRUNCATE` + baseline reset | 15–25 ms | ~20 small tables + ~60 baseline rows |
| One integration test (reset + 3 factory calls + 1 request) | 30–60 ms | above + `inject` round trips |
| `pnpm test:unit` (~350 tests) | 3–6 s | pure functions, no I/O |
| `pnpm test:integration` (~250 tests, 4 workers) | 25–45 s | plus ~4 s of template build |
| `pnpm test:e2e` (4 flows, 1 worker) | 45–90 s | plus server start-up |
| `pnpm verify` locally | 2–4 min | |
| CI `verify` job | 5–7 min | install ~40 s, the rest as above |
| CI `e2e` job | 6–9 min | browser cache hit assumed |
| Nightly perf | 15–25 min | 10k × 60 generation dominates |

---

## 18. Stage-1 definition of done for this decision

1. `pnpm db:up` provisions PostgreSQL 16 + pgvector 0.8.6 on a clean macOS machine with no Docker, in
   under three minutes, and the actual timing is recorded in `docs/ARCHITECTURE.md`.
2. `pnpm db:check` fails with the platform-specific remediation text when an extension is missing.
3. `pnpm verify` is green locally and in GitHub Actions, and the workflow runs the same scripts.
4. The template/clone/reset harness is proven: a test that writes rows is followed by a test that asserts
   the table is empty, and both pass with `MUTUALS_TEST_WORKERS` at 1 and at 4.
5. `VITEST_POOL_ID` is confirmed present in `setupFiles`; the named error fires when it is not.
6. The normalisation contract test passes on all 17 fixtures, and the encoding/locale assertion passes
   locally and in CI.
7. The filter compiler's completeness assertion passes with ≥ 45 golden cases and the matching
   database-backed matrix.
8. The projection-equivalence digest is stable across a full reproject — **after** the two projector
   fixes in ADR-T7 (`ORDER BY` in the `string_agg`s, `f.id` tiebreaker in the `row_number()`s) land.
9. The concurrency test from `storage-DECISION.md` §10.6 (two writers, same record and attribute) runs on
   two real connections, which the template/clone design makes possible.
10. The import-idempotency test from `storage-DECISION.md` §10.7 re-imports
    `fixtures/linkedin_connections_sample.csv` and asserts one live fact per single-valued attribute.
11. Coverage thresholds are enforced on the seven named modules, and `perFile` behaviour on glob groups is
    confirmed (or the fallback script is in place).
12. The nightly perf workflow has run at least once and written its EXPLAIN block into
    `docs/ARCHITECTURE.md`.

---

## 19. Findings that must go back into `storage-DECISION.md` / `docs/DECISIONS.md`

1. **`project_record`'s three `string_agg(...)` calls have no `ORDER BY`**, so `search_document.body` —
   and the `tsv` generated from it — is non-deterministic between an incremental projection and a full
   reproject. Fix: `ORDER BY v.attribute_id, v.value_key` (and `l.to_record_id` for the relation
   aggregate). Without this, §4.6's byte-identical assertion cannot pass.
2. **Both `row_number()` windows in `project_record` tie on `observed_at`** during a `COPY` import, so
   `attribute_value.position` and `record_link.position` are arbitrary and can differ between the
   incremental and bulk paths. Fix: append `, f.id` to both `ORDER BY` clauses. Visible to users as tag
   order changing after an edit.
3. **"Byte-identical" is the wrong assertion** for tables with `gen_random_uuid()` primary keys and
   `now()` timestamps, and `identifier` is not a projection at all (it accumulates by design). ADR-T7
   replaces it with a canonical content digest plus two separate identifier invariants.
4. **Business timestamps need `mutuals_now()`**, not bare `now()`, or the follow-up, warmth and
   relative-date logic cannot be tested deterministically (ADR-T12).
5. **The attribute-definition registry must not be an unbounded in-memory cache**, because `TRUNCATE`
   fires no application code (ADR-T3). Either read per request or key it on a token stored in the
   `workspace` row.

---

## 20. Open questions for humans

Only questions the brief has not already answered, and only ones a person genuinely has to decide.

1. **Public or private repo from day one?** It changes CI economics (Actions minutes are unmetered for
   public repos, 2 000 min/month for private), whether branch protection can require both jobs on the free
   plan, and whether Playwright traces — which contain the *seeded fake* network, never real contacts —
   are world-readable artifacts. *Recommendation: public, MIT, from Stage 1.*
2. **May `pnpm db:up` install `postgresql@16` via Homebrew and compile pgvector 0.8.6 against it on
   Simon's Mac** (about two minutes, no sudo, removable with `brew uninstall` and `rm -rf .pgdata`), or
   would you rather install OrbStack/Docker Desktop and use the container path the brief assumed? The
   third option is Postgres.app, which bundles PostgreSQL 16 with pgvector and needs no compiler.
   *Recommendation: the Homebrew path, with Postgres.app documented as the no-compiler fallback.*
3. **Stage 6: fund a nightly contract test against the real OpenRouter?** It needs a funded API key in
   repository secrets and costs a few cents a night, and it is the only thing that catches a provider
   changing its structured-output behaviour. *Recommendation: no on the PR path (recorded fixtures gate
   CI), yes as a manually triggered check before each release tag — decide whether a nightly is worth the
   key.*
4. **Do we promise Windows contributors a working setup in v0.1.0?** pgvector on Windows needs Visual
   Studio build tools, and `scripts/db-up.sh` would need a PowerShell twin. *Recommendation: macOS and
   Linux only for v0.1.0, stated in `CONTRIBUTING.md`, with WSL2 named as the Windows answer.*
