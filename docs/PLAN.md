# Mutuals — Implementation Plan (Stage 0)

**Status:** approved. **Stages 1–3 are complete** — see §5 for what Stage 1's definition of done
actually measured, ADR-087/088 for what Stage 2's closing section changed, and ADR-090/091/092 for
Stage 3. Stage 4 has not started.
**Branch:** `version/claude-v1`. **Source of truth for product decisions:** [`BRIEF.md`](./BRIEF.md).
**Decision log:** [`DECISIONS.md`](./DECISIONS.md) — 92 ADRs. **Rejected designs:** `adr-archive/`.

This plan has the two layers the brief asks for in §0. Layer 1 is for Simon and contains no code and
no file paths. Layer 2 is for the co-founder.

---

# Layer 1 — Plain summary

## What we are building

A personal CRM for your network. Four things live in it: **people**, **organizations**,
**interactions** (every time you spoke to someone) and **follow-ups** (reminders). On top of that, one
idea does most of the work: **you invent the fields yourself.** "Ticket size", "met at", "fund stage"
— you add them in Settings and they immediately become real columns you can filter, sort and edit,
without anyone touching the software. That is the part everything else is built around.

## The five decisions worth your attention

**1. Nothing is ever silently overwritten.** Under every value sits a small logbook: what the value
was, when we learned it, and where it came from — you typing it, an import, or later the AI. Change
someone's company and the old one is not deleted, it is dated. So the app can say _"Stripe since June
2025, from LinkedIn; before that Northstar since January 2023, typed by you."_ This is also what makes
your **"looking for" / "can offer"** tags carry their date automatically, which you asked for: an
entry knows when it appeared and when it went away, so a request from two years ago is visibly old
rather than looking current. It costs nothing extra now and it is what later makes "X is looking for
what Y offers — introduce them?" possible without guessing.

**2. Duplicates are caught by identity, not by name.** Two records sharing an email address, a phone
number or a LinkedIn profile are the same person with near-certainty. Similar names are only ever the
fallback, and when the app is unsure it asks you instead of deciding. That is a deliberate rule: the
AI reads and suggests, code decides.

**3. Warmth.** Every person gets a 0–100 number for how alive the relationship is, computed from your
interactions — a meeting counts more than an email, and everything fades over about three months. It
is calibrated so that meeting someone once a month sits at about 75. You can pin someone as important
(never falls below 60) or mute them (never rises above 10, and they stay out of future nudges).

**4. It runs on your laptop, with one command.** Docker is installed and I have already verified the
database it needs works on your machine. `pnpm dev` will start everything. No cloud account is
required to run it; nothing about it is locked to a paid service.

**5. The AI is one guest, not the host.** Everything the screen can do, the interface underneath can
do too. That is why a chat bot, a command-line tool or an AI agent can be added later as just another
visitor — no rebuild. The AI parts themselves (ask a question about your network, type one sentence
after a meeting and have it filled in, per-person summaries) arrive in Stage 6, and every AI call has
a spending cap you control.

## What you will be able to try, and roughly when

| Stage                                | What you can click on at the end of it                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — Foundation**                   | Nothing visual yet. The engine and the documented interface behind it, with a filled-in demo database of ~200 people so nothing is empty later.                                             |
| **2 — Contacts + your own fields**   | The real app opens. The contacts table with filtering, sorting, column choosing and editing-in-place. You invent your own fields in Settings and they appear as columns.                    |
| **3 — Organizations + person pages** | Organizations, and the person page: header, activity history, work history that reads like a CV, and every field in the right-hand column.                                                  |
| **4 — Follow-ups + dashboard**       | Reminders with repetition and snoozing, the home screen with its numbers and its "needs your attention" list, and saved table views.                                                        |
| **5 — Import**                       | Drop in your LinkedIn or Google export, map the columns, fix errors in a grid, and get told which rows look like people you already have. Merging two records by hand.                      |
| **6 — The AI**                       | Ask your network a question in plain language and see _which search it ran_. Type one sentence after a meeting and confirm what it wants to save. Per-person summaries. The ⌘K command bar. |
| **7 — Polish**                       | Empty states, keyboard shortcuts, a speed pass at 10,000 rows, screenshots in the README, version 0.1.0.                                                                                    |

I stop at the end of each stage, show you what works and how to try it, and wait.

## What I need from you

Right now: **approval of this plan**, and answers to four small questions — they are listed at the end
of Layer 2 in your language, and each has a recommendation you can simply agree with. None of them
blocks me from starting Stage 1.

Two things you already settled, recorded so they are not lost: the old app on `main` is untouched and
nothing is carried over from it, and your "looking for / can offer" entries stay simple tags but
always show their date.

---

# Layer 2 — Technical detail

## 1. Stack, and why, against the §3.2 criteria

Fixed by the brief and adopted without change: TypeScript everywhere · Postgres with `pgvector` ·
Supabase as managed Postgres only · Fastify · OpenRouter behind an interface · React + Tailwind +
shadcn/ui with the TanStack data-table pattern · monorepo · API-first · one-command local run · MIT.

The six decisions §3.2 delegated, resolved:

| §3.2 criterion                | Choice                                                                                                              | The reasoning in one line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dynamic attribute storage** | **Typed EAV**: an append-only `fact` log projected into one derived `attribute_value` table with typed slot columns | ADR-013. Judged by three lenses; each of JSONB/EAV/hybrid won exactly one, so speed did not decide it. EAV wins because creating an attribute is one `INSERT` and never runtime `CREATE INDEX` — which is what keeps "migrations are versioned and in the repo" literally true — and because the database can enforce that a number attribute cannot hold text, from every write path.                                                                                                                                                                        |
| **API style**                 | **REST + OpenAPI 3.1 generated from Zod 4**, via `fastify-type-provider-zod`                                        | ADR-028/029. 3.1 _is_ JSON Schema — the same dialect the LLM structured-output path and the future MCP tool definitions want, so one schema object per route feeds validation, serialisation, the OpenAPI document and the AI layer. `openapi.json` is committed and diffed in CI.                                                                                                                                                                                                                                                                            |
| **Frontend types**            | Shared Zod schemas in `packages/core`, **no OpenAPI client codegen**                                                | ADR-030. The frontend is in the same monorepo; generating types from a document generated from types was a three-package round trip. Removing it also removed the peer dependency that was pinning the repo a TypeScript major behind.                                                                                                                                                                                                                                                                                                                        |
| **ORM / query layer**         | **Kysely 0.29.5** on `pg` 8.23.0 — not Drizzle                                                                      | ADR-026. The brief named Drizzle as the leading candidate and asked for justification. The load-bearing query is built at runtime from user-defined attributes: one `EXISTS` sub-join per filter chip, a typed slot column chosen per attribute, and a `LEFT JOIN` for the sort. Kysely composes `Expression<SqlBool>` fragments as first-class values, which is exactly that shape; Drizzle's strength is a static schema, which this table does not have. `.compile()` is pure, so the compiler is tested with golden-SQL assertions that need no database. |
| **Migrations**                | Plain numbered `.sql` files under Kysely's `Migrator`, run explicitly, **never on boot**                            | ADR-031/032. The API asserts the schema is current at startup and refuses to serve if it is behind, which is a check, not a mutation.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Background jobs**           | A three-method `JobQueue` port with an inline adapter now; **pg-boss 12.29.0** from Stage 5                         | ADR-057. Stage 1 has nothing to enqueue. The port exists from day one so the nightly warmth sweep and later nudges have a home; `DROP SCHEMA pgboss CASCADE` is a complete uninstall if it disappoints.                                                                                                                                                                                                                                                                                                                                                       |
| **LLM usage**                 | One `llm/` module: provider port, hand-written transport, prompt versioning, `llm_call` trace table, cost ledger    | ADR-061…068. Cost is checked **before every HTTP POST**, not once per task; the transport carries one overall deadline rather than a per-attempt timeout. Model per task is a database row, so models change without a deploy.                                                                                                                                                                                                                                                                                                                                |
| **Testing**                   | **Vitest 4.1.11** in two projects (unit, no database / integration, real database) + **Playwright 1.62.1**          | ADR-073…079. Test isolation is a template database cloned per worker. Note: `testcontainers` is _not_ used even though Docker now exists — a per-worker template clone is faster and works identically in CI.                                                                                                                                                                                                                                                                                                                                                 |
| **Tooling**                   | pnpm 11.25.0 · TypeScript **6.0.3** · ESLint 10 flat config with type-aware rules · Prettier · GitHub Actions       | ADR-003/004/009. TypeScript 7.0.2 is `latest` but no published `typescript-eslint` can load it (its peer range is `>=4.8.4 <6.1.0`), and type-aware linting is worth more here than being on the newest major. The config is already written to TS 7's constraints so the eventual bump is an empty diff.                                                                                                                                                                                                                                                     |

Everything above was verified against the npm registry on 2026-09-03, and all seventeen pins were
re-checked independently before this plan was written. Postgres 16.15 with `pgvector` 0.8.6 and
`pg_trgm` 1.6 was verified running on this machine, including a single query combining a JSONB GIN
lookup, a trigram `ILIKE` and a vector distance.

## 2. Data model

Twenty tables. The shape, rather than the DDL — that is in `DECISIONS.md` §3 and `adr-archive/`.

```
workspace ── profile
    │
  record ─────────────┬── contact ── contact_metrics       (derived: last_interaction_at,
    │  (supertype:    ├── organization ── organization_metrics  interaction_count_12m,
    │   id, kind,     └── interaction ─┬─ interaction_contact    open_followups, warmth)
    │   provenance)                    └─ interaction_organization
    │
    ├── fact ──────────────► THE TRUTH. Append-only. Typed slot columns
    │                        (text/num/date/bool/option/target_record), valid_from,
    │                        observed_at, source, confidence, superseded_by_id.
    │
    ├── attribute_value ───► THE PROJECTION. Same typed columns, every row current
    │                        by construction. All WHERE, all ORDER BY, all reads.
    │                        Nine indexes, each led by attribute_id.
    │
    ├── record_link ───────► relations, carrying their own attributes
    │                        (title, from, to, is_primary) — §4.3
    ├── identifier ────────► every handle ever seen; the duplicate key — §4.6
    └── search_document ───► generated tsvector now; vector(1536) column later — §9

attribute_definition ── attribute_option      follow_up      saved_view
import_batch ── import_row                    llm_call ── llm_setting
```

Five decisions inside that diagram carry the most weight:

- **`record` is a supertype** and `interaction` is a subtype of it from day one (ADR-015). Postgres
  has no polymorphic foreign key; five tables point at "a contact or an organization". This buys real
  `ON DELETE CASCADE` on all five, and makes §4.1's "model interactions so custom attributes would be
  a small change" literally small — it becomes inserting rows, not writing a migration.
- **The link table carries the link's own attributes** rather than burying them in a fact's JSON, so
  editing a job title does not supersede the employment itself and the work history still reads as a
  CV (§6.5).
- **Text normalisation has exactly one implementation and it is SQL** (ADR-019). An earlier draft had
  a TypeScript fold _and_ Postgres `unaccent` pinned together by a contract test; that test provably
  cannot pass (`'İstanbul'.toLowerCase()` and Postgres `lower()` disagree; `unaccent` maps `ß→ss`).
  The house rule is now: TypeScript never produces a value compared against a normalised column.
- **`workspace_id` is nullable per §9 but always populated** (ADR-014), with `UNIQUE NULLS NOT
DISTINCT`. Every query is `= $ws` from day one. Going multi-tenant is `SET NOT NULL` plus one
  `CREATE INDEX CONCURRENTLY` pass and zero logic changes.
- **Hard delete, not soft delete** (ADR-016). A soft-deleted contact's email would sit in the
  identifier unique index and permanently block re-importing that person.

**Derived columns** (`last_interaction_at`, `interaction_count_12m`, `open_followups`, `warmth`) live
in metrics tables and are filterable and sortable exactly like any other column, which §5.2 requires.

## 3. API surface

`/api/v1`, OpenAPI 3.1 at `/api/docs`, ~48 named operations enumerated in one file that CI checks
against the actual routes — so "every operation the UI performs is a single, well-named API
operation" (§7) is asserted rather than promised.

Resources: `contacts` · `organizations` · `interactions` · `follow-ups` · `attribute-definitions` ·
`views` · `import-batches` · `search` · `ask` · `quick-capture` · `stats` · `profile`.

The **filter model is one thing in four places** — the table UI, the URL, the API query string and
later the LLM's structured output all use the same discriminated union, with one codec in
`packages/core`. That is what makes a filtered view shareable as a link and what lets "Ask the
network" show you _which filter it ran_ (§4.8). Wire shape: bare object for one resource;
`{data, page: {cursor, hasMore}, meta: {total}}` for lists with an exact nullable total;
RFC 9457 `problem+json` with a per-field `errors` array. Bulk writes return 200 with per-item
results and accept either a list of ids or a filter. Auth is a registered middleware slot that
currently does nothing.

## 4. Folder structure

Five workspace packages with a one-way dependency graph:

```
apps/web ──HTTP──▶ apps/api ──▶ packages/db ──▶ packages/core
    │                                              ▲
    └────────── types + filter model ──────────────┘
```

`packages/core` depends on `zod` and `libphonenumber-js` and nothing else — no `node:*`, no `pg`, no
`kysely`, no `fastify` — because it ships to the browser. An ESLint rule enforces that against the
whole builtin module set, not just `node:`-prefixed specifiers. The full tree is in `DECISIONS.md`
§12.

## 5. Stages, refined

Estimates are in half-day units of focused work and are for **sequencing**, not calendar planning.
Each stage ends with green CI, updated docs, a PR and a two-layer report, then stops for approval.

| Stage                                  | Scope                                                                                                                                                                                                                         | Est. | Definition of done                                                                                                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — Foundation**                     | Monorepo, tooling, CI, `docker-compose`, six migrations, the twelve attribute types as a data-driven registry, the fact log + projector, identifiers, warmth, the filter→SQL compiler, API skeleton with OpenAPI, seed script | 6    | `pnpm verify` green; `/api/docs` renders; seed produces ~200 contacts / 60 organizations / 500 interactions / 40 follow-ups; the projection-equivalence gate passes; **`EXPLAIN (ANALYZE, BUFFERS)` recorded for all nine operator shapes at 10k×60** |
| **2 — Contacts + attributes** ✅       | App shell, the one `DataTable`, contacts list with filter/sort/columns/inline edit, add-contact dialog, Settings → Profile and Contact attributes (create/edit/delete, all 12 types)                                          | 6    | **Done.** Create an attribute in Settings → it appears in the Columns picker → filter and sort by it, asserted by Playwright. Seven e2e specs green, two `fixme` awaiting Stages 3–5, third CI job runs `verify:e2e`.                                 |
| **3 — Organizations + detail page** ✅ | Organizations table and detail, contact↔organization links with metadata, the contact detail page (Overview / Activities / Connections / Follow-ups) and the attribute sidebar with fact history, interactions CRUD           | 6    | **Done.** Work history renders current → past. The value-history popover shows source and date. Summary card is a stub until Stage 6. Logging an interaction moves warmth and the counts (ADR-092).                                                   |
| **4 — Follow-ups + dashboard**         | Follow-ups table, recurrence, snooze, dashboard stat cards and attention list, saved views end to end                                                                                                                         | 4    | A quarterly follow-up marked done creates the next occurrence. A saved view round-trips through the URL.                                                                                                                                              |
| **5 — Import + duplicates + merge**    | The five-step wizard, the four source presets, value mapping, the editable review grid, duplicate detection, merge UI, import batches and provenance markers                                                                  | 8    | The LinkedIn fixture imports twice and creates zero duplicates. Wall-clock for 10k rows recorded.                                                                                                                                                     |
| **6 — LLM layer**                      | Provider abstraction, Ask the network with "how I searched", quick capture with an editable preview, contact summaries, ⌘K command palette                                                                                    | 6    | Every call traced in `llm_call` with its cost; the daily cap is enforced before the request, not after.                                                                                                                                               |
| **7 — Polish and release**             | Empty states, keyboard shortcuts, error handling, the 10k-row performance pass, README with screenshots, `CLAUDE.md` final, tag `v0.1.0`                                                                                      | 4    | §12's end-to-end walkthrough passes on a clean clone.                                                                                                                                                                                                 |

## 6. Test coverage

Unit (no database): the attribute-type registry, slug generation and the reserved list, the filter
model, warmth, identifier normalisation, duplicate matching, recurrence, import mapping and presets.
Golden-SQL assertions cover the compiler for all nine operator shapes without a database, because
Kysely's `.compile()` is pure. Integration (real database, template clone per worker): every
resource's happy path and validation errors, and dynamic filter/sort on custom attributes. E2E
(Playwright): the four flows §8.1 names. `pnpm verify` is the one command; CI jobs call it and
nothing else.

Six mechanical guards exist because prose rules get broken: the ESLint package boundaries, a grep
test pinning physical column names to one file, the route↔operation-list parity assertion, an
`information_schema` drift test against the hand-maintained Kysely interface, the projection
equivalence gate, and `AttributeType` being _derived_ so a missing case is a compile error.

## 7. Risks

Ranked, each with what would falsify it. Full text in `DECISIONS.md` §13.

1. **Every performance number here is an extrapolation** — the storage design was written with no
   Postgres available. This is the largest unknown. _Falsifier:_ Stage 1's 10k×60 generator plus
   `EXPLAIN (ANALYZE, BUFFERS)`, which is now genuinely possible because Docker is installed. The
   escape hatch (two-phase index-ordered pagination) is a **query** change, not a schema change.
2. **The projection can silently diverge from the fact log.** _Falsifier:_ the per-record digest gate,
   run as the last integration test.
3. **A 10k-row import is the peak write event and the least-tested path.** _Falsifier:_ the Stage 5
   double-import acceptance test.
4. **TanStack Table v9 is one month old.** Pinned because shadcn's mandated pattern is written against
   it. _Fallback:_ v8 plus a hand-ported data-table, about a day, no architecture change.
5. **Attribute values are not typed end-to-end and cannot be** — runtime typing comes from Zod
   schemas built from the definitions. Structural to any dynamic-attribute design; named rather than
   implied away.
6. **`kysely-codegen` may not run against this schema at all.** No architectural impact — the
   interface is hand-maintained by design — but it weakens the argument for Kysely from "drift is
   impossible" to "drift fails a test", and that is stated as such.

## 8. Open questions

Four remain; none blocks Stage 1. Each has a recommendation.

- **Q3 — "No interaction in 90 days":** does that seeded view include people you have _never_
  contacted? _Recommendation:_ exclude them, and seed a second view `Never contacted`. Otherwise a
  fresh 10k-row LinkedIn import fills the view on day one.
- **Q4 — Import review grid:** what is pre-selected for a near-certain duplicate? _Recommendation:_
  `Skip`, so re-importing the same export is a no-op and nothing is overwritten by a bulk click.
- **Q5 — Dark mode in Phase 1:** the brief never mentions it. _Recommendation:_ ship the colour
  tokens now, add the toggle in Stage 7.
- **Q6 — Overnight jobs on a laptop:** the nightly warmth sweep is scheduled for 03:30 and the app
  will usually be closed. _Recommendation:_ on startup, if the sweep is more than 20 hours stale, run
  it once in the background.

And one acknowledgement rather than a question: **the Profile in §6.6 gains two fields**, a phone
region (default `DE`) and a time zone (default `Europe/Berlin`). Both are load-bearing — `089 1234567`
cannot be normalised to E.164 without a region, and warmth cannot decay on whole civil days without a
time zone, or its output silently depends on the server's environment. `BRIEF.md` is updated in the
same PR, per §2.1.
