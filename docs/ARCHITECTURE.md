# Mutuals — Architecture

How the system is put together, what the dynamic-attribute layer actually does, what it measured at
ten thousand contacts, and where each of the brief's §9 features plugs in.

`docs/BRIEF.md` is the source of truth for product decisions and `docs/DECISIONS.md` is the binding
technical specification (117 ADRs). This document explains and measures; where it disagrees with an
ADR, the ADR wins and this document is wrong.

---

## 1. Packages

```
apps/web ──HTTP──▶ apps/api ──▶ packages/db ──▶ packages/core
    │                                              ▲
    └────────── types + filter model ──────────────┘
```

The graph runs one way and ESLint enforces it, including a rule that bans every Node builtin, `pg`,
`kysely` and `fastify` from `packages/core` — because `packages/core` ships to the browser and a
sentence in a markdown table gets broken about half the time.

| Package         | What lives there                                                                                                                                                  | May depend on                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `packages/core` | The domain: the attribute type registry, the filter **model**, warmth, identity normalisation and duplicate matching, recurrence, the API contract schemas        | `zod`, `libphonenumber-js/min`  |
| `packages/db`   | Schema, migrations, the filter **compiler**, sorting, the list query, the write path, repositories, the projector's callers, the seed and the performance harness | `@mutuals/core`, `kysely`, `pg` |
| `apps/api`      | Fastify. The only way into the data. An MCP server or a CLI is another client of this, not another door                                                           | `@mutuals/core`, `@mutuals/db`  |
| `apps/web`      | React SPA. Talks to the API and never to the database                                                                                                             | `@mutuals/core`                 |

Two boundaries are worth stating out loud because they are easy to erode:

- **The filter model is in `core`, the compiler is in `db`** (ADR-033). The browser needs to build,
  serialise and validate a filter; only the server needs to turn one into SQL. Putting the compiler
  in `core` would drag Kysely into the bundle.
- **Text normalisation exists once, in SQL** (ADR-019). `mutuals_norm(text)` is
  `lower(unaccent(btrim($1)))` and TypeScript never produces a value that is compared against a
  normalised column. The casefold in `packages/core/src/text/` is display-only and nothing asserts
  the two agree, deliberately: making them agree would mean hand-porting `unaccent.rules`
  (~1500 entries) plus locale case-folding into TypeScript and keeping it in sync for ever.

---

## 2. The data model in one page

`fact` is an append-only log: every value ever observed, with `valid_from`, `observed_at`, `source`
and `confidence`. It is the truth.

`attribute_value` is its projection. **Every row in it is current by construction**, so no query has
a liveness predicate to forget — which is the failure mode that ruled out both a `current_values`
JSONB blob (a wrong-typed value makes a record silently vanish from a filter) and indexing the fact
table directly (one forgotten `WHERE superseded_by_id IS NULL` renders a stale value as current).

`record` is a supertype, so `contact`, `organization` and `interaction` share one id space and the
five polymorphic tables — `fact`, `attribute_value`, `identifier`, `record_link`, `search_document`
— get a real `ON DELETE CASCADE`. Relations live in `record_link` rather than in `attribute_value`,
because a link carries its own attributes (job title, from, to, primary). Derived columns live in
`contact_metrics` and `organization_metrics`. Full-text and the future `vector(1536)` live in
`search_document`.

```
                    ┌───────────────────┐
                    │ attribute_        │   the user's schema; created at runtime,
                    │   definition      │   one INSERT, never any DDL
                    └─────────┬─────────┘
                              │  (id, value_kind, is_multi) ── composite FK
                              ▼
   write path ──▶  ┌────────────────────┐  project_record()  ┌──────────────────────┐
                   │       fact         │ ─────────────────▶ │  attribute_value     │ ──▶ every
                   │  (append-only)     │                    │  record_link         │     WHERE,
                   └────────────────────┘  ◀───────────────  │  identifier          │     ORDER BY
                              ▲             db:reproject      │  search_document     │     and read
                              │                              └──────────────────────┘
                    every value ever observed
```

### A write

`setValue` / `addElement` / `setValues` in `packages/db/src/write/facts.ts`, in this order, inside
one transaction:

1. `SELECT … FOR UPDATE` on the `record` row. One lock, held for microseconds; it is what makes two
   concurrent edits of the same record unable to interleave and lose one.
2. Supersede the live fact occupying this value's slot (`UPDATE fact SET superseded_by_id = <new>`).
3. Insert the new fact. Its id was generated in TypeScript **before** step 2, because
   `fact_live_uq` is a partial unique index and therefore cannot be deferred — doing both in one
   statement makes the index see two live rows and the _second_ edit of any field fails.
4. `SELECT project_record(record, attribute)` — the SQL projector, scoped narrowly.
5. `writeIdentifiers(record)` — the canonical LinkedIn/website forms the projector cannot produce
   (see §7, finding F2).

A removal is a **tombstone**, never a delete or an in-place update: a new fact copying the slot
columns of the one it retires, with `removed_at` set. It stays live, so it occupies the
`fact_live_uq` slot, which is what makes a later re-add a clean supersession chain rather than a
duplicate key — and the history reads truthfully: added → removed → added again.

An `AFTER STATEMENT` trigger on `fact` calls the same projector, so the invariant survives a psql
session, a hand-run migration and a future MCP server writing SQL directly. It is idempotent, so the
second run of a pair is a no-op upsert. `SET LOCAL mutuals.defer_projection = 'on'` switches it off
for a bulk load that will project explicitly afterwards (the importer and `pnpm db:check` do this).

### A read

The list endpoint runs two queries (`packages/db/src/filter/list.ts`):

- **Q1** selects `(id, sort_key)` and nothing else — roughly 40-byte tuples — so the sort cannot
  spill `work_mem` however wide the visible columns are. The ≤50 surviving ids are then hydrated by
  a second query over `av_record_attr_uq`.
- **Q3** is a separate `count(*)` over the same predicate, never `count(*) OVER ()`: a window
  function with no partition must buffer its whole input before emitting the first row, so
  `LIMIT 50` would short-circuit nothing.

Joins are emitted only when something references them. Fewer base relations means the planner keeps
reordering exhaustively for more filter chips before `join_collapse_limit` hands over to the genetic
optimiser — which is also why every pooled connection is opened with `join_collapse_limit=16`,
`from_collapse_limit=16` and `geqo_threshold=20` in the libpq `options` startup parameter rather
than in a `pool.on('connect')` handler, so there is no window in which a checked-out connection is
still running on the defaults.

---

## 3. The dynamic attribute system

This is the part the whole product rests on, so it gets its own section.

### Why typed EAV and not JSONB

Four options were on the table (ADR-013): a `current_values jsonb` column with a GIN index; typed
EAV; both; or indexing the `fact` table directly with partial indexes.

The decision was **typed EAV**, and the reason is not performance — it is that JSONB has no types.
A number written as `"600000.50"` and a number written as `600000.50` are different JSONB values
that sort differently and compare differently, and every "the record vanished from my filter" bug in
a JSONB attribute system traces back to one of them. In the typed model the database refuses the
write: `fact` carries six slot columns (`text_value`, `num_value`, `date_value`, `bool_value`,
`option_id`, `target_record_id`), a `CHECK` that exactly one is populated for the row's `value_kind`,
and a **composite foreign key** `(attribute_id, value_kind, is_multi) → attribute_definition` that
makes "a number attribute acquires a text value" and "an attribute's type changes while values
exist" both impossible rather than merely discouraged.

The costs were named up front and they are real: about 15× row amplification, 3–4× write
amplification, the planner is blind to per-attribute statistics, and `ORDER BY` on a custom
attribute is a sort of the filtered set rather than an index-ordered scan. §5 measures all four.

### Nine indexes, none of which grows with the number of attributes

Every index on `attribute_value` is **led by `attribute_id`**, so each attribute owns a contiguous
key range inside one shared index. That is what makes "create attribute number 300" one `INSERT`
rather than one `CREATE INDEX`, and it is the single most important structural property of the
design: **there is no runtime DDL anywhere in Mutuals**, so §3.2's "migrations versioned in the
repo" is literally true instead of "plus whatever the user clicked".

| #   | Index               | Key                                     | Serves                                                |
| --- | ------------------- | --------------------------------------- | ----------------------------------------------------- |
| 1   | `av_record_attr_uq` | `(record_id, attribute_id, value_key)`  | hydration, value identity, import idempotency         |
| 2   | `av_attr_text_idx`  | `(attribute_id, text_sort, record_id)`  | `equals` on text                                      |
| 3   | `av_attr_num_idx`   | `(attribute_id, num_value, record_id)`  | `= ≠ < > between` and the numeric `ORDER BY`          |
| 4   | `av_attr_date_idx`  | `(attribute_id, date_value, record_id)` | `before / after / between` and the chronological sort |
| 5   | `av_attr_bool_idx`  | `(attribute_id, bool_value, record_id)` | `is yes` / `is no`                                    |
| 6   | `av_attr_opt_idx`   | `(attribute_id, option_id, record_id)`  | select operators                                      |
| 7   | `av_attr_key_idx`   | `(attribute_id, value_key, record_id)`  | `tags contains any of`; the single-valued sort join   |
| 8   | `av_attr_rec_idx`   | `(attribute_id, record_id)`             | `is empty` as an indexed anti-join; "used in N"       |
| 9   | `av_trgm_idx`       | GIN `(attribute_id, text_norm)`         | `contains`, scoped **per attribute**                  |

Index 9 needs `btree_gin`'s uuid opclass for the leading `attribute_id`. Without it,
`city contains 'munich'` would probe every text value in the database, notes included, and recheck.

### `value_key`, the one column five things read

`value_key` is the identity of one value inside one attribute on one record. It is `''` for **every**
single-valued attribute, `left(mutuals_norm(text_value), 512)` for a `tags` element, and the
option's stable `key` for a `multi_select` element (ADR-018). Because `''` is shared by every
single-valued attribute, one unique index expresses "at most one value" for single-valued and "at
most one row per element" for multi-valued, with no second code path — and `CHECK (is_multi OR
value_key = '')` on both `fact` and `attribute_value` turns a mistake into a loud write error.

It is computed **as a SQL expression**, never as a TypeScript string, because the `tags` variant is
`mutuals_norm`-folded and the house rule is absolute.

### Three operator semantics the brief does not specify

Notion and Airtable disagree with each other on all three, so there is no de-facto standard to defer
to (ADR-017). All three are golden-SQL unit tests and all three are shown verbatim in the filter
chip's tooltip:

- **`is empty` means "no live value row exists"**, for all twelve types, compiled as one
  `NOT EXISTS`. `CHECK (text_value <> '')` on both tables makes "empty string" and "no value"
  incapable of diverging at any write site.
- **`number ≠ x` means "has a value, and it differs"** — records with no value are excluded, because
  `is empty` is a separate operator and the other convention silently returns every empty record,
  which reads as a bug.
- **`single_select is not one of` is `NOT (is one of)`** and therefore _does_ include records with no
  value, matching how a person reads "is not an Investor".

---

## 4. Measured performance at 10,000 contacts × 60 attributes

`docs/DECISIONS.md` §13 R1 said it plainly:

> **Every performance number in this design is an extrapolation.** No Postgres existed in the
> environment where the storage decision was written. _Falsifier:_ Stage 1's 10,000-contact ×
> 60-attribute generator plus `EXPLAIN (ANALYZE, BUFFERS)` for each of the nine operator shapes.

That promise is kept by `pnpm db:check`. It generates the dataset, runs the **real compiled list
query** — `compileList`, the same function the API calls, not SQL written by hand for the occasion —
through `EXPLAIN (ANALYZE, BUFFERS)`, and reports what happened. Everything below is a measurement.

**Run conditions.** Re-measured 2026-09-05 at the end of Stage 6, against a schema three migrations
newer than the Stage-1 run these numbers replace. Apple M3, 16 GB, macOS 26.5.2. PostgreSQL 16.15
(aarch64, Debian) in Docker,
`shared_buffers=160MB`, `work_mem=4MB`, `effective_cache_size=5GB`, `random_page_cost=4`,
`join_collapse_limit=16`, `max_parallel_workers_per_gather=2`. Warm cache: every shape ran three
times and the table reports the median; the `Buffers` column shows that no shape did any physical
read. Dataset: 10,760 records (10,000 generated contacts with 60 attributes each, on top of the demo
seed), 543,854 generated facts, 538,231 `attribute_value` rows — `attribute_value` 381 MB,
`fact` 252 MB.

<!-- generated by `pnpm db:check` on 2026-09-05; 10000 contacts, 543854 facts -->

| Operator shape                            | Designed index      | Index actually used                       | Rows |      Median | Buffers |
| ----------------------------------------- | ------------------- | ----------------------------------------- | ---: | ----------: | ------: |
| hydrate one page of 50 records            | `av_record_attr_uq` | `av_record_attr_uq`                       | 2666 |     1.84 ms |     958 |
| `short_text equals`                       | `av_attr_text_idx`  | `av_attr_text_idx`                        |   50 |     2.20 ms |  16,724 |
| `number between`                          | `av_attr_num_idx`   | `av_attr_num_idx`                         |   50 |     1.10 ms |  12,156 |
| `date after`                              | `av_attr_date_idx`  | `av_attr_date_idx`                        |   50 |     2.78 ms |  14,073 |
| `yes_no is yes`                           | `av_attr_bool_idx`  | `av_attr_bool_idx`                        |   50 |    10.68 ms |  81,626 |
| `single_select is one of`                 | `av_attr_opt_idx`   | `av_attr_opt_idx`                         |   50 |     5.61 ms |  56,438 |
| `tags contains any of`                    | `av_attr_key_idx`   | `av_record_attr_uq` &sup1;                |   50 |     1.84 ms |  10,618 |
| `short_text is empty`                     | `av_attr_rec_idx`   | `av_attr_rec_idx`                         |   50 |     0.14 ms |   1,043 |
| `short_text contains` (trigram)           | `av_trgm_idx`       | `av_trgm_idx`                             |   50 |     5.36 ms |  14,168 |
| `multi_select contains all of`            | `av_attr_opt_idx`   | `av_attr_rec_idx` &sup2;                  |   50 |    10.09 ms |  22,821 |
| `relation has any of`                     | `rl_reverse_idx`    | `rl_reverse_idx`                          |   50 |     2.15 ms |   6,739 |
| `ORDER BY` custom text, **asc**           | `av_attr_text_idx`  | `av_attr_key_idx` &sup3;                  |   50 |    20.73 ms |  52,680 |
| `ORDER BY` custom text, **desc**          | `av_attr_text_idx`  | `av_attr_key_idx` &sup3;                  |   50 |    17.56 ms |  52,680 |
| `ORDER BY warmth desc`                    | `cm_warm_idx`       | none — hash join + top-N heapsort &#8308; |   50 |     8.13 ms |   2,665 |
| **three chips + sort** (the real one)     | several             | `av_attr_text_idx` leads, two semi-joins  |   15 |     3.90 ms |  49,580 |
| row count over the same three chips       | several             | same                                      |    1 |     3.08 ms |  27,920 |
| quick search box (`q=`, two text columns) | `av_trgm_idx`       | `av_trgm_idx`                             |   50 |     6.18 ms |   9,070 |
| **delete one contact**                    | `record_pkey`       | `record_pkey` — **F1 fixed**              |    0 | **2.07 ms** |       8 |

### What the numbers say

**The design holds on the read path.** The query that matters most — three filter chips plus a sort
on a custom number attribute, which is exactly §6.2's "Investors in Munich interested in climate
tech" shape — is **3.9 ms at ten thousand contacts**, and the plan is the one the design predicted:
the most selective chip (`equals` → 526 rows) leads through `av_attr_text_idx` and the other two
become nested-loop semi-joins. R1's "single-digit milliseconds for a three-chip filtered page" is
confirmed rather than extrapolated.

**No sort spilled.** Every ordering produced `top-N heapsort` or `quicksort` in **Memory**, at
25–31 kB, with `work_mem` at its 4 MB default. That is the direct consequence of Q1 selecting only
`(id, sort_key)`. Both directions emit `NULLS LAST`: descending prints it
(`sv.text_sort COLLATE "C" DESC NULLS LAST, r.id DESC`) and ascending relies on Postgres's own
default, which is why `pnpm db:check` asserts the two directions differently rather than
string-matching one clause.

**Sorting by a custom attribute is the slowest read, at ~20 ms, and it is honest about why.** An
unfiltered `ORDER BY` on a custom text attribute reads all 10,200 contact records and all 10,000
values for that attribute (a bitmap heap scan over 9,951 heap blocks) before the top-N heapsort
takes 50. This
is exactly what ADR-013 said would happen — "a sort of the filtered set rather than an index-ordered
scan (fine to ~100k matching rows)" — and it scales with the size of the _filtered set_, not the
table: the same sort under the three-chip filter costs 3.9 ms. The escape hatch, if a sorted
unfiltered 100k-row table ever matters, is the two-phase index-ordered pagination in
`storage-DECISION.md` §9.4, which is a **query** change and not a schema change. That is the whole
reason the typed table exists.

**`LIMIT 50` short-circuits for selective filters and does not for unselective ones.** `tags
contains any of` walks `record_list_idx` in `created_at DESC` order and probes `av_record_attr_uq`
per record, stopping after a few hundred — the limit genuinely short-circuits, which is why it costs
1.8 ms. `yes_no is yes` cannot: it matches 4,950 of 10,000 records, so the planner materialises the
whole match set, does 4,950 `record_pkey` lookups to fetch `created_at`, and top-N sorts. 10.7 ms at
10k, and it grows with
the match count. A boolean filter that matches half the table is not really a filter, so this is
acceptable — but it is the shape that would degrade first at 100k contacts.

**Three plans differ from what the design expected, and in every case the planner is right.**

1. ¹ **`tags contains any of` uses `av_record_attr_uq`, not `av_attr_key_idx`.** When the query
   drives from `record`, the predicate has `record_id`, `attribute_id` _and_ `value_key` bound, and
   `(record_id, attribute_id, value_key)` is a three-column exact match while
   `(attribute_id, value_key, record_id)` is a two-column match plus a filter. `av_attr_key_idx`
   still earns its place — it is what the sort join uses (note ³) — but it is not what this operator
   uses. **ADR-078's wording should be corrected**: the nine assertions are "each operator uses _an_
   index designed for it", not "operator N uses index N".
2. ² **`multi_select contains all of` uses `av_attr_rec_idx`.** `contains_all_of` compiles to a
   correlated `count(distinct option_id)` rather than an `EXISTS`, so the leading columns available
   are `(attribute_id, record_id)` and the option filter is a recheck. It is the slowest filter at
   10.1 ms because it is evaluated per candidate record until 50 match. Correct, and worth
   remembering if `contains_all_of` ever appears in a default view.
3. ³ **The custom-attribute sort join uses `av_attr_key_idx`.** The join predicate is
   `attribute_id = $1 AND value_key = ''`, which is precisely that index's two leading columns;
   `av_attr_text_idx` leads with `(attribute_id, text_sort)` and cannot filter on `value_key`.
   Documented here because ADR-013 lists "alphabetical `ORDER BY`" against `av_attr_text_idx`, and
   that is not what happens — `av_attr_text_idx` serves `equals`.
4. ⁴ **`ORDER BY warmth` uses no index at all.** The query drives from `record` and left-joins
   `contact_metrics`, so `cm_warm_idx` cannot lead; the planner hash-joins 10,200 rows and top-N
   sorts, in 8.1 ms and 2,665 buffers. Cheap, and the right plan, but it is linear in the number of
   contacts and would be ~80 ms at 100k.

**One caveat on all of these.** They are medians of three warm runs on one laptop, and the same
shapes re-measured at the end of Stage 6 came out **1.3× to 2× slower** than the Stage-1 run they
replace — not because anything regressed, but because a laptop is not a benchmark rig. Read them as
orders of magnitude and as _plan shapes_, which is what `pnpm db:check` actually asserts (ADR-078:
plan shape, never latency). The one number that moved for a real reason is the delete.

### The write path at 10,000 rows — R5, measured

Every number above is a **read**. §13's R5 named the peak _write_ event — a 10,000-row import — as
"the least-tested path", predicted it at around 60 s, and asked for "a recorded wall-clock in
`ARCHITECTURE.md`". Here it is, from
`MUTUALS_IMPORT_PERF=1 pnpm test:integration` on 2026-09-05:

| Phase                                      |       Wall-clock |
| ------------------------------------------ | ---------------: |
| upload, parse, auto-map, stage 10,000 rows |        **122 s** |
| duplicate detection over the staged batch  | _included above_ |
| commit — 10,000 contacts, 30,000 facts     |        **176 s** |
| **end to end**                             |      **≈ 5 min** |

**It is correct and it is slow.** All 10,000 rows land, the batch reports `completed`, and every
contact carries the facts the file described — the correctness half of R5, which Stage 5 proved over
31 rows, holds at 10,000. But five minutes is roughly **five times** what R5 predicted, and R5's own
remedy — dropping and rebuilding `av_trgm_idx` around the batch — is therefore indicated.

**It has not been attempted, deliberately.** Nobody has profiled where the five minutes actually go.
The split above says staging and committing cost roughly the same, which does not look like one GIN
index: staging is dominated by the duplicate probe (10,000 trigram candidate queries against a table
that is growing under them), and committing writes 30,000 facts through the projector in chunks.
Rebuilding one index on that reasoning would be a guess with downtime attached. The measurement is
the deliverable; the optimisation is Stage 8's, with a profile in front of it.

**What this means for a user today.** §6.8's wizard shows a progress bar and commits in resumable
chunks (ADR-061), so a five-minute import is visible and survives a restart rather than appearing to
hang. A LinkedIn export of a few hundred connections — which is what most people have — is seconds.

**One thing the first measurement got wrong, worth repeating.** The generator originally wrote
`Perf00001 Tester00001`, `Perf00002 Tester00002` … and **half the export was flagged as a duplicate
of itself.** Correctly: consecutive numbered names are near-identical to a trigram, ADR-099 put the
fuzzy threshold at 0.65, and 500 shared companies supplied the organisation that rule also needs. The
matcher was right and the fixture was wrong — but a measurement of the _skip_ path would have been
reported as a measurement of the write path, and it would have looked good.

### The two invariants, at size

- **Reprojection is byte-identical.** `pnpm db:reproject --verify` deletes `attribute_value`,
  `record_link` and `search_document`, rebuilds all three from the `fact` log alone by calling the
  same `project_record` the write path calls, and compares a per-record digest before and after.
  At 10,760 records and 546,482 facts it took **27.7 s** and **every digest matched**. That is the
  entire safety argument for keeping a derived copy, and it is now a measurement.
- **No row anywhere has a NULL `workspace_id`.** Checked by scanning `information_schema` for every
  base table carrying the column and counting NULLs in each (ADR-014). Clean.

### Reproducing this

```bash
pnpm db:up && pnpm db:migrate && pnpm seed      # db:check needs the organizations
pnpm db:check                                    # ~2 minutes, cleans up after itself
pnpm db:check -- --contacts=2000 --keep --out=perf.md
```

`--out` also writes `<out>.plans.txt` with the full verbose text plan for every shape. The harness
removes its own data unless `--keep` is passed, and `pnpm db:check -- --drop` cleans up afterwards.

---

## 5. Findings

Two things the measurement found that the design did not anticipate. Neither is fixed here — both
are schema changes, and this branch owns the seed and the harness, not the migrations.

### F1 — Deleting one contact took four seconds at 10k contacts. Four foreign keys had no index.

**Severity was high — it blocked §5.4 and §6.8. Fixed in migration 0007; re-measured 2026-09-05 at
2.07 ms, from 4.0 s.** The finding is kept in full because the _shape_ of it recurs: Postgres does
not index a referencing column for you, so every `ON DELETE` clause added from here on needs the
same check.

Postgres does not index a referencing column automatically, and every `ON DELETE CASCADE` and
`ON DELETE SET NULL` has to _find_ the referencing rows before it can act. Four of ours have nothing
to find them with:

| Constraint                     | Referencing column        | Nearest index                              | Usable? |
| ------------------------------ | ------------------------- | ------------------------------------------ | ------- |
| `fact_superseded_by_id_fkey`   | `fact.superseded_by_id`   | `fact_live_uq` — partial `WHERE … IS NULL` | no      |
| `attribute_value_fact_id_fkey` | `attribute_value.fact_id` | none leads with `fact_id`                  | no      |
| `record_link_fact_id_fkey`     | `record_link.fact_id`     | none leads with `fact_id`                  | no      |
| `fact_target_record_id_fkey`   | `fact.target_record_id`   | none leads with `target_record_id`         | no      |

Measured, from `EXPLAIN (ANALYZE)` on `DELETE FROM record WHERE id = $1` inside a rolled-back
transaction:

| Dataset         | `fact` rows | Delete one contact | Dominated by                                                                   |
| --------------- | ----------: | -----------------: | ------------------------------------------------------------------------------ |
| 1,500 contacts  |      81,706 |             887 ms | `fact_superseded_by_id_fkey` 479 ms, `attribute_value_fact_id_fkey` 370 ms     |
| 10,000 contacts |     546,482 |          **5.4 s** | `fact_superseded_by_id_fkey` 2,691 ms, `attribute_value_fact_id_fkey` 2,476 ms |

The plan itself is 0.03 ms of planning and 8 buffers. All of the time is in referential-integrity
triggers, and it is linear in the size of `fact` _per deleted fact_ — so deleting a contact with 60
attributes is 60 whole-table scans of `fact` and of `attribute_value`. Bulk deletion is quadratic:
removing the harness's own 10,000 records took **380 seconds** before the indexes existed and about
**8 seconds** with them.

The fix is one migration and four lines:

```sql
CREATE INDEX fact_superseded_idx ON fact (superseded_by_id) WHERE superseded_by_id IS NOT NULL;
CREATE INDEX fact_target_idx     ON fact (target_record_id) WHERE target_record_id IS NOT NULL;
CREATE INDEX av_fact_idx         ON attribute_value (fact_id);
CREATE INDEX rl_fact_idx         ON record_link (fact_id);
```

**Migration 0007 ships exactly these four**, plus `fact_attribute_idx`, each with a `COMMENT ON
INDEX` saying which foreign key it backs — so the next person to read `\d+ fact` is told why they
exist rather than left to guess. `MISSING_FK_INDEXES` in `packages/db/src/seed/perf.ts` is now the
**empty array**, which is the honest end state of the signpost it used to be: the harness no longer
has to create anything temporarily, because the schema it measures is the schema the migrations
describe.

**F1 has a second half that only shows up on the second command you run.** Deleting 650,000 rows
leaves 650,000 dead tuples, and Postgres does not return the space by itself: measured,
`attribute_value` sat at **850 MB holding 2,400 live rows** after one `db:check`. Because the F1
triggers _sequentially scan_ those tables, the next perfectly ordinary `pnpm seed` — which resets by
deleting a few hundred records — went from **7 s to 75 s**. So `dropPerfDataset` now finishes with a
`VACUUM (FULL, ANALYZE)` on the four tables it filled, which brings the whole schema back to 25 MB
and the seed back to 7 s. It is stated here rather than hidden because the same amplification will
hit any real user who imports and deletes a large LinkedIn export, and the fix for _that_ is the four
indexes above, not a vacuum.

One environmental note from the same measurement: the compose container's default 64 MB `/dev/shm`
is too small for a _parallel_ vacuum's shared-memory segment (`could not resize shared memory
segment … No space left on device`). The harness passes `PARALLEL 0`. If a future migration builds a
large index in parallel it will hit the same wall, and the fix is `shm_size: 1gb` on the `db`
service in `docker-compose.yml`.

One smaller observation from the same plan: deleting a record cascades to its facts, which fires the
`AFTER DELETE STATEMENT` trigger `fact_project_del`, which calls `project_record` for a record that
is in the middle of being deleted. It costs ~1 ms and is harmless, but it is pure waste and an
`IF EXISTS (SELECT 1 FROM record WHERE id = r)` guard in `fact_project_trg` would remove it.

### F2 — The SQL projector and the TypeScript identifier write-through disagree about what may become an identifier.

**Severity: medium. It needs an ADR, not a patch.** (Found by the integration-test pass; recorded
here because it is architecture, not a bug in one file.)

`project_record` step 3 writes `attribute_value.text_norm` into `identifier` for **every**
email/phone/linkedin/website value, valid or not. So writing `n/a` into the email field creates the
identifier row `(kind: 'email', value: 'n/a')`. `writeIdentifiers` — the TypeScript path that runs
beside it — declines, because `n/a` has no canonical form.

The consequence is not cosmetic: two contacts whose email field says `n/a` become identifier twins,
and ADR-042 scores a shared email at 0.97, which is the `certain` band that the import wizard offers
a bulk Skip/Merge for. Migration 0002's own comment describing `identifier.value` as "normalised:
lower(email), E.164 phone, canonical LinkedIn slug" is currently not true.

It is left alone deliberately because the honest options are both architectural. (a) Drop step 3 and
let `writeIdentifiers` own the table — clean, but a raw psql / MCP / `COPY` write then produces no
identifiers at all. (b) Keep both and accept the noise, adding a validity gate to the duplicate
probe instead. ADR-019 forbids a second normaliser, so the projector cannot be taught what a valid
email is. The current behaviour is asserted by a test and named in a comment in
`write/facts.db.test.ts`.

---

## 6. The LLM layer

Built. Three prompts — `ask.filter`, `quick-capture.extract`, `contact.summary` — over one module,
one transport, one trace and one cost cap. `search` is beside them and is deliberately _not_ an LLM
route: §4.8's global search is a substring search Postgres already indexes three ways, and a palette
that cost a model call per keystroke would be both slow and expensive.

**It is one module, `apps/api/src/llm/`, and almost nothing may import it.** ESLint enforces it
(ADR-071): `packages/core` and `packages/db` never, and among the routes only three, listed by exact
path — `ask.ts`, `quick-capture.ts` and `summary.ts`. So duplicate matching, filter compilation and
warmth **cannot** reach a model, and their decisions are unit-testable with no network and no
fixtures. `boundary.test.ts` runs the real ESLint over both directions, because a
`no-restricted-imports` zone is exactly the kind of configuration that survives a refactor in form
and not in effect.

```
   routes/ask.ts ───────┐
   routes/quick-capture ─┼─▶ llm/tasks/* ──▶ llm/client.ts ──▶ ChatProvider ──▶ transport ──▶ OpenRouter
   routes/summary.ts ───┘        │                │                  ▲               │
                                 │                │                  └ EmbeddingProvider
                                 │                ├──▶ llm/prompts/*.ts   versioned, locked by hash
                                 │                ├──▶ llm/budget.ts      checked before every POST
                                 │                └──▶ llm_call           one row per exchange
                                 ▼
                          packages/core     parseFilterSet · the resolver · matchDuplicates
```

**`routes/search.ts` is not on that diagram**, and that is the point: it is one SQL query over
`sd_title_trgm_idx`, `identifier_value_trgm_idx` and `sd_tsv_idx`, merged and ranked **by kind of
evidence before score** — an identifier beats a name beats a body, because someone typing `anna@` is
naming a person exactly and someone whose meeting note says "anna" is not naming them at all.

**One capture, end to end.** The model is handed the workspace's **writable** field list and answers
in slugs, with a confidence each. `tasks/quick-capture.ts` checks every slug against the resolver and
every value against the attribute registry — through `planAttributeWrites`, the same function an
ordinary create goes through, so a preview cannot promise a write that would then fail — and then
runs §4.6's deterministic `matchDuplicates` over what survived, with ADR-099's thresholds. A field
the model got wrong is _dropped and named in the note_, never fatal. Confirming posts the edited
preview to `commitQuickCapture`, which writes the contact, the organization, the link between them,
the interaction and the follow-up in **one transaction** (ADR-109), then recomputes §4.7's derived
columns — because a capture that logs a meeting has to move warmth exactly as the Activities tab
does.

**One summary.** `record_summary` is one row per contact, replaced on regenerate, carrying the model
and the timestamp §6.5 asks for. A table rather than a read of the newest `llm_call` row, because
`LLM_TRACE_BODIES=off` nulls `parsed` — using the trace as a cache would let a privacy switch delete
every summary in the product (ADR-112).

**One question, end to end.** The route loads the attribute definitions for contact _and_
organization and hands the resolver's field list to the prompt — slugs, labels, types, operators and
option keys, read from data, so a field created five minutes ago is in the prompt and a deleted one
is not. The model returns a flat proposal; `tasks/ask.ts` checks every slug, every operator and every
value against the resolver, turns a relation **name** into record ids with one database read
(ADR-104), and hands the result to `parseFilterSet`. What survives is an ordinary `FilterSet`, run
through the ordinary `listRecords` — so the answer can show the filter it ran because that filter is
the one the user could have built by hand, and "Open as a table" lands on a page producing exactly
the same rows. A model failure is a sentence, not a 500: a slug that does not exist earns one repair
round-trip and then a plain-English answer (ADR-103).

- **The port.** `ChatProvider` and a separate `EmbeddingProvider`, both OpenAI-compatible. Swapping
  OpenRouter for a direct Anthropic/OpenAI/Ollama endpoint is a base URL. Embeddings are a separate
  port because the two evolve independently and a provider that is good at one is often not the
  other.
- **Model choice is data, not code.** `modelFor(kind)` reads `llm_setting (key, value)` — one row
  per task (`extraction`, `question`, `summary`, `embedding`) — and falls back to the environment.
  The table exists from migration 0006, which is what makes "swappable without a deploy" true on the
  hosted instance. A Settings page later becomes a form over a row that already exists.
- **Structured output, always re-validated.** `response_format: json_schema` with `strict: true`
  plus OpenRouter's `provider.require_parameters`, and then the response is validated again with the
  same Zod schema. One repair round-trip on a schema failure, carrying the validation errors; a
  second failure raises `LlmSchemaError` and the route returns 502.
- **The trace.** Every exchange writes an `llm_call` row — including the failures: prompt id and
  version, the prompt _template_ hash, model requested and model served, input hash, token usage,
  `usage.cost` as reported, latency, status, and `repair_of_id` linking a repair to its original.
  A 429 that was never recorded is a cost cap nobody can explain afterwards. `LLM_TRACE_BODIES=off`
  keeps everything but the request and response bodies, which is a privacy switch and not a
  housekeeping one. **There is no retention job**: a single-user CRM making a few hundred calls a
  month will not approach a size problem for years, and the whole mechanism is one statement —
  `DELETE FROM llm_call WHERE created_at < now() - interval '1 year';`
- **The cost cap.** `LLM_DAILY_COST_LIMIT_USD` (Q7: $5.00) is a circuit breaker, checked immediately
  before **every** billable POST rather than once per task — the naive placement let one user action
  bill up to six generations through retries and repair. The window is the profile's civil day,
  derived in SQL (ADR-105). `GET /api/v1/stats/llm` shows the cap, today's spend and the breakdown
  per day, task and prompt version; `unreportedCalls` is there so a total of $0.00 can be read
  correctly, because ADR-070 records `NULL, 'unreported'` rather than estimating from a price table.
- **Three modes.** `LLM_MODE=live` calls the provider; `replay` reads `fixtures/llm/` and fails
  loudly with the `pnpm llm:record` command when a fixture is missing; `off` answers 503. A missing
  API key is also 503, reported _before_ the user types rather than after they ask — `pnpm dev` on a
  fresh checkout has no key and the whole rest of the app works.
- **Four test layers, none of which spends money** (ADR-072). L1 golden `z.toJSONSchema` snapshots
  per prompt. L2 a `ScriptedProvider` implementing the port, which is what the integration suite
  drives. L3 msw contract tests over the real transport — asserting, among other things, that
  `usage: {include:true}` is _not_ sent and that the total deadline terminates rather than retrying.
  L4 one live smoke test behind `MUTUALS_LLM_LIVE=1`. The e2e drives a stub provider one HTTP hop out
  (ADR-107), so everything below the socket is real.
- **The hard rule.** _The LLM extracts; code decides._ The extraction prompt's return type emits
  attribute **slugs** with confidences and can never emit an attribute id or a chosen existing
  contact — so §4.8's rule is a compile-time fact rather than a checklist item. Matching free text
  to an existing contact is `packages/core/src/identity/duplicates.ts`, deterministic, with
  confidence bands and a question to the user when unsure.

---

## 7. How each §9 feature plugs in

Nothing below is built. Each row is the extension point that exists **today**, so the feature is an
addition rather than a migration.

| Later feature                             | What is already here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Semantic search / embeddings**          | `search_document.embedding vector(1536)`, nullable and unindexed, plus `embedding_model` and `embedded_at`. `EmbeddingProvider` and a typed `embed()` exist and are fixture-tested; nothing calls them. The `search` API takes `mode` (`keyword` today). The HNSW index is created **after** the first backfill, never on an empty column; pgvector caps index dimensions at 2000 for `vector`, and 1536 fits. **`LLM_EMBEDDING_BASE_URL` defaults to OpenAI direct, not OpenRouter** — re-checked 2026-09-05, OpenRouter's catalogue lists no embedding models at all (ADR-106)                                                                                                                                                        |
| **Synergy nudges (ask ↔ offer)**          | `asks` and `offers` are seeded tags from day one, and the demo seed plants twelve tags one person asks for and another offers. `follow_up.origin = 'system'` exists. The rule is recorded and non-negotiable: an introduction may only ever be suggested on an **exact ask↔offer match**, never on topic similarity                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Stay-in-touch nudges**                  | `contact_metrics.warmth` answers "who matters" and `workspace.metrics_swept_at` is the freshness probe the nightly sweep writes as its last statement. The queue arrives with the importer in Stage 5 as `apps/api/src/jobs/` — a `JobQueue` port with an inline adapter first, pg-boss behind the same port later                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Chat channels (Telegram, WhatsApp)**    | `ask`, `quickCapture` and `commitQuickCapture` are built — a bot needs no other surface, and the capture's preview/confirm split is exactly a chat exchange. `interaction.source` and `fact.source` already carry `telegram`, `whatsapp`, `quick_capture`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Voice input**                           | Quick capture takes plain text; a speech-to-text step prepends. Nothing to change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Gmail / Calendar sync**                 | `interaction.source` already includes `gmail` and `calendar`, and `createInteraction` accepts them, so an imported meeting is an ordinary `Interaction` and warmth picks it up with **no code change at all**. The provider interface (`fetchSince(cursor)`) and its `sync_state` table land in `apps/api/src/integrations/` when the first one is written                                                                                                                                                                                                                                                                                                                                                                              |
| **Enrichment crawler**                    | `record.last_enriched_at` / `enriched_by`; per-value provenance already exists as `attribute_value.fact_id → fact`, so a crawled value is a fact with `source = 'crawler'` and `confidence < 1` and the conflict is _visible_ rather than lost                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Network graph**                         | `record_link` is a first-class table with both directions indexed (`rl_uq`, `rl_reverse_idx`); `getContactConnections` is a named operation; interaction counts per pair are one `GROUP BY`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Dashboard charts**                      | `getStats` returns aggregates off `contact_metrics` / `organization_metrics`, which are already materialised                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Auth, multi-user, multi-tenant**        | Every table carries a nullable-but-always-populated `workspace_id` with `UNIQUE NULLS NOT DISTINCT` on every unique constraint that includes it. The migration is `SET NOT NULL` plus one pass of `CREATE INDEX CONCURRENTLY` with `workspace_id` prepended, and **zero logic changes** — every query is already `= $ws`. `apps/api/src/plugins/auth.ts` is the slot: an `onRequest` hook on the root instance whose body is `Promise.resolve()`, so adding a bearer check touches one function and no handler. No `bearerAuth` scheme is published in the OpenAPI document, because declaring a scheme nothing enforces tells every generated client to send credentials that are ignored. There is no global "current user" singleton |
| **CLI client · MCP server**               | `routes/operations.ts` lists every operation and CI asserts route ↔ list parity, so "everything the UI can do, an API can do" is checked rather than hoped. `docs/openapi.json` is generated and committed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Bitemporal value resolution**           | `project_record_as_of(record, date)` is the same function with `AND valid_from <= p_date` and a `DISTINCT ON`. No schema change — the columns are already there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **`current_values jsonb` render cache**   | One column, one line in the projector, one branch in the serialiser. Purely additive; add it only if Stage 7's profile puts hydration on the hot path (today it is 0.77 ms)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Promoting a hot attribute to a column** | Add `contact.city`, backfill, teach the field registry. The compiler emits `c.city` instead of an `EXISTS`. No API, UI or fact-log change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Keyset pagination on custom sorts**     | The list cursor is already opaque, so today's `LIMIT/OFFSET` becomes a keyset walk with no API and no UI change (ADR-023)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 8. Test data

### The demo seed — `pnpm seed`

`packages/db/src/seed/` builds the network §8.1 asks for: **200 contacts, 60 organizations, 500
interactions, 40 follow-ups**, plus the four default views of §6.2 (`All contacts`, `Investors`,
`Founders`, `No interaction in 90 days`) and one for organizations.

It is three steps, split deliberately:

1. **`plan.ts` decides the whole network offline**, from a seeded `@faker-js/faker` and an injected
   `today`. Pure, so `plan.test.ts` asserts the counts, the reproducibility and the plausibility
   without a database.
2. **`apply.ts` writes it through the real write path** — `createContact`, `applyValues`,
   `createInteraction`. Raw inserts would be an order of magnitude faster and would let the seed look
   perfect while the projector was broken, which is the one thing a demo dataset must not do.
3. **`metrics.ts` derives warmth and the four relationship columns from what was written**, never
   from the plan, using `computeWarmth` from `packages/core` — the only implementation there is.

The data is curated where curation matters. A founder works at a startup and an investor at a fund
(`ORG_TYPES_BY_ROLE`); somebody's interests are mostly their employer's industry, so §6.2's own
example filter — _Investors in Munich interested in climate tech_ — returns real people instead of
nothing; and four interaction cohorts produce a warmth distribution rather than a constant:

| Cohort  | Contacts | Cadence                       | Interactions | Resulting warmth |
| ------- | -------: | ----------------------------- | -----------: | ---------------- |
| inner   |       18 | roughly every 3½ weeks        |          198 | 60–80            |
| active  |       45 | roughly every 2 months        |          180 | 25–50            |
| warm    |       60 | one or two touches, 40–200 d  |           90 | 10–25            |
| dormant |       77 | one old touch, or none at all |           32 | 0–9              |

Twelve tags are planted so that one person **asks** for exactly what another **offers** — `seed
funding`, `intro to Stripe`, `hardware manufacturing`, `MDR regulatory advice` and eight more — with
the string written identically on both sides, because a future introduction suggestion is an exact
match and never a similarity score. Seven asks and seven offers are decoys that nothing answers, so
that not every ask is a match.

The four seeded views all compile through `compileList` against the seeded data and return
`All contacts` 200, `Investors` 48, `Founders` 62, `No interaction in 90 days` 65,
`All organizations` 60. That last one is worth a note: filters are **AND-only** (ADR-032), so the
view is the literal reading of its name — `last_interaction_at older_than 90 day` — and the 28
contacts who have _never_ been in touch have a NULL `last_interaction_at` and therefore do **not**
appear, even though they are the coldest people in the database. Covering both would need
`older_than OR is_empty`, which is a change to the wire format and an ADR, not a decision for a seed
script. It is called out here so nobody discovers it as a bug in Stage 4.

`pnpm seed -- --assert-counts` is what CI runs. It asserts the four counts exactly, that every record
has a search document, that the identifier write-through produced rows, that at least ten ask↔offer
matches survived the write path, that at least sixty contacts have a non-zero warmth, and that no
table has a NULL `workspace_id`. `--seed=N` and `--today=YYYY-MM-DD` make any run reproducible;
both are printed on every run.

### The import fixtures — `fixtures/`

Stage 5's test data, written to be **adversarial**, because a clean CSV proves nothing.

`linkedin_connections_sample.csv` — 31 rows behind LinkedIn's real three-line preamble (`Notes:`, the
quoted paragraph about missing email addresses, a blank line) and its real header
`First Name,Last Name,URL,Email Address,Company,Position,Connected On`. It contains ten rows with no
email at all (LinkedIn's normal case), diacritics throughout (`Björn Håkansson`, `Rüdiger Weiß`,
`Zoë`, `Tomás`), two apostrophe surnames (`O'Brien`, `D'Angelo`), a comma inside a quoted company
(`"Meyer, Schulz & Partner"`), a comma inside a quoted position, a **real newline inside a quoted
field**, an all-uppercase email, a missing first name and a malformed email.

`google_contacts_sample.csv` — 21 rows in Google's export shape, including **both**
`E-mail 1 - Value` and `E-mail 2 - Value`, which is the one-target-one-column trap ADR-044 names by
hand; Google's `* myContacts ::: Investors` label separator; a `--09-30` birthday with no year; a
newline inside `Notes`; and a website with a trailing dot (`https://halden-security.example./`),
which is the malformed-host case ADR-042's website normaliser has a test for.

The planted duplicate pairs hit **different stages of the matching cascade** on purpose:

| Pair                                           | Rule it should fire                   | Why                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anna Berger ×2 (LinkedIn), and again in Google | `identifier` (email 0.97)             | Same address in three different cases                                                                                                                          |
| Björn Håkansson / Bjoern Hakansson             | `identifier` (linkedin 0.99)          | Same profile URL, transliterated name, one row has no email                                                                                                    |
| Marta Nowak ×2                                 | `email_local_match`                   | `marta.nowak@gmail.com` vs `m.a.r.t.a.nowak+crm@gmail.com` — a duplicate **signal**, never a stored identifier                                                 |
| Jonas Weber / J. Weber                         | `name_initial_org_same`               | Same company, initial instead of a first name                                                                                                                  |
| Ekaterina / Ekatarina Volkova                  | `name_fuzzy_org_same`                 | One-letter typo, same company, no identifier on either side                                                                                                    |
| Lukas Müller / Lukas Mueller                   | `name_fuzzy_org_same`                 | `unaccent` folds `ü→u`; the German transliteration `ue` does not, so these are _not_ the same normalised name                                                  |
| Rüdiger Weiß / Rudiger Weiss (Google)          | `identifier` (phone 0.8) + fuzzy name | Phone alone must **not** reach `certain`                                                                                                                       |
| Petra and Oskar Lindqvist (Google)             | **must not match**                    | Two colleagues sharing one Nordbank switchboard number — ADR-042's named case for the certainty gate: 0.8 + 0.8 noisy-or is 0.96, and the gate caps it at 0.94 |
| Jonas Weber (Google) — no organization         | `name_exact_org_unknown`              | Same name, no employer to confirm or deny                                                                                                                      |

### The performance harness — `pnpm db:check`

Described in §4. It is `packages/db/src/seed/perf.ts` plus `packages/db/src/bin/check.ts`, generates
its own 60 `perf_*` attributes across all twelve types, marks every record it creates with an
`import_batch` row so cleanup is exact, and refuses to run without organizations to point the
relation attribute at.

---

## 9. Commands

```bash
pnpm dev                    # database up, migrated, API and web running
pnpm db:up                  # just the database (creates dev/test/e2e)
pnpm db:migrate             # migrations, explicitly, never on boot
pnpm db:migrate status      # what is applied and what is pending
pnpm seed                   # the demo network; resets first
pnpm seed -- --assert-counts
pnpm db:reproject           # rebuild every derived value from the fact log
pnpm db:reproject -- --verify   # ...and prove it is byte-identical
pnpm db:check               # the 10k × 60 measurement above
pnpm openapi                # regenerate docs/openapi.json (CI asserts it matches)
pnpm llm:relock             # rewrite apps/api/src/llm/prompts.lock.json (ADR-067)
pnpm llm:record --prompt ask.filter   # ONE live, billable call -> fixtures/llm/
pnpm verify                 # what CI runs: verify:static + verify:db
pnpm verify:full            # ...plus verify:e2e
```

`pnpm llm:record` is the only command in this repository that spends money, and it is never part of
`verify`. `MUTUALS_LLM_LIVE=1 pnpm test:unit` is the other one: ADR-072's fourth layer, one live call
against the ask prompt, skipped by default and skipped in CI, because secrets are unavailable to a
pull request from a fork and a red build an outside contributor cannot fix is worse than no test.
