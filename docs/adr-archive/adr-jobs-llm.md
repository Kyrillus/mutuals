# DECISION SET: Background jobs and the LLM module

**Status:** Proposed (Stage 0). Load-bearing for `packages/jobs`, `packages/llm`, `apps/api` boot, and the
Stage 5 / Stage 6 deliverables.
**Depends on:** `storage-DECISION.md` (typed EAV over an append-only fact log; `record` supertype;
`contact_metrics`; `search_document` with `embedding vector(1536)`; pg-boss gets its own schema in the
same database).
**Scope:** (1) whether and when a queue exists, and how the jobs package and scheduler stub are shaped;
(2) the `llm/` module — interface, provider abstraction, structured outputs, prompt versioning, cost
logging, the trace record, and how all of it is tested without spending money.

---

## 0. What I verified today vs. what I am assuming

Everything in this document that touches a library API was checked against the live registry, the live
package docs, or the live OpenRouter API on **2026-09-03**. The distinction matters because several of
these packages are majors ahead of anything in my training data.

### 0.1 Verified — live lookups

| Fact | How verified |
|---|---|
| `pg-boss@12.29.0` is latest; `engines.node >= 22.12.0`; deps `pg ^8.23.0`, `cron-parser ^5.10.0` | `registry.npmjs.org/pg-boss` |
| pg-boss requires **PostgreSQL 13 or higher**, Node 22.12+ | pg-boss `docs/index.md` ("Requirements") |
| pg-boss creates its own schema (default `pgboss`), needs `CREATE` on the database; CLI + static-SQL escape hatches exist | `docs/install.md`, `docs/api/utils.md`, `docs/cli.md` |
| Schema provisioning and migrations run under **`pg_advisory_xact_lock()`** — transaction-scoped | `docs/api/ops.md` |
| `useListenNotify` needs a **session-pinned** connection and does **not** work through PgBouncer/Supavisor in transaction or statement pooling mode; default is `false`; polling always remains the fallback | `docs/api/constructor.md`, `docs/api/workers.md` |
| v12 exposes ORM transaction adapters: `fromDrizzle(tx, sql)`, `fromKnex`, `fromKysely`, `fromPrisma`, `fromPglite` | `docs/api/adapters.md`, `docs/database-backends.md` |
| v12 handler signature is **batched**: `boss.work(name, opts, async ([job]) => …)`; `batchSize` default 1; `pollingIntervalSeconds` default 2 | `docs/api/workers.md` |
| Queue policies: `standard`, `short`, `singleton`, `stately`, `exclusive`, `key_strict_fifo`; `createQueue()` is required before `send()`; `partition: boolean` opt-in per queue | `docs/api/queues.md` |
| `heartbeatSeconds` (>=10) detects a dead worker independently of `expireInSeconds` (default 15 min) | `docs/api/queues.md` |
| Cron: `schedule(name, cron, data, {tz, key})`, `unschedule(name, key?)`, `getSchedules()`; schedules evaluated every 30 s; 5-field format recommended; clock-skew correction every 10 min | `docs/api/scheduling.md` |
| `flow(jobs)` creates dependent jobs atomically; `resolveFlow()` forces a resolution pass for tests | `docs/api/jobs.md` |
| Built-in test spies: `__test__enableSpies: true`, `boss.getSpy(queue).waitForJob(sel, state)`, race-safe | `docs/api/testing.md` |
| PGlite is a **tested** backend (`backend: 'pglite'`, `db: fromPglite(pglite)`), full PostgreSQL in-process, LISTEN/NOTIFY works | `docs/database-backends.md` |
| **OpenRouter has a real embeddings endpoint**: `POST https://openrouter.ai/api/v1/embeddings`, OpenAI-compatible, supports `dimensions`, `encoding_format`, `input_type`, `provider`; returns `id`, `data[].embedding`, and `usage { prompt_tokens, total_tokens, cost, cost_details, prompt_tokens_details }`; streaming not supported | OpenRouter API reference (`/docs/api/api-reference/embeddings/submit-an-embedding-request`) |
| **37 embedding models** live right now, including `openai/text-embedding-3-small` (ctx 8192, $0.02/M prompt tokens, native 1536 dims), `openai/text-embedding-3-large` ($0.13/M), `google/gemini-embedding-2`, `mistralai/mistral-embed-2312`, `baai/bge-m3`, `qwen/qwen3-embedding-8b`, plus free tiers | Unauthenticated `GET https://openrouter.ai/api/v1/models?output_modalities=embeddings` |
| Structured outputs: `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }`; use `provider.require_parameters: true` to only route to endpoints that support it; works with streaming | OpenRouter structured-outputs guide |
| **340 of 424** currently listed models advertise `structured_outputs` in `supported_parameters` | Unauthenticated `GET https://openrouter.ai/api/v1/models` |
| `usage: { include: true }` and `stream_options: { include_usage: true }` are **deprecated no-ops**. Usage is always returned: `usage.cost`, `usage.cost_details.upstream_inference_cost`, `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details.{cached_tokens,cache_write_tokens}`, `completion_tokens_details.reasoning_tokens`, `is_byok` | OpenRouter usage-accounting guide |
| Provider preferences object: `order`, `allow_fallbacks`, `require_parameters`, `data_collection`, `only`, `ignore`, `zdr`, `quantizations`, `sort`, `preferred_min_throughput`, `preferred_max_latency`, `max_price` | OpenRouter provider-selection guide |
| `GET /api/v1/generation?id=…` returns token counts and cost for a past generation | OpenRouter API reference overview |
| Headers: `HTTP-Referer`, `X-OpenRouter-Title` (docs note "`X-Title` also accepted"), `X-OpenRouter-Categories` | OpenRouter API reference overview |
| OpenRouter publishes **floating aliases** prefixed with `~`: `~anthropic/claude-haiku-latest`, `~google/gemini-flash-latest`, `~openai/gpt-mini-latest`, `~deepseek/deepseek-v4-flash-latest`, … | Live `/models` dump |
| Zod 4 `z.toJSONSchema(schema, opts)` — `target` defaults to `draft-2020-12`; `io: 'input' \| 'output'`; **objects emit `additionalProperties: false` by default in output mode**; `unrepresentable: 'throw' \| 'any'`; `cycles`, `reused`, `override` | zod.dev/json-schema |
| Zod 4: both `z.uuid()` and `z.string().uuid()` are valid (the chainable form is *not* deprecated); `z.discriminatedUnion`, `z.enum`, `.nullable()`, `z.infer` unchanged | zod.dev/api |
| Latest versions: `zod@4.5.4`, `vitest@4.1.11`, `msw@2.15.0`, `pg@8.23.0`, `@electric-sql/pglite@0.5.8`, `openai@7.9.0` (node>=22), `ai@7.0.91`, `@openrouter/ai-sdk-provider@3.0.0`, `nock@14.0.17` | registry lookups |

### 0.2 Assumed — NOT verified, and what breaks if I am wrong

1. **pg-boss queue-name character set.** I use dotted names (`import.run`, `metrics.warmth-sweep`). The
   docs never state a constraint beyond schema names. *Mitigation:* Stage 5's first integration test
   calls `createQueue()` for every registered name; a rejected name fails CI immediately, and the fix is
   a rename in one file.
2. **OpenRouter `/embeddings` respects `provider.require_parameters`** for `dimensions`. The request
   schema lists `provider`, but I did not confirm the routing semantics on the embeddings path.
   *Mitigation:* the startup dimension probe (§6.6) catches any mismatch before a backfill.
3. **MSW 2.15 intercepts Node 24's global fetch.** MSW's Node interception is via
   `@mswjs/interceptors`, which is documented as covering native fetch; I did not run it here.
   *Mitigation:* MSW is used for exactly six provider-contract tests. If it does not work, the fallback
   is `undici`'s `MockAgent` + `setGlobalDispatcher`, which is a same-day swap. (`nock@14` claims fetch
   support and third-party write-ups dispute it; that ambiguity alone is a reason not to pick nock.)
4. **The precise strict-mode JSON Schema keyword allowlist.** OpenRouter's docs say only that "strict
   modes may also restrict which JSON Schema features you can use" without enumerating them.
   *Mitigation:* §6.3's `assertStrictCompatible()` enforces a conservative allowlist of my own, so the
   product never depends on a keyword whose support I could not confirm.
5. **Every latency and cost figure in §4.5 and §7.4 is an estimate**, not a measurement. There is no
   Postgres and no OpenRouter key in the environment this was written in.

---

## 1. Executive summary (both parts, one screen)

**Jobs.** Adopt **pg-boss 12.29.0**. It does not arrive in Stage 1 — Stage 1 has no asynchronous work at
all, and installing a queue with nothing to queue is exactly the over-engineering the brief forbids.
Stage 1 ships `packages/jobs` as a *shape*: a three-method `JobQueue` port, an `InlineQueue` adapter
that runs handlers synchronously in-process, a typed job registry, a declarative schedule registry, and
a `pnpm jobs:run <name>` CLI. **pg-boss becomes the adapter in Stage 5, with the import wizard** — the
first job that genuinely cannot be an HTTP request. Nothing above the port changes when it lands.
The worker runs inside `apps/api` by default (§12's one command), behind a flag, with a standalone
entry point that is 15 lines when a separate process is wanted.

**LLM.** One `packages/llm` with **two layers**: an app-facing `LlmClient` whose unit of work is a
*task* (`extraction`, `question`, `summary`, `embedding` — the brief's own four configuration keys), and
beneath it a `ChatProvider` / `EmbeddingProvider` port speaking the **OpenAI-compatible wire format**, so
"swap the base URL" is literally the whole migration to direct OpenAI, Anthropic's compatible endpoint,
Ollama or LM Studio. The transport is ~180 lines of hand-written `fetch` rather than an SDK, because the
trace must capture the exact request and response bytes and because we depend on OpenRouter fields
(`usage.cost`, `provider.require_parameters`) that no OpenAI-typed SDK models. **One Zod schema per
prompt version is the single source** for both the wire JSON Schema (`z.toJSONSchema`) and the runtime
validation — and the runtime validation always runs, `strict: true` or not. The trace lives in one
Postgres table, `llm_call`, in the app's own database; **fixtures for CI are exported from that table**,
so every call ever made in development is a potential test fixture and CI never spends money.

**Embeddings are covered.** OpenRouter shipped a real, OpenAI-shaped `/embeddings` endpoint;
`openai/text-embedding-3-small` is available at $0.02/M tokens with a native 1536 dimensions, which is
exactly the `vector(1536)` column the storage decision already created. The `EmbeddingProvider` is still
separately configurable (its own base URL and key, defaulting to the chat ones) so the brief's escape
hatch — "if OpenRouter does not cover embeddings well enough, use a second provider behind the same
interface" — costs two environment variables and no code.

---

# PART ONE — BACKGROUND JOBS

## 2. ADR-J1 — pg-boss as the queue engine

**Context.** §3.2: *"Imports, LLM summaries and (later) sync and nudges need a queue. Prefer a
Postgres-backed queue (e.g. pg-boss) over extra infrastructure. Justify."* §9 additionally requires *"a
`jobs` package/folder with a scheduler stub"* for future nudges. The storage decision already reserves
pg-boss its own schema in the same database and states that the app's raised planner GUCs must not touch
it.

**Options.**

1. **pg-boss 12.29.0.** Postgres-backed, MIT, one dependency (which itself pulls only `pg`,
   `cron-parser`, `serialize-error`). Built-in cron with clock-skew correction, dead-letter queues,
   exponential backoff, throttle/debounce, job dependency flows, and — new and directly relevant — a
   Drizzle transaction adapter and built-in test spies.
2. **Graphile Worker.** Also Postgres-backed, also excellent, LISTEN/NOTIFY-first so latency is lower by
   default, also has cron. Genuinely competitive.
3. **BullMQ + Redis.** The mainstream Node queue. Best-in-class ergonomics and observability.
4. **Hand-rolled: a `job` table + `SELECT … FOR UPDATE SKIP LOCKED` + `setInterval`.** The most minimal
   thing that could work; maybe 150 lines.

**Choice: pg-boss 12.29.0.**

**Reasoning.**

- **(3) is disqualified by the brief.** "Runs locally with one command", "no cloud dependency required
  to run it", "no proprietary services in the critical path", and this machine has no Docker. Redis is
  a second server to install, run, back up and explain to a non-technical owner. Rejected on the brief's
  own terms, not on merit.
- **(4) is the tempting one and it is wrong.** The 150 lines is the *happy path*. What you actually need
  before the import wizard is safe is: retries with exponential backoff and jitter, a dead-letter
  destination, detection of a worker that died mid-job (not the same thing as a job that ran too long),
  a cron evaluator that does not double-fire when two processes run, clock-skew handling, and
  archiving so the table does not grow forever. pg-boss has all of it, tested, in one MIT dependency.
  This is precisely the "boring, well-documented technology" the brief asks for; re-implementing it is
  the clever option.
- **(2) vs (1) is close and the tie-breakers are concrete.** pg-boss is the package the brief names, so
  choosing it needs no justification to a reviewer who read the brief. Beyond that: `fromDrizzle(tx,
  sql)` lets `send()` join the *application's own* transaction, which matters a great deal given a
  storage design whose write path is already a carefully ordered multi-statement transaction (supersede
  → insert → project). Enqueueing a re-projection or a metrics recompute in that same transaction —
  and having it roll back with everything else — is the difference between "eventually consistent" and
  "consistent". Graphile Worker offers the same capability via `addJob` with a provided client, so this
  is a preference, not a knockout. The knockouts are softer: pg-boss's `__test__enableSpies` removes
  every `sleep()` from the job integration tests, and pg-boss lists **PGlite** as a *tested* backend,
  which is a meaningful hedge on a machine with no Docker and no local Postgres.
- Graphile Worker's LISTEN/NOTIFY-first design is its real advantage, and it is worth ~2 s of latency —
  which for a personal CRM's import job is invisible. See ADR-J4 for why we deliberately do not turn
  pg-boss's LISTEN/NOTIFY on either.

**Compatibility check against the chosen Postgres setup — this is the "verify it works" part.**

| Requirement | Status |
|---|---|
| Node | needs ≥ 22.12.0; environment has **v24.20.0** ✓ |
| Postgres | needs ≥ 13; target is **16** ✓ |
| Extensions | none. pg-boss needs no extension — it uses `SKIP LOCKED`, declarative list partitioning and `pg_advisory_xact_lock`, all core PG16 ✓ |
| Privileges | needs `CREATE` on the database to make the `pgboss` schema. Supabase's `postgres` role has it. If a deployment refuses, `migrate: false` + `createSchema: false` + the CLI's `--dry-run`/`plans` SQL output, checked into `packages/db/sql/pgboss/`, is the documented fallback ✓ |
| Supabase pooler | schema work uses `pg_advisory_xact_lock()`, which is **transaction-scoped**, so it is safe through Supavisor/PgBouncer transaction pooling. The one thing that is not safe is `useListenNotify`, which we leave off (ADR-J4) ✓ |
| Storage-decision interaction | pg-boss lives in schema `pgboss`; app tables live in `public`. No name collision. pg-boss runs on **its own pool** (ADR-J4), so `join_collapse_limit = 16` / `geqo_threshold = 20` never touch its fetch queries — exactly what `storage-DECISION.md §2.10` already asserted ✓ |
| No-Docker local dev | if the chosen local Postgres ends up being PGlite rather than a native install, pg-boss supports it first-class (`backend: 'pglite'`, `db: fromPglite(pglite)`) ✓ |

**Consequences.**

- One runtime dependency, MIT, maintained by one person (stated on their own docs). That is a real
  bus-factor risk for an open-source project. Mitigated by: the `JobQueue` port (ADR-J2) means replacing
  it is one adapter file, and the `pgboss` schema is `DROP SCHEMA pgboss CASCADE` to remove.
- pg-boss runs its own migrations inside `start()`. On upgrade, `start()` can block while it migrates.
  At our data volume (a few thousand jobs, ever) this is milliseconds. Pin the version in
  `package.json` exactly and upgrade deliberately.
- `job` rows are extra write traffic in the same database as the CRM. At a few hundred jobs a day this
  is noise; the default retention (14 days created, 7 days completed) keeps it bounded.

---

## 3. ADR-J2 — Stage 1 does *not* get a queue; the queue arrives with imports in Stage 5

**Context.** The question in front of us is explicitly *"decide whether Stage 1 needs it at all or
whether it arrives with imports"*. Walking the stage list for genuinely asynchronous work:

| Stage | Deliverable | Async? |
|---|---|---|
| 1 | migrations, attribute system, fact log, filter compiler, warmth *function*, API skeleton, seed script | **No.** Every operation is request/response or a CLI script. |
| 2 | contacts table, attribute CRUD | No. |
| 3 | organizations, relations, detail page, interactions | No. `contact_metrics` is recomputed in the same transaction as the interaction write (storage-DECISION §7.2). |
| 4 | follow-ups, recurrence, dashboard, saved views | No. Recurrence creates the next occurrence on completion, synchronously. |
| 5 | **import wizard, 10k rows** | **Yes.** The first thing that cannot be an HTTP request. |
| 6 | LLM ask / quick capture / summaries | Mixed. Ask and quick capture are user-blocking by nature. Summaries *want* a queue. |
| 7 | polish | No. |

**Options.**

1. **pg-boss from Stage 1.** One execution model from the first commit; nothing to retrofit.
2. **`packages/jobs` (port + inline adapter + registries) in Stage 1; pg-boss adapter in Stage 5.**
3. **No jobs package at all until Stage 5.**

**Choice: (2).**

**Reasoning.**

- **(3) violates §9 directly** — "a `jobs` package/folder with a scheduler stub" is named as a Phase-1
  extension point. It also means Stage 5 has to invent the handler contract, the payload typing and the
  schedule registry while it is also building a five-step wizard. That is the worst moment to design an
  abstraction.
- **(1) is over-engineering with a real cost, not just an aesthetic one.** Adding pg-boss in Stage 1
  means every integration test database — and CI runs them per resource — must have `boss.start()` run
  against it before anything works, adding a schema install plus migration check to the fixture path,
  and adding a background process with timers to a test suite that otherwise has none. That is a whole
  extra class of flakiness bought in exchange for zero features. The brief: *"Build what the current
  stage needs."*
- **(2) costs about 120 lines** and makes the Stage-5 change mechanical: swap `InlineQueue` for
  `PgBossQueue` in one composition-root file. Everything above — handlers, payload schemas, the schedule
  list, the CLI — is written once, in Stage 1, and is exercised from Stage 1 by the inline adapter.

**What "the warmth sweep is nightly" means before Stage 5.** §4.7 says warmth is *"recomputed nightly
(and on demand after new interactions)"*. The on-demand half is already synchronous and
in-transaction per the storage decision. The nightly half, between Stage 1 and Stage 5, is:

- `pnpm jobs:run metrics.warmth-sweep` — the CLI, usable by hand and by an OS cron if anyone wants one;
- plus **a staleness catch-up at API boot**: if `max(contact_metrics.computed_at) < now() - interval '20
  hours'`, the API enqueues the sweep once (inline before Stage 5, via pg-boss after). This is not a
  workaround, it is the correct design for a *locally-run* app: **a cron schedule only fires while the
  process is running**, and Simon's laptop is not a server. Any design that relies purely on a 03:00
  cron silently never recomputes warmth for a user who closes their laptop at night. The catch-up is
  ~15 lines and it is the thing that actually makes "recomputed nightly" true.

**Consequences.**

- Between Stage 1 and Stage 5 the `InlineQueue` runs handlers *in the request's own process*, awaited.
  That is fine because the only handlers in that window are the metrics sweep (< 1 s at 10k contacts per
  the storage decision) and the search-document rebuild. A handler that would block a request for
  seconds is a signal that Stage 5 has arrived early — the port makes that swap trivial rather than
  urgent.
- `InlineQueue.schedule()` is a no-op that logs once at boot: *"schedule 'metrics.warmth-sweep' declared
  but the inline queue does not run crons; run `pnpm jobs:run metrics.warmth-sweep` or enable
  pg-boss."* An unimplemented method that silently does nothing is how a scheduler stub becomes a bug.

---

## 4. ADR-J3 — the jobs package: port, registry, handlers, runner

**Context.** Needs to satisfy: typed payloads, a scheduler stub for §9 nudges, testability without a
queue, and a swap point for pg-boss.

**Options.** (a) Expose pg-boss directly everywhere, no port. (b) A thin three-method port with two
adapters. (c) A full abstraction layer that models retries, dead letters and flows generically.

**Choice: (b).** (a) makes Stage-1 unit tests require pg-boss and makes ADR-J2 impossible. (c) is
inventing a queue abstraction to abstract a queue — the classic mistake; queue-specific options
(`policy`, `deadLetter`, `heartbeatSeconds`) are passed through as an opaque, adapter-specific object
declared once per queue in the registry, not re-modelled.

### 4.1 Layout

```
packages/jobs/
  src/
    port.ts                # JobQueue — 3 methods, nothing else
    registry.ts            # queue name -> payload schema + queue options  (the ONE registry)
    schedules.ts           # declarative cron table + syncSchedules()
    adapters/inline.ts     # Stage 1..4
    adapters/pgboss.ts     # Stage 5+
    handlers/
      metrics-warmth-sweep.ts
      search-reindex.ts
      import-run.ts        # Stage 5
      llm-summary.ts       # Stage 6
      llm-trace-prune.ts   # Stage 6
    runner.ts              # startWorkers(queue) — used by apps/api and by the standalone entry
    cli.ts                 # pnpm jobs:run <name> [--payload '{"…"}']
  test/
```

### 4.2 The port

```ts
// packages/jobs/src/port.ts
import type { JobName, JobPayload } from './registry'

export interface EnqueueOptions {
  /** Run no earlier than this. Number = seconds from now. */
  startAfter?: number | Date
  /** Collapse repeat sends within `debounceSeconds` onto one job with this key. */
  key?: string
  debounceSeconds?: number
  /** Join an existing application transaction. Adapter-specific handle; see PgBossQueue. */
  tx?: unknown
}

export interface JobQueue {
  /** Returns a job id, or null when the send was collapsed by debouncing/throttling. */
  enqueue<N extends JobName>(name: N, payload: JobPayload<N>, opts?: EnqueueOptions): Promise<string | null>
  /** Register the worker for a queue. Idempotent per process. */
  work<N extends JobName>(name: N, handler: JobHandler<N>): Promise<void>
  /** Reconcile declared cron schedules with what the backend currently has. */
  syncSchedules(declared: readonly ScheduleDef[]): Promise<void>
}

export type JobHandler<N extends JobName> = (payload: JobPayload<N>, ctx: JobContext) => Promise<void>

export interface JobContext {
  jobId: string
  attempt: number
  logger: Logger
  signal: AbortSignal
  /** Re-entrant enqueue, so a handler can chain work without importing the composition root. */
  queue: JobQueue
}
```

Three methods. Everything policy-shaped lives in the registry, not in call sites.

### 4.3 The registry — one file, typed payloads

```ts
// packages/jobs/src/registry.ts
import { z } from 'zod'

/** Queue-level options. Passed verbatim to pg-boss createQueue(); ignored by InlineQueue. */
type QueueOptions = {
  policy?: 'standard' | 'singleton' | 'stately' | 'exclusive' | 'short'
  retryLimit?: number
  retryDelay?: number
  retryBackoff?: boolean
  expireInSeconds?: number
  heartbeatSeconds?: number
  deadLetter?: string
  deleteAfterSeconds?: number
}

export const JOBS = {
  // ---- Stage 1 ------------------------------------------------------------
  'metrics.warmth-sweep': {
    payload: z.object({ reason: z.enum(['cron', 'startup-catchup', 'manual']) }),
    // Only ever one sweep active, and only one queued behind it: `stately`.
    queue: { policy: 'stately', retryLimit: 2, retryBackoff: true, expireInSeconds: 300 },
  },
  'search.reindex-record': {
    payload: z.object({ recordId: z.uuid() }),
    queue: { policy: 'standard', retryLimit: 3, retryBackoff: true, expireInSeconds: 60 },
  },

  // ---- Stage 5 ------------------------------------------------------------
  'import.failed': {                       // dead letter target; must exist BEFORE 'import.run'
    payload: z.object({ importBatchId: z.uuid() }),
    queue: { policy: 'standard', retryLimit: 0, deleteAfterSeconds: 0 },
  },
  'import.run': {
    payload: z.object({ importBatchId: z.uuid() }),
    queue: {
      policy: 'singleton',        // one import executing at a time; more may queue
      retryLimit: 0,              // see ADR-J6: an import is never silently re-run
      expireInSeconds: 900,
      heartbeatSeconds: 60,       // a killed worker is noticed in ~1 min, not 15
      deadLetter: 'import.failed',
    },
  },

  // ---- Stage 6 ------------------------------------------------------------
  'llm.contact-summary': {
    payload: z.object({ contactId: z.uuid(), force: z.boolean().default(false) }),
    queue: { policy: 'standard', retryLimit: 2, retryDelay: 5, retryBackoff: true, expireInSeconds: 120 },
  },
  'llm.trace-prune': {
    payload: z.object({ olderThanDays: z.number().int().positive().default(30) }),
    queue: { policy: 'stately', retryLimit: 1, expireInSeconds: 300 },
  },
} as const satisfies Record<string, { payload: z.ZodType; queue: QueueOptions }>

export type JobName = keyof typeof JOBS
export type JobPayload<N extends JobName> = z.infer<(typeof JOBS)[N]['payload']>
```

Two rules that go in `CLAUDE.md`:

1. **Payloads carry ids, never data.** `{ importBatchId }`, not the parsed CSV. A payload is `jsonb` in
   a table in the same database the data already lives in; copying it is pure write amplification, and
   a stale copy is a correctness bug. Enforced by a soft cap: `enqueue()` throws if the serialised
   payload exceeds 8 KB.
2. **Every handler re-validates its payload on receipt.** The payload crossed a process boundary and may
   have been written by an older build. `JOBS[name].payload.parse(job.data)` is the first line of every
   handler, done once in `runner.ts` so handlers receive an already-typed value.

### 4.4 The pg-boss adapter

```ts
// packages/jobs/src/adapters/pgboss.ts
import { PgBoss, fromDrizzle } from 'pg-boss'      // v12 exports PgBoss as a named export
import { sql } from 'drizzle-orm'
import { JOBS, type JobName, type JobPayload } from '../registry'
import type { JobQueue, EnqueueOptions, ScheduleDef } from '../port'

export async function createPgBossQueue(cfg: {
  connectionString: string
  schema?: string
  supervise?: boolean
  schedule?: boolean
}): Promise<{ queue: JobQueue; boss: PgBoss; stop: () => Promise<void> }> {
  const boss = new PgBoss({
    connectionString: cfg.connectionString,
    schema: cfg.schema ?? 'pgboss',
    application_name: 'mutuals-jobs',
    // Own pool, deliberately tiny: one user, at most a couple of concurrent handlers.
    // Also keeps the app's raised planner GUCs (storage-DECISION §2.10) off pg-boss's fetch queries.
    max: 2,
    // OFF on purpose. See ADR-J4.
    useListenNotify: false,
    supervise: cfg.supervise ?? true,
    schedule: cfg.schedule ?? true,
  })

  // pg-boss surfaces background failures here; without a listener they are unhandled.
  boss.on('error', (err) => logger.error({ err }, 'pg-boss'))
  boss.on('warning', (w) => logger.warn({ w }, 'pg-boss'))

  await boss.start()

  // Queues must exist before send(). Dead-letter targets must exist before their source.
  for (const name of orderedQueueNames()) {
    await boss.createQueue(name, JOBS[name].queue as never)
  }

  const queue: JobQueue = {
    async enqueue(name, payload, opts) {
      JOBS[name].payload.parse(payload)              // fail at the call site, not in the worker
      const db = opts?.tx ? fromDrizzle(opts.tx as never, sql) : undefined
      const sendOpts = { startAfter: opts?.startAfter, db }
      return opts?.debounceSeconds
        ? boss.sendDebounced(name, payload, sendOpts, opts.debounceSeconds, opts.key)
        : boss.send(name, payload, { ...sendOpts, singletonKey: opts?.key })
    },

    async work(name, handler) {
      await boss.work(name, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
        const payload = JOBS[name].payload.parse(job.data) as JobPayload<typeof name>
        await handler(payload, { jobId: job.id, attempt: job.retryCount ?? 0, logger, signal, queue })
      })
    },

    syncSchedules,
  }

  return { queue, boss, stop: () => boss.stop({ graceful: true, timeout: 30_000 }) }
}
```

Note `boss.work(name, opts, async ([job]) => …)` — **the handler receives an array**. This is the v10+
signature and it is the single most common thing to get wrong from memory.

### 4.5 Transactional enqueue — why the Drizzle adapter earns its place

The storage decision's write path is already a transaction: `SELECT … FOR UPDATE` the record row,
`UPDATE` to supersede, `INSERT` the new fact, call `project_record()`. When the search document needs a
rebuild or metrics need recomputing out of band, the enqueue must be part of that transaction:

```ts
await db.transaction(async (tx) => {
  const factId = randomUUID()
  await supersedeLiveFact(tx, { recordId, attributeId, valueKey })
  await insertFact(tx, { id: factId, ... })
  await projectRecordAttribute(tx, { recordId, attributeId })
  // If anything above throws, this job never existed.
  await queue.enqueue('search.reindex-record', { recordId }, { tx })
})
```

Without this, the failure mode is a job that fires against a row the transaction rolled back — which for
a re-projection job means silently reverting a value to a superseded state. This is not a theoretical
concern in a design where a derived table is rebuilt from a log.

---

## 5. ADR-J4 — connection and delivery policy: own pool, polling only, no LISTEN/NOTIFY

**Context.** pg-boss can share the app's database handle (`db:` option), or run its own pool. It can
optionally use LISTEN/NOTIFY to cut dispatch latency from `pollingIntervalSeconds` (default 2 s) to
milliseconds. The deployed instance is Supabase; local is a plain Postgres 16.

**Options.**

1. Own pool (`max: 2`), polling only, `useListenNotify: false`.
2. Own pool with `useListenNotify: true` and `notify: true` on hot queues.
3. Share the API's Drizzle pool via the `db:` option.

**Choice: (1).**

**Reasoning.**

- **(3) is ruled out by the storage decision.** `storage-DECISION.md §2.10` raises
  `join_collapse_limit`, `from_collapse_limit` and `geqo_threshold` on *every pooled connection* to make
  the filter compiler's 12-chip queries plan exhaustively, and explicitly states pg-boss is "untouched
  by these settings". A shared pool would apply those GUCs to pg-boss's own fetch queries. They would
  probably be harmless — but "probably harmless" is not a reason to couple two subsystems whose query
  shapes have nothing in common. Sharing also means a stuck job handler can starve the API of
  connections. Two small pools are strictly more predictable than one shared one.
  *(The `fromDrizzle` adapter is the deliberate exception: transactional `send()` runs a single INSERT
  on the app's connection, which no planner setting affects.)*
- **(2) is a latency optimisation we cannot spend.** Verified: `useListenNotify` requires a
  **session-pinned** connection and **does not work through PgBouncer/Supavisor in transaction or
  statement pooling mode**. Supabase's default connection string for applications is the transaction
  pooler. Turning it on therefore means either (a) pinning the deployment to the direct/session port —
  a real operational constraint on a hosted database with a tight direct-connection budget — or (b)
  accepting a `listen_notify_unavailable` warning at every boot on the deployed instance while it
  silently works locally, which is the worst kind of environment divergence. The thing being bought is
  ~2 seconds of dispatch latency on a queue whose jobs are a nightly sweep, a 10-second import, and a
  summary generation the user already expects to wait for. Not worth it.
- The `max: 2` figure: one worker connection plus one for supervision/scheduling. A single-user CRM
  never needs more, and it leaves the Supabase direct-connection budget for the API.

**Consequences.**

- Jobs start up to 2 seconds after being enqueued. The import wizard's progress UI must therefore not
  assume instant start; it polls `import_batch` and shows "queued" as a first state. This is a UI
  requirement created by this ADR and it belongs in Stage 5's definition of done.
- If latency ever matters (it does not in Phase 1), the change is `useListenNotify: true` plus
  `notify: true` on the queue plus a documented "use the session-mode connection string" note. One
  config change, no code.
- pg-boss's default retention (14 days for created/retry, 7 for completed) is left alone. At our volume
  the `pgboss.job` table stays under a few thousand rows.

---

## 6. ADR-J5 — the scheduler stub: a declarative table synced on boot, plus a startup catch-up

**Context.** §9 requires "a `jobs` package/folder with a scheduler stub" for future stay-in-touch and
synergy nudges. §4.7 requires nightly warmth.

**Options.**

1. Call `boss.schedule(...)` inline at boot for each cron job.
2. A declarative `schedules.ts` array plus a `syncSchedules()` that reconciles declared vs. stored.
3. OS-level scheduling (`launchd`/`cron`) invoking `pnpm jobs:run`.

**Choice: (2).**

**Reasoning.**

- **(1) has a specific, nasty failure mode.** pg-boss stores schedules *in the database*. If a cron
  entry is renamed or deleted in code, the old schedule stays in `pgboss.schedule` and keeps firing
  forever, into a queue that may no longer have a worker. Nobody notices until the job table fills with
  `created` jobs. `syncSchedules()` diffs declared against `getSchedules()` and unschedules the
  orphans. This is ~20 lines and it is the difference between a stub and a trap.
- **(3)** is out because it is per-machine setup a non-technical owner must perform, and it does not
  exist on the deployed instance at all. It stays available as a documented escape hatch precisely
  because the CLI exists (`pnpm jobs:run metrics.warmth-sweep`).

```ts
// packages/jobs/src/schedules.ts
export type ScheduleDef = {
  queue: JobName
  cron: string          // 5-field. The 6-field form is discouraged: pg-boss checks every 30s,
                        // so second-level precision means the slot is usually missed.
  tz: string            // profile.timezone; UTC if unset
  data: unknown
  key?: string
}

export const SCHEDULES: readonly ScheduleDef[] = [
  {
    queue: 'metrics.warmth-sweep',
    cron: '30 3 * * *',
    tz: process.env.MUTUALS_TZ ?? 'Europe/Berlin',
    data: { reason: 'cron' },
  },
  // Stage 6:
  // { queue: 'llm.trace-prune', cron: '15 4 * * *', tz, data: { olderThanDays: 30 } },
  //
  // ---- §9 extension point, deliberately not built -------------------------------
  // The nudge scheduler is ONE entry here plus one handler. The decision logic
  // (ask <-> offer matching; stay-in-touch candidate selection from contact_metrics.warmth
  // and last_interaction_at) is a PURE FUNCTION in packages/core, unit-tested with no queue,
  // and the handler only writes follow_up rows with origin = 'system'.
  // { queue: 'nudges.scan', cron: '0 7 * * *', tz, data: {} },
]

export async function syncSchedules(boss: PgBoss, declared: readonly ScheduleDef[]) {
  const existing = await boss.getSchedules()
  const declaredKeys = new Set(declared.map((s) => `${s.queue}::${s.key ?? ''}`))

  for (const s of declared) {
    await boss.schedule(s.queue, s.cron, s.data, { tz: s.tz, key: s.key })
  }
  for (const e of existing) {
    if (!declaredKeys.has(`${e.name}::${e.key ?? ''}`)) {
      await boss.unschedule(e.name, e.key)   // an entry deleted from code stops firing
      logger.warn({ queue: e.name, key: e.key }, 'removed orphaned schedule')
    }
  }
}
```

**And the catch-up, which is the part that makes "nightly" true on a laptop:**

```ts
// apps/api/src/boot/metrics-freshness.ts
export async function ensureMetricsFresh(db: Db, queue: JobQueue) {
  const [{ stalest }] = await db.execute(sql`
    SELECT min(computed_at) AS stalest FROM contact_metrics
  `)
  if (!stalest || stalest < new Date(Date.now() - 20 * 3600_000)) {
    // debounced: many restarts in a row produce one sweep
    await queue.enqueue('metrics.warmth-sweep', { reason: 'startup-catchup' },
      { key: 'warmth-sweep', debounceSeconds: 3600 })
  }
}
```

`sendDebounced` is the verified pg-boss primitive here: it collapses repeat sends within the window and
schedules the collapsed job into the *next* slot rather than dropping it.

**Consequences.** Warmth is at worst ~24 h stale in continuous operation, and at worst one boot stale
otherwise. Storage-DECISION §7.2 already prices this: 24 h of exponential decay on a 90-day time
constant is ~1 % of a 0–100 score. Invisible.

---

## 7. ADR-J6 — the import job: one job per batch, chunked commits, no automatic retry

**Context.** §6.8: up to 10k rows, presets, duplicate resolution decided by the *user* in step 4, a
progress bar, and a result screen with created/merged/skipped counts. Storage-DECISION prices a 10k-row
import at 8–20 s using the set-based projection path with `SET LOCAL mutuals.defer_projection = 'on'`.

**Options.**

1. One `import.run` job per batch. It streams the already-validated, already-resolved rows from the
   `import_batch` staging rows, commits in chunks of 500, and updates counters.
2. One job per row (or per 100 rows), assembled with `boss.flow()` and a finalise job.
3. Synchronous in the HTTP request.

**Choice: (1).**

**Reasoning.**

- **(3)** cannot work: 8–20 s exceeds sane proxy and browser timeouts, and gives no progress.
- **(2)** buys parallelism we do not want and cannot use. 10k jobs for one import is 10k rows of queue
  write amplification for a workload the storage decision says is *index-maintenance bound*, not
  CPU-bound — parallel workers would contend on the same indexes and be slower. It also makes "created:
  1,204 / merged: 31 / skipped: 23" an aggregation problem instead of a counter. `flow()` is the right
  tool and stays in the toolbox; the trigger to reach for it is per-row LLM enrichment (a §9 crawler),
  where each unit is network-bound and independent.
- **`retryLimit: 0` is the deliberate part.** An import is a bulk write with user-chosen duplicate
  resolutions. A silent automatic retry after a partial failure is how you get half-imported batches and
  duplicate contacts — the exact thing §6.8 says must not happen ("re-importing the same LinkedIn export
  creates no duplicates"). Instead: chunked commits mean everything before the failure is durably
  committed and counted; the batch row records `last_committed_row`; the job dead-letters to
  `import.failed`; and the UI offers an explicit **Resume from row N** which enqueues a fresh
  `import.run`. Human-visible and idempotent, rather than automatic and ambiguous.
- **`heartbeatSeconds: 60` with `expireInSeconds: 900`.** Verified as independent mechanisms: expiry
  bounds how long a job may legitimately run; the heartbeat detects a *dead worker*. Without the
  heartbeat, killing the API mid-import leaves the batch stuck "in progress" for 15 minutes. With it,
  the UI can say "the import stopped unexpectedly — resume?" within a minute.

**Sketch:**

```ts
// packages/jobs/src/handlers/import-run.ts
export const importRun: JobHandler<'import.run'> = async ({ importBatchId }, ctx) => {
  const batch = await loadBatch(db, importBatchId)
  if (batch.status === 'completed') return                       // idempotent re-entry
  await markRunning(db, importBatchId)

  for await (const chunk of stagedRowChunks(db, importBatchId, { size: 500, from: batch.lastCommittedRow })) {
    ctx.signal.throwIfAborted()
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL mutuals.defer_projection = 'on'`)   // storage-DECISION §2.x
      const result = await applyRows(tx, chunk)                          // packages/core decides; db writes
      await projectTouchedPairs(tx)                                      // ONE set-based projection
      await bumpCounters(tx, importBatchId, result, chunk.lastRowNumber)
    })
  }
  await markCompleted(db, importBatchId)
}
```

Note the handler contains **no decisions** — `applyRows` calls into `packages/core` for duplicate
matching and mapping. The job is orchestration only, so all the logic that can break silently is
unit-tested without a queue or a database.

---

## 8. ADR-J7 — where the worker runs

**Options.** (a) In-process inside `apps/api`. (b) A separate `apps/worker` process from day one.
(c) External invocation only (`pnpm jobs:run` from cron).

**Choice: (a), with (b) as a 15-line file that already exists.**

§3.2 requires "runs locally with one command" and §12's definition of done is one command on Simon's
laptop. A second process means a process manager, or a `concurrently` incantation, or Docker — none of
which exist here. So:

```ts
// apps/api/src/server.ts (excerpt)
const { queue, stop } = await createQueueFromEnv()          // InlineQueue or PgBossQueue
if (env.MUTUALS_WORKER !== 'off') {
  await startWorkers(queue)                                  // registers every handler
  await queue.syncSchedules(SCHEDULES)
  await ensureMetricsFresh(db, queue)
}
app.addHook('onClose', stop)
```

```ts
// apps/worker/src/main.ts — the whole file
const { queue, stop } = await createQueueFromEnv()
await startWorkers(queue)
await queue.syncSchedules(SCHEDULES)
process.on('SIGTERM', () => void stop())
```

Scaling out is then: run `apps/worker`, set `MUTUALS_WORKER=off` on the API. The `supervise: false` /
`schedule: false` constructor options exist for the case where several API replicas run and only one
should own maintenance and cron — documented in `ARCHITECTURE.md`, not built.

**Consequences.** A long handler competes for the API's event loop. At Phase-1 volumes (one import at a
time, one nightly sweep) this is fine, and the import handler's chunk boundaries are natural yield
points. If the API ever feels sluggish during an import, the fix is the flag, not a refactor.

---

## 9. ADR-J8 — testing jobs

- **Handlers are plain async functions** over a `db` and a `ctx`. Unit-tested directly with no queue at
  all. This is where the coverage requirement in §8.1 is satisfied.
- **Queue integration tests use pg-boss's built-in spies** (`__test__enableSpies: true`,
  `boss.getSpy(queue).waitForJob(sel, 'completed')`), which are race-safe by design and remove every
  `sleep()` from the suite. Verified v12 feature.
- **Cron is never tested by waiting.** `syncSchedules()` is tested by asserting `getSchedules()` output;
  the *handler* is tested directly. Nobody waits for 03:30.
- **`flow()` tests call `resolveFlow()`** to force a resolution pass instead of waiting for the
  background resolver. Verified.
- Teardown is `boss.stop({ graceful: false })` so a hung handler cannot hang CI.

---

# PART TWO — THE LLM MODULE

## 10. ADR-L1 — two layers: a task-shaped client over an OpenAI-compatible provider port

**Context.** §3.2 and §4.8 together demand: one internal `llm/` module; typed inputs and outputs; model
names as configuration *per task* (extraction, question answering, summaries, embeddings); structured
JSON for everything code parses; prompt versioning; cost logging; a replayable trace; `embed()` present
for §9; and a provider abstraction such that a direct Anthropic/OpenAI/Ollama base URL can be swapped
in. Plus the governing rule: **the LLM extracts; code decides.**

**Options.**

1. **A chat-shaped client** — `llm.chat({ model, messages, schema })` — with prompts assembled at each
   call site.
2. **A task-shaped client** — `llm.run(task, input)` where a *task* bundles prompt id, version, schema
   and model key — over a separate provider port for the wire format.
3. **The Vercel AI SDK** (`ai@7.0.91` + `@openrouter/ai-sdk-provider@3.0.0`), using `generateObject`
   with Zod schemas and the SDK's provider registry.

**Choice: (2).**

**Reasoning.**

- **(1) makes model configuration impossible to honour.** The brief says "one setting per task
  (extraction, question answering, summaries, embeddings)". If the unit of the API is a chat call, then
  every call site must know which setting it belongs to, and the mapping lives in thirteen places. If
  the unit is a *task*, the mapping is a property of the task and there is exactly one place. The same
  argument settles the trace: the interesting row is "which prompt version, on which input, cost what",
  and that is a task-run, not a chat call.
- **(3) is a genuinely good library and the wrong dependency here.** `generateObject` would replace
  perhaps 80 lines of ours. In exchange we would take on a large, fast-moving surface (v7 is recent) for
  a product that makes exactly two kinds of HTTP request; we would lose direct access to OpenRouter's
  non-standard fields (`usage.cost`, `provider.require_parameters`) except through provider-specific
  escape hatches; and — decisively — **the replayable trace becomes harder, not easier**: capturing and
  replaying the exact request/response bytes underneath an SDK's abstraction requires intercepting its
  transport, whereas above our own port it is a `ChatProvider` implementation that reads a file. The AI
  SDK is the right answer the day we need streaming, tool loops and half a dozen providers; it is
  recorded in `ARCHITECTURE.md` as the escape hatch.
- **Two layers, not one**, because the two axes of change are different. The *task* layer changes when
  the product changes (a new prompt, a new field). The *provider* layer changes when the vendor changes
  (a new base URL, a new auth header). Collapsing them means a prompt edit and a provider swap touch the
  same file.

### 10.1 The interfaces

```ts
// packages/llm/src/types.ts

/** The four configuration keys the brief names. Model per key, from env. */
export type TaskKind = 'extraction' | 'question' | 'summary' | 'embedding'

export interface PromptSpec<TInput, TOutput> {
  id: string                       // 'quick_capture_extract'
  version: number                  // 3   -> traced as 'quick_capture_extract@3'
  kind: Exclude<TaskKind, 'embedding'>
  /** THE schema. Source of both the wire JSON Schema and the runtime validation. */
  schema: z.ZodType<TOutput>
  render(input: TInput): ChatMessage[]
  temperature?: number
  maxOutputTokens?: number
}

export interface LlmClient {
  run<I, O>(prompt: PromptSpec<I, O>, input: I, ctx: CallContext): Promise<LlmResult<O>>
  embed(texts: string[], ctx: CallContext): Promise<EmbedResult>
  /** Cheap pre-flight so callers can render a disabled state instead of throwing. */
  status(): { enabled: boolean; mode: LlmMode; reason?: string }
}

export interface CallContext {
  workspaceId: string
  /** What this call is about, for the trace's FK. Optional: 'ask' has no single record. */
  recordId?: string
  requestId: string
  signal?: AbortSignal
}

export interface LlmResult<O> {
  value: O                         // already validated against prompt.schema
  traceId: string                  // llm_call.id
  model: string                    // what was actually served
  usage: Usage
  repaired: boolean                // true if the second attempt produced the value
}

/** The swappable layer. Everything here is the OpenAI-compatible wire shape. */
export interface ChatProvider {
  readonly id: string              // 'openrouter' | 'openai' | 'ollama' | 'fixture'
  readonly baseUrl: string
  complete(req: ChatRequest, signal?: AbortSignal): Promise<RawExchange>
}
export interface EmbeddingProvider {
  readonly id: string
  readonly baseUrl: string
  embed(req: EmbedRequest, signal?: AbortSignal): Promise<RawExchange>
}

/** Deliberately raw: the exact bytes, both directions. This is what makes the trace replayable. */
export interface RawExchange {
  requestBody: unknown
  responseBody: unknown
  httpStatus: number
  latencyMs: number
}
```

`ChatProvider` returns the raw exchange rather than a parsed result. Parsing, validating, repairing,
costing and tracing all happen in one place — `LlmClientImpl` — so a second provider cannot accidentally
implement any of them differently.

### 10.2 Provider swap matrix

| Target | `LLM_BASE_URL` | Auth | Works because |
|---|---|---|---|
| OpenRouter (default) | `https://openrouter.ai/api/v1` | `Authorization: Bearer` | native |
| OpenAI direct | `https://api.openai.com/v1` | `Authorization: Bearer` | same wire format; drop the `provider` field (ignored anyway) |
| Anthropic | their OpenAI-compatible endpoint | `Authorization: Bearer` | same wire format. A native-Messages-API adapter is a second `ChatProvider` implementation if ever needed — the port already allows it |
| Ollama / LM Studio / vLLM | `http://localhost:11434/v1` | none | same wire format; `usage.cost` absent → `cost_source = 'estimated'`, and for local it is 0 |

This is the brief's "plugged in by changing the base URL" made literal: for three of the four rows,
`.env` is the whole change.

---

## 11. ADR-L2 — hand-written `fetch` transport, not the `openai` SDK

**Options.** (a) `openai@7.9.0` pointed at OpenRouter's base URL. (b) ~180 lines of `fetch`.

**Choice: (b).**

**Reasoning.**

- The module makes exactly **two** kinds of request: `POST /chat/completions` and `POST /embeddings`,
  neither streaming in Phase 1. The SDK's value is concentrated in streaming parsing, tool loops,
  file uploads and the Assistants surface — none of which we use.
- **We depend on fields the SDK does not type in either direction**: outbound `provider:
  { require_parameters: true }`, `models: [...]`, `plugins`; inbound `usage.cost`,
  `usage.cost_details.upstream_inference_cost`, `is_byok`. Using the SDK means `as any` on both sides of
  every call, which defeats the point of using a typed SDK.
- **The trace wants the bytes.** `RawExchange.requestBody` must be exactly what went on the wire, so
  that `LLM_MODE=replay` can return `responseBody` and produce a bit-identical downstream result. Owning
  `fetch` makes that a variable; under an SDK it is an interception.
- Cost of (b): we implement retry/backoff and timeouts ourselves — about 30 lines, and they need tests
  anyway because the retry policy is a product decision (do not retry a 400; do retry a 429 honouring
  `Retry-After`; never retry a non-idempotent... all of ours are idempotent).

```ts
// packages/llm/src/providers/openai-compatible.ts
export class OpenAiCompatibleProvider implements ChatProvider, EmbeddingProvider {
  constructor(private cfg: {
    id: string; baseUrl: string; apiKey?: string; timeoutMs: number
    appUrl?: string; appTitle?: string
  }) {}
  get baseUrl() { return this.cfg.baseUrl }
  get id() { return this.cfg.id }

  async complete(req: ChatRequest, signal?: AbortSignal) { return this.post('/chat/completions', req, signal) }
  async embed(req: EmbedRequest, signal?: AbortSignal)   { return this.post('/embeddings',       req, signal) }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<RawExchange> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`
    // OpenRouter attribution headers. Harmless everywhere else.
    if (this.cfg.appUrl)   headers['HTTP-Referer'] = this.cfg.appUrl
    if (this.cfg.appTitle) headers['X-OpenRouter-Title'] = this.cfg.appTitle   // 'X-Title' also accepted

    let lastErr: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      const t0 = performance.now()
      const timeout = AbortSignal.timeout(this.cfg.timeoutMs)
      try {
        const res = await fetch(this.cfg.baseUrl + path, {
          method: 'POST', headers, body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
        const text = await res.text()
        const parsed = safeJson(text)
        const latencyMs = Math.round(performance.now() - t0)

        if (res.ok) return { requestBody: body, responseBody: parsed, httpStatus: res.status, latencyMs }
        if (!RETRYABLE.has(res.status) || attempt === 3) {
          throw new LlmHttpError(res.status, parsed, { requestBody: body, latencyMs })
        }
        await sleep(backoffMs(attempt, res.headers.get('retry-after')))
      } catch (err) {
        if (err instanceof LlmHttpError || signal?.aborted) throw err
        lastErr = err
        if (attempt === 3) throw new LlmTransportError(String(err), { cause: err })
        await sleep(backoffMs(attempt, null))
      }
    }
    throw lastErr
  }
}
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])
```

Note: **`usage: { include: true }` is never sent.** It is a deprecated no-op; usage including `cost`
comes back on every response automatically. Sending it is harmless but signals a stale understanding.

---

## 12. ADR-L3 — structured outputs: one Zod schema per prompt version, `strict: true`, and always re-validate

**Context.** §3.2: *"Use structured/JSON-schema outputs for everything that is parsed by code."*
Verified: OpenRouter accepts `response_format: { type: 'json_schema', json_schema: { name, strict,
schema } }`, and `provider.require_parameters: true` restricts routing to endpoints that actually
support the request's parameters. 340 of 424 currently-listed models advertise `structured_outputs`.

**Options.**

1. **`response_format` json_schema with `strict: true`**, plus `require_parameters`.
2. **Tool/function calling** with a single forced tool — the portable classic.
3. **Prose + a JSON block + a parser**, no schema at all.

**Choice: (1), with (2) recorded as the fallback for a base URL that lacks it, and never (3).**

**Reasoning.**

- (3) is what the brief explicitly forbids.
- (2) is more widely supported across small/local models than json_schema is, and it is the honest
  fallback for someone running Ollama. But it is strictly more machinery (a tool definition, a
  tool_calls response path, a "the model answered in prose instead of calling the tool" branch) for the
  same result, on the provider we actually target. Implement (1); if a `no_structured_outputs` error is
  seen, the error message names the fallback and the config flag `LLM_JSON_MODE=tool_call`. Do not build
  the fallback until someone needs it.

**Five rules that make this safe. These are the load-bearing part of this ADR.**

**R1 — the Zod schema is the only source.** JSON Schema is *derived*:

```ts
const jsonSchema = z.toJSONSchema(prompt.schema, {
  target: 'draft-2020-12',       // verified default; stated explicitly so an upstream default change is inert
  io: 'output',                  // verified: output mode emits additionalProperties:false on objects
  unrepresentable: 'throw',      // a Date or bigint in a wire schema is a bug, not a coercion
  cycles: 'throw',
  reused: 'inline',              // $defs/$ref support varies by provider; inline is universally safe
})
```

**R2 — no `.optional()` in a prompt schema; use `.nullable()`.** Strict structured-output modes require
every property to appear in `required`. An optional property produces a schema the provider rejects (or,
worse, silently downgrades to non-strict). Modelling "unknown" as `z.string().nullable()` is also the
better domain model: the extractor genuinely returns *"I did not find a city"*, which is a value, not an
absence.

**R3 — a CI test walks every registered prompt and asserts the generated schema is strict-compatible.**

```ts
// packages/llm/test/schema-contract.test.ts
const ALLOWED = new Set(['type','properties','required','additionalProperties','items','enum',
                         'anyOf','description','$schema','title','const'])

test.each(ALL_PROMPTS)('$id@$version emits a strict-compatible schema', (p) => {
  const js = toWireSchema(p.schema)
  walk(js, (node, path) => {
    for (const k of Object.keys(node)) {
      expect(ALLOWED.has(k), `${p.id}@${p.version}: unsupported keyword "${k}" at ${path}`).toBe(true)
    }
    if (node.type === 'object') {
      expect(node.additionalProperties).toBe(false)
      expect(new Set(node.required ?? [])).toEqual(new Set(Object.keys(node.properties ?? {})))
    }
  })
})
```

The allowlist is deliberately narrower than what any provider supports, because OpenRouter's docs do not
enumerate the restriction (§0.2 item 4). Semantic constraints — is this a real email, is this select
option one that exists in *this* workspace — belong in the **validation** step in `packages/core`, not
in the wire schema. That is the brief's "the LLM extracts; code decides" applied to schema design:
the wire schema describes *shape*; the domain decides *validity*.

**R4 — the runtime validation always runs, and there is exactly one repair attempt.** `strict: true` is
a strong hint, not a guarantee — OpenRouter's own documentation says enforcement varies by provider,
with some translating the schema and some treating it as a hint. So:

```ts
async run<I, O>(prompt: PromptSpec<I, O>, input: I, ctx: CallContext): Promise<LlmResult<O>> {
  await this.budget.assertWithinDailyLimit()

  const messages = prompt.render(input)
  const model    = this.config.modelFor(prompt.kind)
  const request  = {
    model,
    messages,
    temperature: prompt.temperature ?? 0,
    max_tokens: prompt.maxOutputTokens ?? 1024,
    response_format: {
      type: 'json_schema' as const,
      json_schema: { name: `${prompt.id}_v${prompt.version}`, strict: true, schema: toWireSchema(prompt.schema) },
    },
    // Only route to endpoints that actually honour response_format. Verified field.
    provider: { require_parameters: true },
  }

  const first = await this.exchange(prompt, input, request, ctx, { attempt: 1, repairOf: null })
  if (first.ok) return first.result

  // ONE repair. The model is shown its own output and the exact validation errors.
  const repairRequest = {
    ...request,
    messages: [...messages,
      { role: 'assistant' as const, content: first.rawText ?? '' },
      { role: 'user' as const, content: repairInstruction(first.issues) }],
  }
  const second = await this.exchange(prompt, input, repairRequest, ctx, { attempt: 2, repairOf: first.traceId })
  if (second.ok) return { ...second.result, repaired: true }

  throw new LlmSchemaError(prompt.id, prompt.version, second.issues, second.traceId)
}
```

One repair, not a loop: two failures against a schema this small means the prompt or the model is wrong,
and burning tokens will not fix it. Both attempts are separate `llm_call` rows linked by `repair_of_id`,
so the repair rate per prompt version is a queryable number — and a rising repair rate is the signal to
bump the prompt version or the model.

**R5 — do not use OpenRouter's "Response Healing" plugin.** It exists and it would reduce invalid-JSON
rates. It is also OpenRouter-only, so relying on it means the module behaves differently against a
direct Ollama base URL — precisely the divergence the provider abstraction exists to prevent. Our repair
step is portable.

---

## 13. ADR-L4 — prompts as versioned TypeScript modules, locked by hash

**Options.** (a) TS modules under `prompts/<id>/vN.ts`. (b) Markdown/YAML files loaded at runtime.
(c) Rows in a `prompt` table, editable in Settings.

**Choice: (a).**

**Reasoning.** (c) is a Phase-2 feature (nobody in Phase 1 edits prompts but the engineer, and the
brief's Settings scope is explicitly "Nothing else in Phase 1"). (b) reads nicer but loses the typed
`render(input)` signature — which is exactly where prompt bugs live (a renamed field silently rendering
`undefined`) — and adds runtime file IO and a packaging concern. (a) gives type checking, git diffs,
and refactoring.

```ts
// packages/llm/src/prompts/quick_capture_extract/v3.ts
export const quickCaptureExtractV3 = definePrompt({
  id: 'quick_capture_extract',
  version: 3,
  kind: 'extraction',
  temperature: 0,
  schema: z.object({
    contact: z.object({
      first_name: z.string().nullable(),
      last_name:  z.string().nullable(),
      // Note: a SLUG, not a value. Code resolves slugs to attribute ids and rejects unknown ones.
      attributes: z.array(z.object({
        slug:  z.string(),
        value: z.string(),
        confidence: z.number(),
      })),
    }).nullable(),
    organization: z.object({ name: z.string(), attributes: z.array(AttributeGuess) }).nullable(),
    interaction:  z.object({ type: z.enum(INTERACTION_TYPES), title: z.string(), body: z.string(),
                             occurred_at: z.string().nullable() }).nullable(),
    follow_up:    z.object({ title: z.string(), due_in_days: z.number().int().nullable() }).nullable(),
  }),
  render: ({ text, schema, today }: QuickCaptureInput) => ([
    { role: 'system', content: SYSTEM },
    { role: 'user',   content: `Today: ${today}\nAvailable attributes:\n${renderSchema(schema)}\n\nText:\n${text}` },
  ]),
})
```

Two properties worth naming:

- **The extractor returns *candidates*, never decisions.** It emits attribute *slugs* and a confidence;
  `packages/core` resolves slugs against `attribute_definition`, drops unknown ones, runs the
  deterministic identifier probe for contact matching, and only then does the API render a preview. The
  model never picks which existing contact this is. That is §4.8, enforced by the return type.
- **Version bump policy.** Any change to `render()`'s output or to `schema` requires a new `vN.ts`. Old
  versions stay in the repo so old traces remain interpretable and replayable. Enforced mechanically:

```ts
// packages/llm/prompts.lock.json  (checked in)
{ "quick_capture_extract@3": "9f2c…", "ask_to_filter@2": "b81e…", "contact_summary@1": "4dd0…" }
```

A CI test hashes each registered prompt's `render()` output over a fixed sample input plus its wire
schema, and compares to the lock file. Editing a prompt without bumping the version fails CI with
*"prompt quick_capture_extract@3 changed; bump to v4 and add prompts.lock.json entry"*. This is what
makes "prompt versioning" a fact rather than a convention — and it is also what stops a silent prompt
edit from replaying stale fixtures (§14).

---

## 14. ADR-L5 — the trace: one Postgres table, fixtures exported from it

**Context.** §3.2 requires "prompt versioning, cost logging and a replayable trace". "Replayable" is the
demanding word: it means a past call can be re-run, deterministically, without the network.

**Options.**

1. **A table in the app's Postgres** (`llm_call`), with an export step that produces file fixtures.
2. **JSONL files on disk** under `.mutuals/traces/`.
3. **An external LLM-observability service** (Langfuse, Helicone, OpenRouter's own dashboard).

**Choice: (1).**

**Reasoning.**

- **(3) violates "no proprietary services in the critical path"** and adds a second datastore, which the
  brief rules out for search and should equally rule out here. OpenRouter's dashboard is a fine
  *supplement* — and `generation_id` is stored precisely so a row can be looked up there — but it cannot
  be the trace, because it does not hold our prompt version, our parsed output, or our schema failures.
- **(2)** is tempting and loses too much: the trace wants to be *joined* — "every LLM call about this
  contact", "cost by prompt version this month", "the repair rate for `ask_to_filter@2`". A file tree
  answers none of those without grep. It also does not survive a `git clean`. Postgres is already there
  and the brief's own rule is "all in the one database, no second datastore".
- The bulk concern (bodies are the big part) is handled by retention, not by a different store (below).

### 14.1 The table

```sql
CREATE TABLE llm_call (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid REFERENCES workspace(id) ON DELETE CASCADE,

  -- what was asked
  task_kind         text NOT NULL CHECK (task_kind IN ('extraction','question','summary','embedding')),
  prompt_id         text NOT NULL,          -- 'quick_capture_extract'; 'embedding' for embed()
  prompt_version    integer NOT NULL,
  prompt_hash       text NOT NULL,          -- sha256 of the rendered messages
  input_hash        text NOT NULL,          -- sha256 of canonicalJson(task input)

  -- who answered
  provider          text NOT NULL,          -- 'openrouter' | 'openai' | 'ollama' | 'fixture'
  base_url          text NOT NULL,
  model_requested   text NOT NULL,
  model_served      text,                   -- response.model — OpenRouter may serve a variant
  upstream_provider text,                   -- OpenRouter's chosen upstream, when reported
  generation_id     text,                   -- response.id -> GET /api/v1/generation?id=

  -- the bytes, exactly. No API key is ever inside: auth lives in a header.
  request_body      jsonb,
  response_body     jsonb,

  -- what happened
  status            text NOT NULL CHECK (status IN
                      ('ok','invalid_json','schema_error','http_error','timeout','budget_exceeded','disabled')),
  http_status       integer,
  attempt           smallint NOT NULL DEFAULT 1,
  repair_of_id      uuid REFERENCES llm_call(id) ON DELETE SET NULL,
  error_detail      jsonb,                  -- zod issues, or the provider error body
  parsed            jsonb,                  -- the VALIDATED task output; NULL unless status='ok'

  -- what it cost
  prompt_tokens     integer,
  completion_tokens integer,
  reasoning_tokens  integer,
  cached_tokens     integer,
  cost_usd          numeric(12,8),
  cost_source       text CHECK (cost_source IN ('reported','estimated','free')),
  latency_ms        integer,

  -- what it was about
  record_id         uuid REFERENCES record(id) ON DELETE SET NULL,
  request_id        text,                   -- correlates with the HTTP access log
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX llm_call_created_idx ON llm_call (created_at DESC);
CREATE INDEX llm_call_task_idx    ON llm_call (prompt_id, prompt_version, created_at DESC);
CREATE INDEX llm_call_record_idx  ON llm_call (record_id, created_at DESC) WHERE record_id IS NOT NULL;
-- the replay probe: newest successful call for this exact (prompt, prompt text, model, input)
CREATE INDEX llm_call_replay_idx  ON llm_call (prompt_id, prompt_version, prompt_hash, model_requested,
                                               input_hash, created_at DESC)
  WHERE status = 'ok';
-- the budget probe (§16)
CREATE INDEX llm_call_cost_idx    ON llm_call (created_at) WHERE cost_usd IS NOT NULL;
```

It hangs off `record` with `ON DELETE SET NULL`, not `CASCADE`: deleting a contact should not erase the
cost record of work already paid for.

### 14.2 The replay key, and why it has five parts

`(prompt_id, prompt_version, prompt_hash, model_requested, input_hash)`

- `input_hash` = `sha256(canonicalJson(input))` — sorted keys, no whitespace, a pure function in
  `packages/core` with its own unit tests. Without canonicalisation, key order changes the hash and
  every replay misses.
- `prompt_hash` is the belt to `prompt_version`'s braces. If someone edits a prompt's wording and
  forgets to bump the version, `prompt_hash` changes, the replay misses, and CI fails with a missing
  fixture rather than silently testing yesterday's prompt. Combined with `prompts.lock.json` (ADR-L4),
  a silent prompt edit is impossible to land.
- `model_requested` is in the key because the same prompt on a different model is a different fixture.

### 14.3 Modes

```
LLM_MODE=live     # default in dev: call the provider, write the trace
LLM_MODE=record   # like live, and additionally export each successful exchange as a file fixture
LLM_MODE=replay   # never touch the network; resolve from fixtures (CI) or from llm_call (local)
LLM_MODE=off      # client.status().enabled === false; every run() throws LlmDisabledError
```

`off` is not a testing convenience — it is a **product requirement**. §12's definition of done must hold
for someone who cloned the repo and has no OpenRouter key: the whole CRM works, and only the LLM surfaces
(the Ask box, Quick capture, the Summary card) render a disabled state saying *"Add
`OPENROUTER_API_KEY` to `.env` to enable"*. `status()` exists so the UI can render that without catching
an exception.

`replay` resolution order: file fixture → newest matching `llm_call` row → **fail loudly** with the
exact command to record it:

```
LlmFixtureMissing: quick_capture_extract@3 / gemini-3.5-flash-lite / input 4f2a…
  Record it with:  LLM_MODE=record pnpm --filter @mutuals/llm fixture:record quick_capture_extract 4f2a…
```

A missing fixture must never silently fall through to a live call — that is how a CI run quietly spends
money and becomes non-deterministic.

### 14.4 Retention

Bodies dominate the size (a quick-capture exchange is a few KB; a summary with a year of interactions
could be 30 KB). `llm.trace-prune` (ADR-J5's second schedule, Stage 6) nulls `request_body` and
`response_body` older than 30 days and keeps every metadata and cost column forever. Cost history stays
complete; the replay corpus stays bounded. Configurable via `LLM_TRACE_RETENTION_DAYS`; `0` keeps
bodies forever. `LLM_TRACE_BODIES=off` writes metadata only, for anyone uncomfortable with contact notes
sitting in a second table — noting that they are already in the first one, so this is a preference, not
a security control.

---

## 15. ADR-L6 — embeddings

**Verified today:** OpenRouter has a real, OpenAI-shaped embeddings endpoint. `POST
/api/v1/embeddings`, request `{ model, input, dimensions?, encoding_format?, input_type?, provider? }`,
response `{ id, object, model, data: [{ embedding, index, object }], usage: { prompt_tokens,
total_tokens, cost?, cost_details?, prompt_tokens_details? } }`. No streaming. 37 embedding models are
live, including `openai/text-embedding-3-small` at **$0.02 per million prompt tokens**, context 8192,
native dimension **1536** — which is exactly the `search_document.embedding vector(1536)` column the
storage decision already created, and comfortably under pgvector's 2000-dimension HNSW cap that the same
decision recorded.

**So the brief's contingency — "if OpenRouter does not cover embeddings well enough at build time, use a
second provider behind the same interface and document it" — does not need to be exercised. The design
must nonetheless make exercising it free**, because a model catalogue is not a contract and because a
local Ollama base URL will have different model names and dimensions.

**Options.**

1. `embed()` on the same provider object as `complete()`, sharing base URL and key.
2. A **separate `EmbeddingProvider`** with its own optional base URL and key, defaulting to the chat
   ones.
3. Skip `embed()` in Phase 1 and add it in Stage 8.

**Choice: (2).**

(3) is ruled out by §9, which names `embed()` on the provider interface as the extension point. (1) is
simpler but makes "use a different provider for embeddings" a code change. (2) makes it two environment
variables:

```
LLM_EMBEDDING_BASE_URL=          # blank -> falls back to LLM_BASE_URL
LLM_EMBEDDING_API_KEY=           # blank -> falls back to LLM_API_KEY
LLM_MODEL_EMBEDDING=openai/text-embedding-3-small
LLM_EMBEDDING_DIMENSIONS=1536
```

### 15.1 Two guards that must exist before any backfill

**Guard 1 — dimension is a deployment-wide invariant, asserted once, cheaply.**

```ts
// runs once per process, on first use of embed(), NOT at API boot
async function assertEmbeddingDimension(p: EmbeddingProvider, cfg: EmbedConfig) {
  const { data } = await p.embed({ model: cfg.model, input: ['mutuals'], encoding_format: 'float' })
  const got = data[0].embedding.length
  if (got !== cfg.dimensions) {
    throw new LlmConfigError(
      `LLM_MODEL_EMBEDDING=${cfg.model} returns ${got} dimensions but ` +
      `search_document.embedding is vector(${cfg.dimensions}). ` +
      `Either set LLM_EMBEDDING_DIMENSIONS=${got} and migrate the column, or pick a ${cfg.dimensions}-dim model.`)
  }
}
```

One request, one token, fractions of a cent — and it turns "a 10k-row backfill that silently wrote
nothing" into a startup error with the fix in the message. The check is on **first use**, not at boot,
so a workspace with embeddings disabled never pays for it and the API still starts without a key.

**Guard 2 — never mix models in one column.** `search_document.embedding_model` already exists in the
storage design. The rule: a semantic query is only allowed to compare vectors whose `embedding_model`
matches the currently configured one. Changing `LLM_MODEL_EMBEDDING` therefore invalidates the corpus
and requires a re-embed; `pnpm llm:reembed` is the named command, and until it finishes, `search?mode=
semantic` falls back to `keyword` rather than returning wrong neighbours. Cosine distance between
vectors from two different models is meaningless, and it fails *silently* — plausible-looking but wrong
results. Worth the four lines.

### 15.2 What Phase 1 actually ships

`embed()` exists, is typed, is covered by a fixture test, logs cost, and **is called by nothing**.
`search?mode=` accepts only `keyword`. That is the honest state of an extension point: the interface is
proven by a test, not by a user. The Stage-8 work is then: an `embeddings.backfill` job, the HNSW index
(created *after* the backfill, per the storage decision), and one branch in the search compiler.

**Batching, for when it is used:** OpenRouter's `input` accepts an array. Batch at 96 texts or 100k
characters, whichever comes first, one `llm_call` row per HTTP request (not per text), and store the
per-request `usage.cost`. 10k contacts at ~200 tokens each is ~2M tokens ≈ **$0.04** with
`text-embedding-3-small`. Cost is not the constraint; correctness of the dimension is.

**If OpenRouter drops embeddings, or the model is unavailable:** the documented fallback order is
(1) another OpenRouter embedding model of the same dimension — `google/gemini-embedding-2` and
`qwen/qwen3-embedding-4b` both support the `dimensions` parameter, so 1536 is reachable;
(2) `LLM_EMBEDDING_BASE_URL=https://api.openai.com/v1` with an OpenAI key — same wire format, zero code;
(3) a local Ollama with `nomic-embed-text` (768 dims) plus a `vector(768)` migration. All three are
config, not code, which is the whole point of ADR-L6.

---

## 16. ADR-L7 — cost logging and a hard daily budget

**Context.** §3.2 requires cost logging. Nothing requires a budget — I am proposing one anyway, and
here is why: this is an open-source personal tool where a user pastes their own OpenRouter key into
`.env`, and where Stage 6 introduces an agent loop over user text. A bug that retries in a loop spends
someone's real money. A cap is fifteen lines.

**Options.** (a) `usage.cost` only. (b) `usage.cost`, with an estimated fallback from a cached price
table. (c) (b) plus a pre-flight daily cap.

**Choice: (c).**

**How cost is obtained, in priority order:**

1. **`usage.cost` from the response.** Verified: always present on OpenRouter, no opt-in parameter
   (`usage: { include: true }` is a deprecated no-op). → `cost_source = 'reported'`.
2. **Estimated from a cached price table** when the provider does not report cost (direct OpenAI,
   Ollama, a proxy). `GET https://openrouter.ai/api/v1/models` is public and needs **no API key** —
   verified by fetching it unauthenticated — and returns `pricing.prompt` / `pricing.completion` per
   model as USD-per-token strings. A daily job caches it into `llm_model_price`; cost is
   `prompt_tokens × pricing.prompt + completion_tokens × pricing.completion`. → `cost_source =
   'estimated'`.
3. **Zero** for a `localhost` base URL. → `cost_source = 'free'`.

`GET /api/v1/generation?id=…` is deliberately **not** called per request — it is a second round trip for
a number already in the response. It is documented as the reconciliation tool: `generation_id` is
stored, so an audit can fetch authoritative stats later.

**The cap:**

```ts
async assertWithinDailyLimit() {
  if (this.limitUsd <= 0) return
  const [{ spent }] = await db.execute(sql`
    SELECT coalesce(sum(cost_usd), 0)::numeric AS spent
      FROM llm_call
     WHERE created_at > now() - interval '24 hours'`)
  if (Number(spent) >= this.limitUsd) {
    throw new LlmBudgetError(
      `Daily LLM budget of $${this.limitUsd} reached ($${spent} spent in the last 24h). ` +
      `Raise LLM_DAILY_COST_LIMIT_USD or wait.`)
  }
}
```

Indexed by `llm_call_cost_idx`, over at most a few hundred rows: sub-millisecond. `LlmBudgetError` maps
to HTTP 429 with that message; the UI shows it verbatim, because it is actionable. Default
`LLM_DAILY_COST_LIMIT_USD=2.00`; `0` disables the cap. The check is deliberately *pre-flight and
approximate* — it cannot prevent the one call that crosses the line, only the next one. That is the
right trade for fifteen lines.

**Cost visibility:** one endpoint, `GET /api/v1/stats/llm`, returning spend by day and by prompt
version. It costs one query, it feeds §9's "dashboard charts" extension point, and it is the only way
anyone will ever notice that `contact_summary@1` costs ten times what it should.

---

## 17. ADR-L8 — the module boundary, enforced by lint rather than by prose

**Context.** §3.2: *"no LLM calls scattered through business logic"*. §4.8: *"The LLM extracts; code
decides."* Both are rules that decay unless a machine checks them.

**Options.** (a) Document the rule in `CLAUDE.md` and review for it. (b) An ESLint
`no-restricted-imports` rule.

**Choice: (b), in addition to (a).**

```js
// eslint.config.js (excerpt)
{
  files: ['apps/**', 'packages/**'],
  ignores: [
    'apps/api/src/routes/ask.ts',
    'apps/api/src/routes/quick-capture.ts',
    'apps/api/src/routes/contacts.summary.ts',
    'packages/jobs/src/handlers/llm-*.ts',
    'packages/llm/**',
  ],
  rules: {
    'no-restricted-imports': ['error', { patterns: [{
      group: ['@mutuals/llm', '@mutuals/llm/*'],
      message: 'LLM calls live in the three LLM routes and the llm.* job handlers only (brief §3.2). ' +
               'If you need model output elsewhere, pass the already-validated value in.',
    }]}],
  },
}
```

Consequence: `packages/core` — where duplicate matching, filter compilation and warmth live — **cannot
import the LLM module at all**. Which is the point: the extractor's output is passed *into* core as
plain validated data, and core's decisions are unit-testable with no model, no network and no fixtures.
This is the architectural expression of "the LLM extracts; code decides", and it is checked by CI.

---

## 18. ADR-L9 — testing the LLM module without spending money

**Options.** (a) Live calls in CI with a repo secret. (b) HTTP-level mocking only. (c) A layered scheme:
fixture provider for logic, HTTP mocking for the transport contract, opt-in live smoke for refresh.

**Choice: (c).**

(a) is out: it costs money per CI run, it is non-deterministic (models drift), and secrets are not
available to fork PRs in a public repo — so the open-source contributor experience would be a red CI
they cannot fix. (b) alone is insufficient because it tests the wire and not the *task* layer, which is
where the repair loop, the budget check and the trace write live.

**The four layers.**

**L1 — schema and prompt tests (no network, no database).** `prompts.lock.json` hash check (ADR-L4);
`assertStrictCompatible` over every registered prompt (ADR-L3 R3); a `z.toJSONSchema` snapshot per
prompt version so a Zod upgrade that changes emission is caught by a diff rather than by a production
400. Runs in milliseconds; catches the majority of real regressions.

**L2 — client logic tests via a `FixtureProvider` (no network).**

```ts
// packages/llm/test/support/fixture-provider.ts
export class FixtureProvider implements ChatProvider {
  readonly id = 'fixture'
  readonly baseUrl = 'fixture://'
  constructor(private dir: string) {}
  async complete(req: ChatRequest): Promise<RawExchange> {
    const key = replayKey(req)                                   // same function the client uses
    const file = path.join(this.dir, `${key}.json`)
    if (!existsSync(file)) throw new LlmFixtureMissing(key, recordCommandFor(key))
    const fx = JSON.parse(readFileSync(file, 'utf8'))
    return { requestBody: req, responseBody: fx.response, httpStatus: 200, latencyMs: 0 }
  }
}
```

Cases covered here, all deterministic: happy path; malformed JSON → repair succeeds; malformed JSON →
repair fails → `LlmSchemaError` with both trace rows linked by `repair_of_id`; schema-valid but
domain-invalid (an unknown attribute slug) → core rejects it and the preview shows nothing invented;
budget exceeded; `LLM_MODE=off`. Note that the *interesting* tests are the failures — the happy path is
one test, the failure modes are eight, and none of them can be produced reliably against a live model.

**L3 — provider contract tests with `msw@2.15.0` (HTTP, still no network).** Six tests, asserting the
things only the wire can show: the `Authorization` header is present and the key never appears in
`request_body`; `HTTP-Referer` / `X-OpenRouter-Title` are set; `response_format.json_schema.strict ===
true`; `provider.require_parameters === true`; `usage: {include: true}` is *not* sent; a 429 with
`Retry-After: 1` retries once and then succeeds; a 400 does not retry; a timeout raises
`LlmTransportError`. See §0.2 item 3 for the `undici` `MockAgent` fallback if MSW's fetch interception
misbehaves on Node 24.

**L4 — opt-in live smoke, never in CI.**

```jsonc
"scripts": {
  "llm:smoke": "LLM_LIVE=1 vitest run --project llm-live",   // skipped unless LLM_LIVE=1
  "llm:record": "LLM_MODE=record pnpm llm:smoke"             // refreshes every fixture
}
```

One run per registered prompt against the configured model, asserting only *"the response validated
against the schema"* — never asserting content, because content is model-dependent and the test would
be flaky by construction. Running it costs a fraction of a cent and is how fixtures are refreshed when a
model or a prompt version changes. Documented in `CONTRIBUTING.md` as the one command that spends money.

**L5 — Playwright e2e** runs the API with `LLM_MODE=replay` and the checked-in fixture set, so §8.1's
quick-capture and ask flows are end-to-end tested with zero cost and zero flake.

**The fixture lifecycle, which is the neat part:** fixtures are not hand-written. `LLM_MODE=record`
writes to `llm_call` *and* exports `packages/llm/fixtures/<prompt_id>@<version>/<hash>.json`. So a
developer clicking around the app in `record` mode is generating the test corpus, and
`pnpm llm:export-fixtures --since 7d` promotes any real interaction into a regression test. The trace
table and the fixture store are the same artefact at two lifetimes.

---

## 19. Configuration, complete

`.env.example` (the LLM and jobs portions):

```bash
# ---------- LLM ---------------------------------------------------------------
# One key, any model. https://openrouter.ai/keys
OPENROUTER_API_KEY=
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODE=live                     # live | record | replay | off
LLM_TIMEOUT_MS=60000
LLM_DAILY_COST_LIMIT_USD=2.00     # 0 disables the cap
LLM_TRACE_BODIES=on               # off -> metadata only
LLM_TRACE_RETENTION_DAYS=30       # 0 -> keep request/response bodies forever

# One model per task (brief §3.2). PIN EXACT IDS — do NOT use OpenRouter's
# floating "~vendor/model-latest" aliases: they move without warning and can
# lose structured-output support or change price under you.
LLM_MODEL_EXTRACTION=google/gemini-3.5-flash-lite
LLM_MODEL_QUESTION=openai/gpt-5.4-mini
LLM_MODEL_SUMMARY=google/gemini-3.5-flash-lite
LLM_MODEL_EMBEDDING=openai/text-embedding-3-small

# Embeddings may live on a different provider entirely (brief §3.2 escape hatch).
# Blank -> falls back to LLM_BASE_URL / OPENROUTER_API_KEY.
LLM_EMBEDDING_BASE_URL=
LLM_EMBEDDING_API_KEY=
LLM_EMBEDDING_DIMENSIONS=1536     # MUST equal search_document.embedding vector(N)

# OpenRouter attribution (optional, shows the app on their leaderboards)
LLM_APP_URL=https://getmutuals.ai
LLM_APP_TITLE=Mutuals

# ---------- Jobs --------------------------------------------------------------
JOBS_DRIVER=inline                # inline (Stage 1-4) | pgboss (Stage 5+)
PGBOSS_SCHEMA=pgboss
MUTUALS_WORKER=on                 # off -> API serves HTTP only, run apps/worker separately
MUTUALS_TZ=Europe/Berlin          # timezone for cron schedules
```

**Model choices, and how to change your mind.** The three chat defaults above are the cheap tier
(sub-$1/M input) and every one of them advertises `structured_outputs` today. They are *defaults*, not
decisions: swapping `LLM_MODEL_QUESTION` to `anthropic/claude-sonnet-5` is one line and a restart, and
the trace makes the before/after comparison a SQL query (repair rate and cost per prompt version). The
config module reads models through a single function:

```ts
export function modelFor(kind: TaskKind): string { /* db override (later) ?? env ?? default */ }
```

so a Settings-page override backed by a `llm_setting` table is a one-line change when someone wants
"without a deploy" to mean "without a restart". Not built now.

---

## 20. Stage placement, consolidated

| Stage | Jobs | LLM |
|---|---|---|
| 1 | `packages/jobs`: port, registry, `InlineQueue`, `schedules.ts`, `runner`, `pnpm jobs:run`. Handler: `metrics.warmth-sweep`. Boot catch-up. **No pg-boss dependency.** | `packages/llm` scaffold + the `llm_call` migration (it is a table; adding it in Stage 6 would be a second migration for no reason). No provider, no prompts. |
| 2–4 | handlers only | — |
| 5 | **pg-boss 12.29.0 lands.** `PgBossQueue`, `import.run` + `import.failed`, real cron, `syncSchedules()`, spy-based integration tests. | — |
| 6 | `llm.contact-summary`, `llm.trace-prune` | Everything: providers, prompts v1, structured outputs, repair, trace writes, fixtures, budget, `embed()` (tested, unused), `GET /stats/llm`, the ESLint boundary. |
| 7 | — | Fixture corpus refresh; the `LLM_MODE=off` empty states audited. |
| §9 later | `nudges.scan` — one `SCHEDULES` entry + one handler over a pure `packages/core` function | `embeddings.backfill`, HNSW index, `search?mode=semantic` |

---

## 21. Risks, named

1. **pg-boss is maintained by one person.** Mitigated by the `JobQueue` port (one adapter file to
   replace) and by `DROP SCHEMA pgboss CASCADE` being a complete uninstall. Graphile Worker is the named
   substitute in `ARCHITECTURE.md`.
2. **`strict: true` is a hint, not a guarantee**, and the guarantee varies by upstream provider even for
   the same model. Mitigated by always re-validating, by `require_parameters: true`, and by the one-shot
   repair. Measurable: repair rate per prompt version, straight out of `llm_call`.
3. **The trace table holds user text in a second place.** For a private single-user CRM this is
   acceptable (the brief: "Data privacy is not a design driver right now"), and `LLM_TRACE_BODIES=off`
   plus 30-day body pruning exist for anyone who disagrees. It is not a security boundary and is not
   claimed to be one.
4. **Model catalogues drift.** The four default model ids will age. Mitigated by pinning exact ids (not
   `~…-latest`), by the live smoke test failing loudly when a model 404s, and by a `README` line telling
   the reader to check `openrouter.ai/models?supported_parameters=structured_outputs`.
5. **Cron only fires while the process runs.** Structural for a laptop-hosted app. Mitigated by the boot
   catch-up (§6); flagged as open question Q3 because it is a product behaviour Simon should confirm.
6. **The 2-second polling latency is visible in the import UI.** Accepted deliberately (ADR-J4); the UI
   must render a "queued" state. This is a Stage-5 acceptance criterion, not a bug to discover later.
7. **Every latency and cost figure here is an estimate.** Stage 5 must record a real 10k-row import
   wall-clock, and Stage 6 must record real per-task token counts and costs, into
   `docs/ARCHITECTURE.md` — the same discipline the storage decision imposes on its own numbers.
