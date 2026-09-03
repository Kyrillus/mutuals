# DECISION: Storage design for Mutuals

**Status:** Accepted (Stage 0). Load-bearing for `packages/db`, `packages/core` and every API list endpoint.
**Target:** Postgres 16 (Supabase = managed Postgres only), extensions `pgcrypto`, `pg_trgm`, `btree_gin`, `unaccent`, `vector`.
**Scale the design is built for:** one user, 2k–10k contacts, ~60 attribute definitions per object type, a few hundred writes a day, one 10k-row LinkedIn import as the peak write event.

---

## 0. The decision in one paragraph

**Two layers, one projector.** The append-only `fact` table is the truth and carries **typed slot
columns** (`text_value`, `num_value`, `date_value`, `bool_value`, `option_id`, `target_record_id`)
rather than an untyped `jsonb` blob. A single `attribute_value` table is the **one derived model** —
used for `WHERE`, for `ORDER BY` **and** for reading a row — with the identical typed columns, so the
projection is a column-for-column copy rather than a serialise/deserialise pair. Every row in
`attribute_value` is, by construction, a current value: there is no liveness predicate for a query to
forget. Relations live in a first-class `record_link` table because the link carries its own
attributes. Derived columns (`last_interaction_at`, `interaction_count_12m`, `open_followups`,
`warmth`) are materialised as real typed columns in `contact_metrics`. Full-text lives in a separate
`search_document` table, which is also where the `vector(1536)` column already sits. **There is no
`current_values jsonb` column and there is no runtime DDL**: nine fixed indexes on `attribute_value`,
each led by `attribute_id`, cover attribute number 3 and attribute number 300 identically, so creating
an attribute in Settings is one `INSERT`.

This is the **typed-EAV** shape, hardened with the best mechanisms from the other two proposals.

---

## 1. Why this and not the alternatives

The brief's own two rules decide this: *"Prefer boring, well-documented technology over clever or new
technology"* and *"Never over-engineer."*

### 1.1 The scale argument comes first, because it removes most of the debate

10k contacts × ~15 populated attributes ≈ **150k `attribute_value` rows ≈ 27 MB heap + ~45 MB of
indexes**. The `fact` table with history is another ~65 MB. The entire attribute store is ~140 MB and
lives in the OS page cache on any laptop. A sequential scan of it is ~20 ms; a filtered index scan is
sub-millisecond. **At the brief's actual scale all three proposals are fast enough, and any claim of a
10× win is an artefact of extrapolating to a scale this product will not reach.**

So the decision is *not* about speed. It is about which shape (a) cannot silently corrupt data,
(b) does not run DDL when a non-technical user clicks Save, and (c) a stranger cloning the repo can
read.

### 1.2 Why not pure JSONB `current_values` + GIN

JSONB genuinely wins one thing: sort-by-custom-attribute can be index-ordered, because the sort key is
an expression on the driving table. That is worth single-digit milliseconds at 10k rows and it costs:

1. **Runtime DDL as a load-bearing mechanism.** GIN on `jsonb` serves containment and existence only —
   never `<`, `>`, or `ORDER BY`. Every `number` range, every `date` range, every `contains`, and every
   alphabetical/numeric sort needs a *per-attribute expression index*. That is `CREATE INDEX
   CONCURRENTLY` (outside a transaction, with an `INVALID`-index recovery path) fired by a Settings
   click, plus a `managed_index` catalog, plus a `db:verify-indexes` CI check, plus a drizzle-kit
   ignore-list. It also directly contradicts §3.2's "migrations must be versioned, in the repo and
   reproducible": the schema becomes a function of the user's click history.
   And the index budget is **double** what it looks like: a btree declared `(x)` yields `DESC NULLS
   FIRST` when scanned backwards, so index-ordered pagination with `NULLS LAST` in *both* directions
   needs two indexes per sortable attribute. 40 custom attributes → 80–100 runtime-created indexes,
   and a 10k-row import then pays 2M index insertions.
2. **No type enforcement, and the failure is silent row disappearance.** `{"check_size": "600000"}` is
   valid JSONB. An extractor that returns `NULL` for the wrong JSON type means the record vanishes from
   `check_size > 500000` *and* answers "empty" to one operator while answering "not empty" to another.
   That is the worst possible failure mode for a CRM: a filter that quietly omits people. The
   mitigations on offer (a Zod codec, a nightly audit query) are all outside the database.
3. **A hand-rolled ISO-8601 date parser as a database function**, because `text::date` is `STABLE` not
   `IMMUTABLE` and therefore illegal in an index expression. Correct reasoning, but it is the
   antithesis of "boring technology" and it is load-bearing for every date filter in the product.
4. **`long_text` has to be excluded** from the projection to stay under the ~2 KB TOAST threshold —
   so a column literally named "current values" does not contain all of them, and `is empty`
   (`NOT (cv ? 'notes')`) is unconditionally true for those attributes unless the compiler
   special-cases them. A trap for every future reader, human or model.

### 1.3 Why not the three-layer hybrid (`fact` + `attribute_value` + `current_values jsonb`)

The hybrid's central insight is right — the `SELECT` list and the `WHERE` clause want different
shapes — and I am keeping most of its *mechanisms* (see §1.5). But strip `current_values` and what
remains is typed EAV, which means `current_values` must justify itself on its own. It cannot, here:

- **The read tax it removes is not real at this scale.** Hydrating 50 rows from `attribute_value` is
  ~750 index entries over `av_record_attr` — under 2 ms, once, in a query written once. The jsonb
  column saves perhaps 1 ms per page and costs a third synchronised copy of every value.
- **Its load-bearing rule is unenforceable.** "Never `WHERE` on `current_values`, never `SELECT` from
  `attribute_value`" lives in a markdown table, and the hybrid proposal itself broke it in its own
  §4.6 warmth sweep. A future contributor — or a future AI session reading `\d contact` and
  `\d attribute_value` — sees two homes for the same value and picks correctly about half the time.
- **It doubles the write path.** A single tag removal needs both an `attribute_value` delete *and*
  hand-rolled `jsonb_agg` array surgery on the jsonb column: two divergent implementations of the
  projector's job, in two languages, that must agree forever.

**Extension point, written down now:** because `fact` is truth and `attribute_value` is derived,
adding a `current_values jsonb` render cache later is purely additive — one column, one line in the
projector, one branch in the API serialiser, no change to filtering, sorting or the API contract.
Add it if and only if Stage 7's 10k-row profile shows the hydration query on the hot path.

### 1.4 Why not fold the read model into `fact` itself (partial indexes on live rows)

Tempting, and the most minimal option: index `fact` with `WHERE superseded_by_id IS NULL AND removed_at
IS NULL` and skip the projection entirely. Rejected for two reasons:

1. **Every query in the codebase would carry the liveness predicate, and there would be two different
   ones** (`fact_live_uq` must include tombstones; the read path must exclude them). One forgotten
   predicate silently renders a superseded value as current — the same class of silent wrongness that
   rules out JSONB. In `attribute_value`, *every row is current*, so there is nothing to forget.
2. **A read-model change would mean rewriting an append-only log.** Changing the tag normalisation rule
   from `lower()` to `lower()+unaccent()` is `pnpm db:reproject` with a separate projection, and an
   `UPDATE` over the audit log without one.

### 1.5 What was taken from the losing proposals

| Adopted | From | Why |
|---|---|---|
| Composite FK `(attribute_id, value_kind, is_multi) → attribute_definition` | hybrid | One FK line replaces a 20-line `CASE` CHECK **and** makes §4.2's "changing the type of an attribute is not supported" a fact the database enforces while values exist. |
| Separate truncated `text_sort text COLLATE "C"`, `NULL` for `long_text` | hybrid | Fixes a real runtime abort (btree tuple cap ~2704 B) on the first `notes` value over ~2.7 kB. `COLLATE "C"` also makes sorts memcmp-fast and immune to glibc collation drift across OS upgrades. |
| `option_id` and `target_record_id` as **separate** columns with real FKs | hybrid | The EAV proposal overloaded one `ref_value uuid` for option ids *and* record ids, which makes any foreign key impossible. |
| Text normalisation (`lower`+`unaccent`) is a **written column**, not a generated column or index expression | hybrid's reasoning, inverted | `unaccent()` being `STABLE` only matters for generated columns and index expressions. `text_norm` is neither — it is written by the projector — so plain SQL `unaccent()` is legal and no TypeScript detour is needed. |
| `AFTER STATEMENT` trigger on `fact` as a backstop + a session GUC to defer it for the bulk path | JSONB | Makes the projection unbypassable by `psql`, a hand-run migration, or the §7 MCP server. |
| `pnpm db:reproject` + a CI assertion that a full rebuild is byte-identical | JSONB | The entire safety argument for keeping any derived copy. |
| Split the sort/filter pass from the payload fetch (narrow Q1, then hydrate Q2) | performance lens | Sort tuples drop from ~1 kB to ~40 B, so the sorts that remain unavoidable can never spill `work_mem`. |
| Count as a **separate, cached** query — never `count(*) OVER ()` | performance lens | A window function with no frame buffers the entire filtered set and defeats `LIMIT`. |
| `to_tsvector('simple', …)`, not `'english'` | hybrid | A multilingual address book of proper nouns; English stemming mangles names. |
| Embeddings in a separate table, never on the row the contact list scans | hybrid | A `vector(1536)` is ~6 kB and would halve heap density on the hottest table. |
| Multicolumn `gin (attribute_id, text_norm gin_trgm_ops)` via `btree_gin` | performance lens (verified there) | Scopes `contains` per attribute; a plain single-column trigram GIN returns hits from `notes` when you filter `city`. |
| `UNIQUE NULLS NOT DISTINCT` **and** always populating `workspace_id` | EAV + hybrid | Belt and braces: `= $ws` works from day one, and uniqueness holds even if a seed script forgets. |
| `CHECK (text_value <> '')` | EAV | "Empty string" and "no value" can never diverge, at any write site. |
| Constrain the "Ask the network" LLM filter grammar to AND-only | hybrid | An `OR` between two `EXISTS` clauses defeats the semi-join pull-up. §5.2 already guarantees AND-only for the UI. |
| Record pgvector's **index** dimension cap (2000 for `vector`, 4000 for `halfvec`) in `ARCHITECTURE.md` now | JSONB | So nobody picks a 3072-dim model in Stage 8 and discovers it after a backfill. |

### 1.6 What was deliberately dropped from the EAV base proposal

- **`option_rank` / `option_pos` denormalisation.** Sorting by `single_select` needs the option's
  position. Because the sort key comes from a join either way (see §6.3), the denormalisation only
  saves a hash join against a ≤200-row fully-cached table — and it costs a bulk `UPDATE` on a cosmetic
  Settings action plus a resync obligation the projector must never forget. Dropped; sort joins
  `attribute_option`. Additive to re-add if Stage 7 says so.
- **`is_multi` as a free-standing column pair.** Folded into the single composite FK, so one parent
  probe carries both invariants instead of two.
- **`deleted_at` soft delete.** §5.4 promises "This will delete 3 contacts and 12 interactions" and
  §4.5 says deleting a record deletes its facts. Soft delete also breaks §6.8: a deleted contact's
  email would block re-importing that person forever. Deletion is real, via `ON DELETE CASCADE`.
- **`records.display_label` maintained by unspecified code.** Kept, but with a named owner: a 10-line
  trigger on `contact`/`organization` that depends only on that row's own columns.
- **`value_type` as a denormalised copy with no FK.** Replaced by `value_kind` under the composite FK.

---

## 2. Complete DDL

Migration files are drizzle-kit-versioned. Anything drizzle-kit 0.31.x cannot express (composite FKs
to a non-PK unique target, `NULLS NOT DISTINCT`, multicolumn GIN with a non-default opclass, partial
unique indexes, functions, triggers) is a **hand-authored `.sql` file under drizzle-kit's numbering**,
so §3.2's "versioned, in the repo, reproducible" holds either way. Drizzle's TS schema stays the
single source for types and static queries.

### 2.1 Extensions, enums, workspace, profile

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- substring "contains"
CREATE EXTENSION IF NOT EXISTS btree_gin;  -- uuid opclass for the multicolumn trigram GIN
CREATE EXTENSION IF NOT EXISTS unaccent;   -- text_norm, written (not generated) — see §2.5
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector; column exists in Phase 1, populated later

CREATE TYPE object_type AS ENUM ('contact','organization','interaction');

CREATE TYPE attribute_type AS ENUM (
  'short_text','long_text','number','date','yes_no','single_select',
  'multi_select','tags','url','email','phone','relation');

-- which physical slot an attribute_type lands in. Derived from attribute_type in code,
-- stored so the database can enforce it (composite FK, §2.4/§2.5).
CREATE TYPE value_kind AS ENUM ('text','number','date','bool','option','relation');

CREATE TYPE fact_source  AS ENUM ('manual','import','quick_capture','agent','gmail','calendar','crawler');
CREATE TYPE created_via  AS ENUM ('manual','import','api','agent');

CREATE TABLE workspace (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One row seeded by migration 0001 with a fixed uuid so seeds/tests are reproducible.

-- §6.6 Profile. Single row; no auth in Phase 1.
CREATE TABLE profile (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  first_name   text NOT NULL,
  last_name    text NOT NULL,
  email        text,
  language     text NOT NULL DEFAULT 'en',
  timezone     text NOT NULL DEFAULT 'Europe/Berlin',  -- §6.6 gains this field; see open questions
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

**`workspace_id` policy (§9), decided once and applied everywhere.** The column is nullable on every
table exactly as the brief requires, **but the application always populates it** with the seeded
default workspace id. Consequences: every query is `= $ws` from day one (not
`IS NOT DISTINCT FROM $ws`, which cannot use an equality index well); the multi-tenant migration is
`SET NOT NULL` plus one pass of `CREATE INDEX CONCURRENTLY` with `workspace_id` prepended, and **zero
logic changes**. `workspace_id` is in **no index key** in Phase 1 — it is a constant column, pure
overhead. Every unique constraint carrying it also uses `NULLS NOT DISTINCT`, so uniqueness still holds
if a seed script or a hand-run migration forgets to populate it. A CI check asserts no row has a NULL
`workspace_id`. *(ADR: deliberate deviation from the literal reading of §9.)*

### 2.2 Import batches and the `record` supertype

```sql
CREATE TABLE import_batch (                                     -- §4.4
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  file_name    text        NOT NULL,
  object_type  object_type NOT NULL,
  row_count    integer     NOT NULL DEFAULT 0,
  mapping      jsonb       NOT NULL DEFAULT '{}'::jsonb,        -- opaque config, never filtered on
  created_count  integer NOT NULL DEFAULT 0,
  merged_count   integer NOT NULL DEFAULT 0,
  skipped_count  integer NOT NULL DEFAULT 0,
  imported_at  timestamptz NOT NULL DEFAULT now()
);

-- Polymorphic parent. Postgres has no polymorphic foreign key; this is the standard answer and it is
-- the ONLY way fact / attribute_value / identifier / record_link / search_document get real
-- ON DELETE CASCADE, which §4.5 ("deleting a record deletes its facts") requires.
CREATE TABLE record (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid REFERENCES workspace(id) ON DELETE CASCADE,
  object_type      object_type NOT NULL,

  -- §4.4 provenance, as columns not a blob: §6.8 filters and links by import_batch_id
  created_via      created_via NOT NULL DEFAULT 'manual',
  import_batch_id  uuid REFERENCES import_batch(id) ON DELETE SET NULL,
  last_enriched_at timestamptz,                                  -- §9 crawler, nullable now
  enriched_by      text,

  -- denormalised label for relation chips, global search and merge previews.
  -- Owner: the trigger in §2.9. Never written by hand.
  display_label    text NOT NULL DEFAULT '',

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX record_list_idx  ON record (object_type, created_at DESC, id DESC);
CREATE INDEX record_batch_idx ON record (import_batch_id) WHERE import_batch_id IS NOT NULL;
-- ⌘K substring search over names (§4.8 says *substring*, which tsvector cannot do)
CREATE INDEX record_label_trgm_idx ON record USING gin (lower(display_label) gin_trgm_ops);

CREATE TABLE contact (
  id               uuid PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
  first_name       text,
  last_name        text,
  display_name     text GENERATED ALWAYS AS
                     (btrim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))) STORED,
  -- §4.7 manual warmth overrides. Real boolean columns, not attributes: they are behaviour, not data.
  pinned_important boolean NOT NULL DEFAULT false,               -- floor 60
  not_important    boolean NOT NULL DEFAULT false                -- cap 10, excluded from nudges
);
CREATE INDEX contact_name_sort_idx ON contact (lower(display_name) COLLATE "C", id);

CREATE TABLE organization (
  id   uuid PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
  name text NOT NULL
);
CREATE INDEX organization_name_sort_idx ON organization (lower(name) COLLATE "C", id);
```

`record` costs one hash join on every list query (against a table permanently in cache) and one extra
`INSERT` on create. In exchange: five polymorphic tables get real cascades, the `relation` attribute
type has one FK target instead of a nullable-pair hack, `provenance` has one home, and §4.1's
"Interactions do not get custom attributes in Phase 1, but model them so it would be a small change"
becomes *literally* a small change — `interaction` is already a `record` subtype (§2.10), so adding
custom attributes to interactions is inserting `attribute_definition` rows and nothing else.

### 2.3 Attribute definitions and options

```sql
CREATE TABLE attribute_definition (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  object_type  object_type    NOT NULL,
  title        text           NOT NULL,
  slug         text           NOT NULL CHECK (slug ~ '^[a-z][a-z0-9_]{0,62}$'),
  type         attribute_type NOT NULL,
  value_kind   value_kind     NOT NULL,   -- derived from `type` in code, enforced by the CHECK below
  is_multi     boolean        NOT NULL,   -- tags, multi_select, relation-many
  config       jsonb          NOT NULL DEFAULT '{}'::jsonb,
                              -- unit, decimals, min/max, target_object_type, has_link_metadata
  group_name   text,                                             -- §4.2 `group`
  description  text,
  is_system    boolean        NOT NULL DEFAULT false,
  position     integer        NOT NULL DEFAULT 0,
  created_at   timestamptz    NOT NULL DEFAULT now(),
  updated_at   timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT ad_kind_matches_type CHECK (
    (type IN ('short_text','long_text','url','email','phone','tags') AND value_kind = 'text')
    OR (type = 'number'                            AND value_kind = 'number')
    OR (type = 'date'                              AND value_kind = 'date')
    OR (type = 'yes_no'                            AND value_kind = 'bool')
    OR (type IN ('single_select','multi_select')   AND value_kind = 'option')
    OR (type = 'relation'                          AND value_kind = 'relation')),

  CONSTRAINT ad_multi_matches_type CHECK (
    (type IN ('tags','multi_select') AND is_multi)
    OR (type = 'relation')                                       -- one or many, from config
    OR (type NOT IN ('tags','multi_select','relation') AND NOT is_multi)),

  -- §9 trap: workspace_id is nullable. A plain UNIQUE treats every NULL as distinct, so `email`
  -- could be created twice. NULLS NOT DISTINCT (PG15+) is not optional here.
  CONSTRAINT ad_slug_uq UNIQUE NULLS NOT DISTINCT (workspace_id, object_type, slug),

  -- FK target that makes slot/cardinality drift impossible (see §2.4, §2.5).
  CONSTRAINT ad_shape_uq UNIQUE (id, value_kind, is_multi)
);
CREATE INDEX ad_object_pos_idx ON attribute_definition (object_type, position, id);
```

Slug validation against the reserved list (system attribute names, SQL keywords) is enforced in
`packages/core` at creation time — a pure function with unit tests, per §8.1. The regex CHECK is the
database's backstop. **Attribute slugs never reach SQL**: the compiler resolves slug → definition row
first, and an unknown slug is a 400 before any SQL is built (§5.1).

```sql
CREATE TABLE attribute_option (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  attribute_id uuid NOT NULL REFERENCES attribute_definition(id) ON DELETE CASCADE,
  key          text NOT NULL,          -- stable machine key; `label` is renameable, `key` is not
  label        text NOT NULL,
  color        text,
  position     integer NOT NULL,       -- THE sort order for single_select (§4.2 "option order")
  archived_at  timestamptz,            -- §6.7: options are archived, never hard-deleted while used
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ao_key_uq   UNIQUE (attribute_id, key),
  CONSTRAINT ao_label_uq UNIQUE (attribute_id, label),
  -- A full (non-partial) UNIQUE *constraint* may be DEFERRABLE, so a drag-reorder can rewrite
  -- positions in one statement. (A partial unique INDEX cannot — see §11.)
  CONSTRAINT ao_pos_uq   UNIQUE (attribute_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ao_order_idx ON attribute_option (attribute_id, position) WHERE archived_at IS NULL;
```

### 2.4 `fact` — the truth, typed

```sql
CREATE TABLE fact (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid REFERENCES workspace(id) ON DELETE CASCADE,
  object_type      object_type NOT NULL,
  record_id        uuid NOT NULL REFERENCES record(id) ON DELETE CASCADE,
  attribute_id     uuid NOT NULL,
  value_kind       value_kind NOT NULL,
  is_multi         boolean    NOT NULL,

  -- Typed slots. Identical set and identical types to attribute_value, so the projection is a
  -- column-for-column copy: no serialiser, no ::numeric cast, no "did we store dates as ISO
  -- strings or epoch millis" bug waiting in Stage 6 when the LLM starts appending facts.
  text_value       text,
  num_value        numeric,
  date_value       date,
  bool_value       boolean,
  option_id        uuid REFERENCES attribute_option(id) ON DELETE RESTRICT,
  target_record_id uuid REFERENCES record(id) ON DELETE CASCADE,   -- relation

  -- §4.3 link metadata (contact -> organization). Four nullable columns cost four bits in the
  -- null bitmap on the ~99% of rows where they are NULL, not four words.
  link_title       text,
  link_from        date,
  link_to          date,                       -- NULL = current
  link_is_primary  boolean,

  -- Identity of one value within an attribute. '' for single-valued (so one constraint expresses
  -- both cardinalities); the canonical value for multi-valued. Derivation table in §3.2.
  value_key        text NOT NULL,

  valid_from       date        NOT NULL,       -- when it became true
  observed_at      timestamptz NOT NULL DEFAULT now(),   -- when we learned it
  source           fact_source NOT NULL,
  source_ref       text,                       -- import_batch id, interaction id, message id
  confidence       numeric(3,2) NOT NULL DEFAULT 1.0 CHECK (confidence > 0 AND confidence <= 1),
  superseded_by_id uuid REFERENCES fact(id) ON DELETE SET NULL,
  removed_at       timestamptz,                -- §4.5: removal is a fact, not a delete
  removed_source   fact_source,
  created_at       timestamptz NOT NULL DEFAULT now(),

  -- ONE composite FK carries both invariants with ONE parent probe: a `number` attribute can never
  -- acquire a text value, and an attribute's type/cardinality cannot change while any fact exists
  -- (the FK blocks it) — which is §4.2's "changing the type of an attribute is not supported",
  -- enforced by the database instead of by a comment in the UI.
  CONSTRAINT fact_shape_fk FOREIGN KEY (attribute_id, value_kind, is_multi)
    REFERENCES attribute_definition (id, value_kind, is_multi) ON DELETE CASCADE,

  CONSTRAINT fact_single_key CHECK (is_multi OR value_key = ''),
  CONSTRAINT fact_key_len    CHECK (length(value_key) <= 512),

  CONSTRAINT fact_slot CHECK (
    CASE value_kind
      WHEN 'text'     THEN text_value IS NOT NULL AND text_value <> ''
                           AND num_nonnulls(num_value, date_value, bool_value,
                                            option_id, target_record_id) = 0
      WHEN 'number'   THEN num_value  IS NOT NULL
                           AND num_nonnulls(text_value, date_value, bool_value,
                                            option_id, target_record_id) = 0
      WHEN 'date'     THEN date_value IS NOT NULL
                           AND num_nonnulls(text_value, num_value, bool_value,
                                            option_id, target_record_id) = 0
      WHEN 'bool'     THEN bool_value IS NOT NULL
                           AND num_nonnulls(text_value, num_value, date_value,
                                            option_id, target_record_id) = 0
      WHEN 'option'   THEN option_id  IS NOT NULL
                           AND num_nonnulls(text_value, num_value, date_value,
                                            bool_value, target_record_id) = 0
      WHEN 'relation' THEN target_record_id IS NOT NULL
                           AND num_nonnulls(text_value, num_value, date_value,
                                            bool_value, option_id) = 0
    END),

  CONSTRAINT fact_link_only_on_relation CHECK (
    value_kind = 'relation'
    OR num_nonnulls(link_title, link_from, link_to, link_is_primary) = 0),
  CONSTRAINT fact_link_dates CHECK (link_from IS NULL OR link_to IS NULL OR link_from <= link_to),
  CONSTRAINT fact_removed_pair CHECK ((removed_at IS NULL) = (removed_source IS NULL))
);
```

Indexes on `fact`, and exactly why each exists:

```sql
-- At most one live fact per value slot. Includes tombstones deliberately: a tombstone occupies the
-- slot, which is what makes "removed then re-added" a clean supersession chain.
-- (Not DEFERRABLE — CREATE UNIQUE INDEX has no such clause. Safe because the write path in §4.1
-- supersedes BEFORE it inserts.)
CREATE UNIQUE INDEX fact_live_uq ON fact (record_id, attribute_id, value_key)
  WHERE superseded_by_id IS NULL;

-- §4.5 hover card: full history of one attribute on one record, superseded rows included.
CREATE INDEX fact_history_idx ON fact (record_id, attribute_id, valid_from DESC, observed_at DESC);

-- projector reads: the live facts for one record (whole-record and per-attribute scopes)
CREATE INDEX fact_live_read_idx ON fact (record_id, attribute_id)
  WHERE superseded_by_id IS NULL AND removed_at IS NULL;

-- §6.8: "which records did import batch X touch", and undo/error reporting
CREATE INDEX fact_source_ref_idx ON fact (source, source_ref) WHERE source_ref IS NOT NULL;
```

Note there is **no unique constraint across all facts**: the log may legitimately hold two live
observations of "Munich" from two sources — that is §4.5's whole point ("a conflict between two
sources is visible instead of lost"). `fact_live_uq` constrains only the *live* slot; whichever fact
wins supersedes the other, and both stay readable in the history.

### 2.5 `attribute_value` — the one derived model

Every row here is, by construction, a current value. There is no liveness predicate to forget.

```sql
CREATE TABLE attribute_value (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  object_type  object_type NOT NULL,
  record_id    uuid NOT NULL REFERENCES record(id) ON DELETE CASCADE,
  attribute_id uuid NOT NULL,
  value_kind   value_kind NOT NULL,
  is_multi     boolean    NOT NULL,
  value_key    text       NOT NULL,     -- '' single-valued; canonical value multi-valued
  position     integer    NOT NULL DEFAULT 0,   -- order within a multi-valued attribute
  fact_id      uuid NOT NULL REFERENCES fact(id) ON DELETE CASCADE,  -- per-value provenance (§9)

  -- typed slots: identical to fact
  text_value   text,                    -- verbatim, for display and round-trip
  text_norm    text,                    -- lower + unaccent + trim, FULL length -> trigram GIN
  text_sort    text COLLATE "C",        -- left(text_norm, 256); NULL for long_text -> btree
  num_value    numeric,
  date_value   date,
  bool_value   boolean,
  option_id    uuid REFERENCES attribute_option(id) ON DELETE RESTRICT,
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT av_shape_fk FOREIGN KEY (attribute_id, value_kind, is_multi)
    REFERENCES attribute_definition (id, value_kind, is_multi) ON DELETE CASCADE,

  -- relations live in record_link, because the link carries its own attributes (§2.6)
  CONSTRAINT av_no_relations CHECK (value_kind <> 'relation'),
  CONSTRAINT av_single_key   CHECK (is_multi OR value_key = ''),
  CONSTRAINT av_key_len      CHECK (length(value_key) <= 512),

  CONSTRAINT av_slot CHECK (
    CASE value_kind
      WHEN 'text'   THEN text_value IS NOT NULL AND text_value <> '' AND text_norm IS NOT NULL
                         AND num_nonnulls(num_value, date_value, bool_value, option_id) = 0
      WHEN 'number' THEN num_value  IS NOT NULL
                         AND num_nonnulls(text_value, text_norm, text_sort, date_value,
                                          bool_value, option_id) = 0
      WHEN 'date'   THEN date_value IS NOT NULL
                         AND num_nonnulls(text_value, text_norm, text_sort, num_value,
                                          bool_value, option_id) = 0
      WHEN 'bool'   THEN bool_value IS NOT NULL
                         AND num_nonnulls(text_value, text_norm, text_sort, num_value,
                                          date_value, option_id) = 0
      WHEN 'option' THEN option_id  IS NOT NULL
                         AND num_nonnulls(text_value, text_norm, text_sort, num_value,
                                          date_value, bool_value) = 0
      ELSE false
    END)
);
```

**`text_value` / `text_norm` / `text_sort` — three columns, three jobs.** `text_value` is verbatim for
display. `text_norm` is `lower(unaccent(btrim(v)))`, full length, and is the only column the trigram
GIN indexes. `text_sort` is `left(text_norm, 256)` and is `NULL` for `long_text`.

Two non-obvious reasons for `text_sort` being a separate, truncated, `NULL`-for-long_text column:

1. **A btree index tuple is capped at ~2704 bytes.** Indexing `long_text` directly raises
   `index row size … exceeds btree version 4 maximum` — at import time, on real user data. The EAV
   proposal shipped exactly that bomb three times over; this is the fix.
2. **The partial predicate must be provable.** `WHERE text_sort IS NOT NULL` is something the planner
   can prove from a query. `WHERE length(text_norm) <= 256` is not, so that index would be built and
   silently never used.

`COLLATE "C"` because the value is already lower-cased and unaccented, so byte order reads correctly
for latin scripts; comparisons become `memcmp` with working abbreviated keys (materially faster sorts —
and the sort is the one thing this design cannot avoid); and it is immune to the glibc collation
changes that silently corrupt locale-collated index order across an OS upgrade.

**Where normalisation happens, and why the `unaccent` immutability problem does not apply.**
`text_norm` and `text_sort` are **written columns**, produced by the projector's `INSERT … SELECT`:

```sql
lower(unaccent(btrim(f.text_value)))                 -- text_norm
left(lower(unaccent(btrim(f.text_value))), 256)      -- text_sort
```

`unaccent(text)` is `STABLE`, not `IMMUTABLE` — which makes it illegal in a *generated column* or an
*index expression*, and legal in an ordinary `INSERT`. Since these are neither, plain SQL is fine and
no TypeScript detour is required. *(Fallback if `unaccent` is unavailable on a target Postgres: drop it
from the expression. Only accent-insensitivity is lost; every filter still works. Guarded by a Stage-1
migration that fails loudly.)*

The nine fixed indexes. **None of them grows with the number of attributes** — each is led by
`attribute_id`, so every attribute owns a contiguous key range. That is what makes "user creates
attribute number 300" an `INSERT` and not a `CREATE INDEX`.

```sql
-- 1. hydration (the Q2 read path), value identity, and §6.8 import idempotency in one index
CREATE UNIQUE INDEX av_record_attr_uq ON attribute_value (record_id, attribute_id, value_key);

-- 2-6. one contiguous key range per attribute: a "per-attribute index" with no per-attribute DDL
CREATE INDEX av_attr_text_idx ON attribute_value (attribute_id, text_sort,  record_id)
  WHERE text_sort  IS NOT NULL;   -- `equals` prefix + alphabetical ORDER BY
CREATE INDEX av_attr_num_idx  ON attribute_value (attribute_id, num_value,  record_id)
  WHERE num_value  IS NOT NULL;   -- = ≠ < > between + numeric ORDER BY
CREATE INDEX av_attr_date_idx ON attribute_value (attribute_id, date_value, record_id)
  WHERE date_value IS NOT NULL;   -- before/after/between + chronological ORDER BY
CREATE INDEX av_attr_bool_idx ON attribute_value (attribute_id, bool_value, record_id)
  WHERE bool_value IS NOT NULL;   -- is yes / is no + "yes first" ORDER BY
CREATE INDEX av_attr_opt_idx  ON attribute_value (attribute_id, option_id,  record_id)
  WHERE option_id  IS NOT NULL;   -- is one of / contains any of / contains all of

-- 7. tags `contains any of` on the exact normalised key (no truncation, so no false matches)
CREATE INDEX av_attr_key_idx ON attribute_value (attribute_id, value_key, record_id);

-- 8. `is empty` as an indexed anti-join, and §6.7's "Used in (count of records with a value)"
CREATE INDEX av_attr_rec_idx ON attribute_value (attribute_id, record_id);

-- 9. `contains` (substring), scoped PER ATTRIBUTE. Without the leading attribute_id (which needs
--    btree_gin's uuid opclass), a `city contains 'munich'` probe would return every value row in
--    the database whose text contains "munich" — notes included — and then recheck.
CREATE INDEX av_trgm_idx ON attribute_value USING gin (attribute_id, text_norm gin_trgm_ops)
  WHERE text_norm IS NOT NULL;
```

### 2.6 `record_link` — relations with link metadata (§4.3)

Relations are the one attribute type that does not go through `attribute_value`, because the
contact↔organization link carries its own attributes and because one table gives bidirectionality for
free. It is still projected from `fact`, so a job-title change is auditable history.

```sql
CREATE TABLE record_link (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid REFERENCES workspace(id) ON DELETE CASCADE,
  attribute_id    uuid NOT NULL REFERENCES attribute_definition(id) ON DELETE CASCADE,
  from_record_id  uuid NOT NULL REFERENCES record(id) ON DELETE CASCADE,
  to_record_id    uuid NOT NULL REFERENCES record(id) ON DELETE CASCADE,
  -- §4.3 link metadata
  title           text,
  valid_from      date,
  valid_to        date,                    -- NULL = current
  is_primary      boolean NOT NULL DEFAULT false,
  position        integer NOT NULL DEFAULT 0,
  fact_id         uuid NOT NULL REFERENCES fact(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rl_dates CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  CONSTRAINT rl_no_self CHECK (from_record_id <> to_record_id)
);

CREATE UNIQUE INDEX rl_uq          ON record_link (from_record_id, attribute_id, to_record_id);
-- §4.3 "exactly one primary organization", enforced by the database
CREATE UNIQUE INDEX rl_primary_uq  ON record_link (from_record_id, attribute_id) WHERE is_primary;
-- §4.3 "all relations are bidirectional in the UI" = one index lookup, not a second stored row
CREATE INDEX rl_reverse_idx        ON record_link (to_record_id, attribute_id, from_record_id);
-- §6.5 Connections tab reads as a CV: current before past, straight off the index
CREATE INDEX rl_current_idx        ON record_link (from_record_id, attribute_id,
                                                   valid_to NULLS FIRST, valid_from DESC);
-- §6.5c "also at the same organization"
CREATE INDEX rl_same_org_idx       ON record_link (to_record_id, from_record_id) WHERE valid_to IS NULL;
```

### 2.7 Identifiers (§4.6)

```sql
CREATE TABLE identifier (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  record_id    uuid NOT NULL REFERENCES record(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('email','phone','linkedin_url','website',
                                             'google_contact_id','telegram','whatsapp','other')),
  value        text NOT NULL,     -- normalised: lower(email), E.164 phone, canonical LinkedIn slug
  source       fact_source NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT identifier_uq UNIQUE NULLS NOT DISTINCT (workspace_id, kind, value)
);
CREATE INDEX identifier_record_idx ON identifier (record_id, kind);
```

The projector writes through here for the `email` / `phone` / `linkedin_url` / `website` attributes, so
duplicate detection is a unique-index probe — deterministic, no LLM, exactly as §4.8 demands ("the LLM
extracts; code decides"). Uniqueness of emails lives here, not in the attribute system: no dynamic
attribute design can express "this attribute's values must be globally unique", and the brief already
solved that by giving identifiers their own table.

Because deletion is real (no soft delete), deleting a contact frees their email for re-import — which
§6.8 requires.

### 2.8 Interactions, follow-ups, saved views, metrics, search

```sql
-- interaction is a `record` subtype so §4.1's "model it so custom attributes would be a small
-- change" costs one uuid insert today and zero schema change later.
CREATE TABLE interaction (
  id           uuid PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('Meeting','Call','Email','Message','Intro','Event','Note')),
  occurred_at  timestamptz NOT NULL,
  title        text,
  body         text,                                              -- markdown
  source       text NOT NULL DEFAULT 'manual'
                 CHECK (source IN ('manual','import','gmail','calendar','whatsapp','telegram','agent'))
);
CREATE INDEX interaction_occurred_idx ON interaction (occurred_at DESC, id);

CREATE TABLE interaction_contact (
  interaction_id uuid NOT NULL REFERENCES interaction(id) ON DELETE CASCADE,
  contact_id     uuid NOT NULL REFERENCES contact(id)     ON DELETE CASCADE,
  PRIMARY KEY (interaction_id, contact_id)
);
CREATE INDEX ic_contact_idx ON interaction_contact (contact_id, interaction_id);

CREATE TABLE interaction_organization (
  interaction_id  uuid NOT NULL REFERENCES interaction(id)  ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  PRIMARY KEY (interaction_id, organization_id)
);

CREATE TABLE follow_up (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  contact_id   uuid NOT NULL REFERENCES contact(id) ON DELETE CASCADE,   -- §4.1: one, required
  title        text NOT NULL,
  due_at       date NOT NULL,
  status       text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Done','Snoozed')),
  recurrence   jsonb,                                    -- {kind:'monthly'} | {kind:'every_n_days',n:45}
  origin       text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','system')),  -- §9 nudges
  notes        text,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fu_open_idx      ON follow_up (contact_id, due_at) WHERE status = 'Open';
CREATE INDEX fu_due_idx       ON follow_up (due_at, id)         WHERE status = 'Open';  -- dashboard
CREATE INDEX fu_status_idx    ON follow_up (status, due_at, id);                        -- §6.4 tabs

-- §5.2 / §6.6 saved views
CREATE TABLE saved_view (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  object_type  object_type NOT NULL,
  name         text NOT NULL,
  is_default   boolean NOT NULL DEFAULT false,
  columns      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{slug, width?}] in display order
  filters      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- the serialised filter model (§5.1)
  sort         jsonb,                                -- {slug, direction}
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sv_name_uq UNIQUE NULLS NOT DISTINCT (workspace_id, object_type, name)
);
CREATE UNIQUE INDEX sv_default_uq ON saved_view (workspace_id, object_type) WHERE is_default;

-- §4.7 / §5.2 derived columns. Materialised, because §5.2 requires them to be filterable and
-- sortable like any other column, which means a real index, which means stored.
CREATE TABLE contact_metrics (
  contact_id            uuid PRIMARY KEY REFERENCES contact(id) ON DELETE CASCADE,
  workspace_id          uuid REFERENCES workspace(id) ON DELETE CASCADE,
  last_interaction_at   timestamptz,
  interaction_count_12m integer  NOT NULL DEFAULT 0,
  open_followups        integer  NOT NULL DEFAULT 0,
  next_followup_at      date,
  warmth                smallint NOT NULL DEFAULT 0 CHECK (warmth BETWEEN 0 AND 100),
  computed_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cm_last_idx  ON contact_metrics (last_interaction_at DESC NULLS LAST, contact_id);
CREATE INDEX cm_warm_idx  ON contact_metrics (warmth DESC, contact_id);
CREATE INDEX cm_count_idx ON contact_metrics (interaction_count_12m DESC, contact_id);
CREATE INDEX cm_open_idx  ON contact_metrics (open_followups DESC, contact_id) WHERE open_followups > 0;
CREATE INDEX cm_next_idx  ON contact_metrics (next_followup_at) WHERE next_followup_at IS NOT NULL;

CREATE TABLE organization_metrics (
  organization_id     uuid PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  workspace_id        uuid REFERENCES workspace(id) ON DELETE CASCADE,
  people_count        integer NOT NULL DEFAULT 0,          -- §6.3 "People" column
  last_interaction_at timestamptz,
  computed_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX om_people_idx ON organization_metrics (people_count DESC, organization_id);
CREATE INDEX om_last_idx   ON organization_metrics (last_interaction_at DESC NULLS LAST, organization_id);
```

`contact_metrics` is a separate 1:1 table rather than columns on `contact` so the nightly warmth sweep
rewrites a ~48-byte row instead of the contact row, keeping `contact`'s heap dense and its visibility
map clean.

### 2.9 Search: tsvector now, pgvector later, one database

```sql
CREATE TABLE search_document (
  record_id    uuid PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  object_type  object_type NOT NULL,
  title        text NOT NULL DEFAULT '',    -- display name / org name / interaction title
  body         text NOT NULL DEFAULT '',    -- title + emails + org names + tags + long_text + notes
  tsv          tsvector GENERATED ALWAYS AS (
                 setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
                 setweight(to_tsvector('simple', coalesce(body,'')),  'B')) STORED,
  embedding    vector(1536),               -- §9: column exists in Phase 1, always NULL
  embedding_model text,
  embedded_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sd_tsv_idx   ON search_document USING gin (tsv);
CREATE INDEX sd_title_trgm_idx ON search_document USING gin (lower(title) gin_trgm_ops);
-- Created in a later stage, AFTER the embedding backfill, so it is not built on an empty column:
-- CREATE INDEX sd_hnsw_idx ON search_document USING hnsw (embedding vector_cosine_ops)
--   WITH (m = 16, ef_construction = 64);
```

Four decisions inside that block:

1. **`to_tsvector('simple', …)` — the two-argument form is mandatory.** The one-argument form is only
   `STABLE` (it reads `default_text_search_config`), so it cannot appear in a generated column or an
   index. The query side must use the identical two-argument call or the index is not used.
2. **`'simple'`, not `'english'`.** This is a multilingual address book full of proper nouns; English
   stemming mangles names and is wrong for German/French entries. §4.8 asks for *substring* search
   anyway — that is the trigram index's job. `tsv` provides word-level relevance over interaction
   bodies.
3. **A separate table, not columns on `contact`.** A `vector(1536)` is ~6 kB; on the contact row it
   would push every contact into TOAST and halve the heap density of the table the contacts list
   scans.
4. **pgvector's dimension cap is on the INDEX, not the column.** `vector` accepts up to 16000
   dimensions, but HNSW and IVFFlat support at most **2000** for `vector` and **4000** for `halfvec`.
   `text-embedding-3-small` (1536) fits; a 3072-dim model needs `halfvec` or dimension reduction. This
   goes into `docs/ARCHITECTURE.md` in Stage 1, not into a Stage 8 surprise. pgvector 0.8's
   `hnsw.iterative_scan` is the answer to filtered semantic search ("investors in Munich, semantically")
   — same table, same filter compiler, one new branch.

The `display_label` trigger — the named owner of that denormalised column:

```sql
CREATE FUNCTION sync_record_label() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE record SET display_label =
           CASE TG_TABLE_NAME
             WHEN 'contact'      THEN NEW.display_name
             WHEN 'organization' THEN NEW.name
             ELSE coalesce(NEW.title, '')
           END,
         updated_at = now()
   WHERE id = NEW.id;
  RETURN NULL;
END $$;

CREATE TRIGGER contact_label      AFTER INSERT OR UPDATE ON contact
  FOR EACH ROW EXECUTE FUNCTION sync_record_label();
CREATE TRIGGER organization_label AFTER INSERT OR UPDATE ON organization
  FOR EACH ROW EXECUTE FUNCTION sync_record_label();
CREATE TRIGGER interaction_label  AFTER INSERT OR UPDATE ON interaction
  FOR EACH ROW EXECUTE FUNCTION sync_record_label();
```

It depends only on columns of the row being written, so it is trivially correct and cannot drift.

### 2.10 Connection settings

Set on every pooled connection (one line in the `pg` pool config), with the reason recorded:

```sql
SET join_collapse_limit = 16;   -- default 8; §5.4 — 4 base relations + 1 semi-join per filter chip
SET from_collapse_limit = 16;
SET geqo_threshold      = 20;   -- default 12; keep the exhaustive planner up to ~12 chips
```

Safe at this table size (planning a 16-relation query over tables of this size costs ~1–3 ms) and it
moves the plan-stability cliff from ~5 filter chips to ~12. pg-boss gets its own schema in the same
database (§3.2's "prefer a Postgres-backed queue"), untouched by these settings.

---

## 3. The value model

### 3.1 Type → slot → operators → sort, all twelve types

| Type | `value_kind` | multi | Slot(s) written | Filter operators (§4.2) | Sort (§4.2) |
|---|---|---|---|---|---|
| `short_text` | text | no | `text_value`, `text_norm`, `text_sort` | contains, equals, is empty | alphabetical (`text_sort`) |
| `long_text` | text | no | `text_value`, `text_norm` (`text_sort` **NULL**) | contains, is empty | — (API 400) |
| `number` | number | no | `num_value numeric` | =, ≠, <, >, between, is empty | numeric (`num_value`) |
| `date` | date | no | `date_value date` | before, after, between, relative, is empty | chronological (`date_value`) |
| `yes_no` | bool | no | `bool_value` (nullable) | is yes, is no, is empty | `bool_value DESC NULLS LAST` = yes first |
| `single_select` | option | no | `option_id` | is one of, is not one of, is empty | option order (join `attribute_option.position`) |
| `multi_select` | option | **yes** | `option_id`, one row per option | contains any of, contains all of, is empty | — (API 400) |
| `tags` | text | **yes** | `text_value`, `text_norm`, `text_sort`, `value_key` | contains any of, is empty | — (API 400) |
| `url` | text | no | `text_value`, `text_norm`, `text_sort` | contains, is empty | — (API 400) |
| `email` | text | no | `text_value`, `text_norm`, `text_sort` | contains, is empty | alphabetical (`text_sort`) |
| `phone` | text | no | `text_value` (E.164), `text_norm`, `text_sort` | contains, is empty | — (API 400) |
| `relation` | relation | config | **`record_link` only** | has any of, is empty | — (API 400) |

Sortability is a property of the attribute definition, exposed in the API and used by the DataTable to
decide whether a column header is clickable. Asking to sort by a non-sortable type is a 400, not a
silent no-op.

### 3.2 `value_key` derivation — the identity of one value

| Cardinality / type | `value_key` |
|---|---|
| any single-valued attribute | `''` (empty string) |
| `tags` | `left(lower(unaccent(btrim(text))), 512)` |
| `multi_select` | the option's stable `key` |
| `relation` (many) | not applicable — identity is `record_link (from, attribute, to)` |

Because single-valued attributes all use `''`, the unique index
`av_record_attr_uq (record_id, attribute_id, value_key)` **automatically** enforces "at most one value"
for them, and `fact_live_uq` **automatically** enforces "at most one live fact". One constraint
expresses both cardinalities — no separate rule, no separate code path. `CHECK (is_multi OR value_key =
'')` closes the loop, and `is_multi` itself is guaranteed to match the definition by the composite FK.

### 3.3 One definition of "empty", for all twelve types

**`is empty` means: no live value row exists.**

```sql
NOT EXISTS (SELECT 1 FROM attribute_value v
             WHERE v.record_id = r.id AND v.attribute_id = $a)
```

and, for `relation`, the same shape over `record_link`. That is *one* definition, indexed by
`av_attr_rec_idx`, for every type. There is no second definition anywhere, and no type where `is empty`
means something else.

Two supporting rules make it airtight:

- `CHECK (text_value <> '')` on both `fact` and `attribute_value` — so "empty string" and "no value"
  can never diverge, at any write site. Clearing a text field appends a tombstone fact and removes the
  value row; it never stores `''`.
- No JSON `null`, no `[]`, no sentinel values exist anywhere in the model, because there is no
  document to put them in.

### 3.4 Two operator semantics the brief does not specify

Both are product calls, both go in `docs/DECISIONS.md`, and both are shown verbatim in the filter
chip's tooltip so the user is never guessing:

- **`number ≠ x` means "has a value, and it differs"** — it does **not** include records with no
  value, because `is empty` is a separate operator and the other convention silently returns every
  empty record, which reads as a bug. Compiles inside the `EXISTS`.
- **`single_select is not one of` means `NOT (is one of)`** and therefore **does** include records with
  no value, matching how a person reads "is not an Investor". Compiles as `NOT EXISTS`.

*(Notion and Airtable disagree with each other here, which is why it is an ADR and not a silent
choice.)*

---

## 4. The write path, exactly

Every fact write is one transaction at `READ COMMITTED`. The order of statements is load-bearing.

### 4.1 Setting a single-valued attribute

```sql
BEGIN;

-- 1. Serialise concurrent writers on this record. One row lock, held for microseconds. This is
--    what makes the projection safe: two concurrent edits cannot interleave and lose one.
SELECT 1 FROM record WHERE id = $rec FOR UPDATE;

-- 2. Supersede the current live fact FIRST. The new fact's id is generated in the application
--    (gen_random_uuid() in TS) so it can be referenced before the row exists.
--    Doing this before the INSERT is why `fact_live_uq` is never violated. Sibling data-modifying
--    CTEs share one snapshot and one command id, so the insert-then-supersede shape WOULD violate
--    it — and a partial unique index cannot be DEFERRABLE. Statement order is the fix, and it is
--    the boring one.
UPDATE fact
   SET superseded_by_id = $new_fact_id
 WHERE record_id = $rec AND attribute_id = $attr AND value_key = ''
   AND superseded_by_id IS NULL;

-- 3. Append the new fact.
INSERT INTO fact (id, workspace_id, object_type, record_id, attribute_id, value_kind, is_multi,
                  text_value, num_value, date_value, bool_value, option_id, target_record_id,
                  value_key, valid_from, observed_at, source, source_ref, confidence)
VALUES ($new_fact_id, $ws, 'contact', $rec, $attr, $kind, false,
        $text, $num, $date, $bool, $option, NULL,
        '', coalesce($valid_from, current_date), now(), $source, $source_ref, $confidence);

-- 4. Project this (record, attribute) into attribute_value / record_link / identifier /
--    search_document. See §4.5.
SELECT project_record($rec, $attr);

-- 5. Bump the record's updated_at (the display_label trigger handles name changes separately).
UPDATE record SET updated_at = now() WHERE id = $rec;

COMMIT;
```

### 4.2 Adding one multi-valued element (a tag, an option, a relation)

Identical, except step 2 is scoped to `value_key = $key` (so it only supersedes a prior fact for the
*same* value — typically a tombstone from an earlier removal), and step 3 carries that `value_key`.
A re-add after a removal therefore supersedes the tombstone, and the history reads truthfully:
*added → removed by whom, when → added again*.

### 4.3 Removing one multi-valued element, or clearing a field

**A removal is a new fact row with its own provenance, never an in-place `UPDATE`** — §4.5 says so, and
an in-place update to an append-only log loses "who removed this, and when did we learn it".

```sql
BEGIN;
SELECT 1 FROM record WHERE id = $rec FOR UPDATE;

UPDATE fact SET superseded_by_id = $tomb_id
 WHERE record_id = $rec AND attribute_id = $attr AND value_key = $key
   AND superseded_by_id IS NULL;

-- The tombstone carries the value being removed (so history says WHICH value went), plus its own
-- source and confidence. It is live (superseded_by_id IS NULL) but not a value (removed_at set),
-- so it occupies the fact_live_uq slot and is excluded from the projection.
INSERT INTO fact (id, …, value_key, removed_at, removed_source, source, confidence, …)
VALUES ($tomb_id, …, $key, now(), $source, $source, $confidence, …);

SELECT project_record($rec, $attr);
COMMIT;
```

**Live value set = `superseded_by_id IS NULL AND removed_at IS NULL`.** That predicate appears in
exactly two places in the entire codebase — inside `project_record` and inside the history query — and
nowhere else, because `attribute_value` has no history to filter.

### 4.4 Which fact wins: the resolution rule, stated plainly

**Current = the newest non-superseded, non-removed fact**, exactly as §4.5 literally says. Supersession
in §4.1 is unconditional: the newest write wins.

`valid_from` is stored, indexed and shown in the history popover ("Company: Stripe — *since Jun 2025*,
from LinkedIn import"), but it **does not gate currency in Phase 1**. I am saying this explicitly
because it is tempting to advertise bitemporal resolution ("she moved to Berlin in June, learned in
September") and then not implement it — the ordering clause never fires if supersession is
unconditional, and a half-implemented rule is worse than none.

**Extension point:** the bitemporal variant is `project_record_as_of(record, date)` — the same function
with `AND valid_from <= p_date` added and `DISTINCT ON (…) ORDER BY valid_from DESC, observed_at DESC,
confidence DESC` replacing the "one live row" assumption. No schema change; the columns are already
there.

### 4.5 The projector

```sql
CREATE FUNCTION project_record(p_record uuid, p_attribute uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  ------------------------------------------------------------------ 1. attribute_value (non-relation)
  INSERT INTO attribute_value (
    workspace_id, object_type, record_id, attribute_id, value_kind, is_multi, value_key, position,
    fact_id, text_value, text_norm, text_sort, num_value, date_value, bool_value, option_id, updated_at)
  SELECT f.workspace_id, f.object_type, f.record_id, f.attribute_id, f.value_kind, f.is_multi,
         f.value_key,
         (row_number() OVER (PARTITION BY f.attribute_id
                             ORDER BY f.value_key, f.observed_at) - 1)::int,
         f.id,
         f.text_value,
         lower(unaccent(btrim(f.text_value))),
         CASE WHEN d.type = 'long_text' THEN NULL
              ELSE left(lower(unaccent(btrim(f.text_value))), 256) END,
         f.num_value, f.date_value, f.bool_value, f.option_id, now()
    FROM fact f
    JOIN attribute_definition d ON d.id = f.attribute_id
   WHERE f.record_id = p_record
     AND (p_attribute IS NULL OR f.attribute_id = p_attribute)
     AND f.superseded_by_id IS NULL
     AND f.removed_at IS NULL
     AND f.value_kind <> 'relation'
  ON CONFLICT (record_id, attribute_id, value_key) DO UPDATE SET
     fact_id = EXCLUDED.fact_id, position = EXCLUDED.position,
     text_value = EXCLUDED.text_value, text_norm = EXCLUDED.text_norm,
     text_sort = EXCLUDED.text_sort, num_value = EXCLUDED.num_value,
     date_value = EXCLUDED.date_value, bool_value = EXCLUDED.bool_value,
     option_id = EXCLUDED.option_id, updated_at = now();

  -- Upsert first, delete-orphans second, as two separate statements. A DELETE and an
  -- ON CONFLICT INSERT in one statement share a snapshot and command id and can error with
  -- "ON CONFLICT DO UPDATE command cannot affect row a second time".
  DELETE FROM attribute_value v
   WHERE v.record_id = p_record
     AND (p_attribute IS NULL OR v.attribute_id = p_attribute)
     AND NOT EXISTS (
           SELECT 1 FROM fact f
            WHERE f.record_id = v.record_id AND f.attribute_id = v.attribute_id
              AND f.value_key = v.value_key
              AND f.superseded_by_id IS NULL AND f.removed_at IS NULL);

  ------------------------------------------------------------------ 2. record_link (relations)
  INSERT INTO record_link (workspace_id, attribute_id, from_record_id, to_record_id,
                           title, valid_from, valid_to, is_primary, position, fact_id, updated_at)
  SELECT f.workspace_id, f.attribute_id, f.record_id, f.target_record_id,
         f.link_title, f.link_from, f.link_to, coalesce(f.link_is_primary, false),
         (row_number() OVER (PARTITION BY f.attribute_id
                             ORDER BY f.link_to NULLS FIRST, f.link_from DESC) - 1)::int,
         f.id, now()
    FROM fact f
   WHERE f.record_id = p_record
     AND (p_attribute IS NULL OR f.attribute_id = p_attribute)
     AND f.superseded_by_id IS NULL AND f.removed_at IS NULL
     AND f.value_kind = 'relation'
  ON CONFLICT (from_record_id, attribute_id, to_record_id) DO UPDATE SET
     title = EXCLUDED.title, valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to,
     is_primary = EXCLUDED.is_primary, position = EXCLUDED.position,
     fact_id = EXCLUDED.fact_id, updated_at = now();

  DELETE FROM record_link l
   WHERE l.from_record_id = p_record
     AND (p_attribute IS NULL OR l.attribute_id = p_attribute)
     AND NOT EXISTS (
           SELECT 1 FROM fact f
            WHERE f.record_id = l.from_record_id AND f.attribute_id = l.attribute_id
              AND f.target_record_id = l.to_record_id
              AND f.superseded_by_id IS NULL AND f.removed_at IS NULL);

  ------------------------------------------------------------------ 3. identifier write-through (§4.6)
  INSERT INTO identifier (workspace_id, record_id, kind, value, source)
  SELECT v.workspace_id, v.record_id,
         CASE d.type WHEN 'email' THEN 'email' WHEN 'phone' THEN 'phone'
                     ELSE CASE WHEN d.slug = 'linkedin_url' THEN 'linkedin_url' ELSE 'website' END END,
         v.text_norm, f.source
    FROM attribute_value v
    JOIN attribute_definition d ON d.id = v.attribute_id
    JOIN fact f ON f.id = v.fact_id
   WHERE v.record_id = p_record
     AND (d.type IN ('email','phone') OR d.slug IN ('linkedin_url','website'))
  ON CONFLICT DO NOTHING;    -- identifiers accumulate: §4.6 keeps every handle ever seen

  ------------------------------------------------------------------ 4. search_document
  INSERT INTO search_document (record_id, workspace_id, object_type, title, body, updated_at)
  SELECT r.id, r.workspace_id, r.object_type, r.display_label,
         r.display_label || ' ' ||
         coalesce((SELECT string_agg(v.text_value, ' ')
                     FROM attribute_value v WHERE v.record_id = r.id
                      AND v.value_kind = 'text'), '') || ' ' ||
         coalesce((SELECT string_agg(o.label, ' ')
                     FROM attribute_value v JOIN attribute_option o ON o.id = v.option_id
                    WHERE v.record_id = r.id), '') || ' ' ||
         coalesce((SELECT string_agg(tr.display_label, ' ')
                     FROM record_link l JOIN record tr ON tr.id = l.to_record_id
                    WHERE l.from_record_id = r.id), ''),
         now()
    FROM record r WHERE r.id = p_record
  ON CONFLICT (record_id) DO UPDATE SET
     title = EXCLUDED.title, body = EXCLUDED.body, updated_at = now();
END $$;
```

**Why the projector is a SQL function, not TypeScript.** It is mechanical column copying — the
type-specific branching that needs unit tests lives on the *write* side, in `packages/core`'s Zod
codecs (which decide which slot a value goes into and validate it before a fact is built). Keeping the
projector in SQL means it can be a trigger, which means it cannot be bypassed:

```sql
CREATE FUNCTION fact_project_trg() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r uuid;
BEGIN
  IF coalesce(current_setting('mutuals.defer_projection', true), 'off') = 'on' THEN
    RETURN NULL;
  END IF;
  FOR r IN SELECT DISTINCT record_id FROM changed LOOP
    PERFORM project_record(r, NULL);
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER fact_project AFTER INSERT OR UPDATE OR DELETE ON fact
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION fact_project_trg();
```

The application calls `project_record` explicitly inside its transaction (so the scope is the narrow
`(record, attribute)` form and the work is not done twice — the trigger is idempotent, so a second run
is a no-op upsert). The trigger exists so the invariant survives a `psql` session, a hand-run
migration, and the §7 MCP server writing SQL directly. A **statement-level** trigger with a transition
table, not `FOR EACH ROW`, so a multi-row insert fires it once instead of N times.

### 4.6 The bulk path (imports) — this must exist from Stage 1

10k rows × 15 attributes = 150 000 facts. Running §4.1 that many times takes minutes. The importer
never does. It is one audited code path with its own integration test.

```sql
BEGIN;
SET LOCAL mutuals.defer_projection = 'on';   -- expires at COMMIT; no RESET needed

-- 1. COPY the records, then the facts. Normalised strings (text_norm, text_sort, E.164 phones,
--    canonical LinkedIn slugs) are computed in TypeScript during CSV parsing and go into the
--    stream, so the SQL side stays set-based.
COPY record (id, workspace_id, object_type, created_via, import_batch_id, display_label) FROM STDIN;
COPY contact (id, first_name, last_name) FROM STDIN;
COPY fact (id, workspace_id, object_type, record_id, attribute_id, value_kind, is_multi,
           text_value, num_value, date_value, bool_value, option_id, target_record_id,
           value_key, valid_from, observed_at, source, source_ref, confidence) FROM STDIN;

-- 2. Supersede prior single-valued facts for the touched (record, attribute) pairs. Set-based.
--    §6.8's "Merge into existing" path depends on this: without it a re-import leaves two live
--    facts for one single-valued attribute and the history UI marks two values as current.
UPDATE fact old
   SET superseded_by_id = nw.id
  FROM (SELECT DISTINCT ON (f.record_id, f.attribute_id, f.value_key)
               f.id, f.record_id, f.attribute_id, f.value_key
          FROM fact f
         WHERE f.source_ref = $batch
         ORDER BY f.record_id, f.attribute_id, f.value_key, f.observed_at DESC, f.id) nw
 WHERE old.record_id = nw.record_id
   AND old.attribute_id = nw.attribute_id
   AND old.value_key = nw.value_key
   AND old.id <> nw.id
   AND old.superseded_by_id IS NULL;

-- 3. One set-based projection, scoped to the touched (record, attribute) PAIRS — not to whole
--    records. Scoping the insert to whole records while scoping the delete to pairs is how you
--    get a spurious unique violation on the second import of the same file.
WITH touched AS (
  SELECT DISTINCT record_id, attribute_id FROM fact WHERE source_ref = $batch
)
INSERT INTO attribute_value (…)
SELECT … FROM fact f JOIN touched t USING (record_id, attribute_id)
                     JOIN attribute_definition d ON d.id = f.attribute_id
 WHERE f.superseded_by_id IS NULL AND f.removed_at IS NULL AND f.value_kind <> 'relation'
ON CONFLICT (record_id, attribute_id, value_key) DO UPDATE SET …;

DELETE FROM attribute_value v USING touched t
 WHERE v.record_id = t.record_id AND v.attribute_id = t.attribute_id
   AND NOT EXISTS (SELECT 1 FROM fact f
                    WHERE f.record_id = v.record_id AND f.attribute_id = v.attribute_id
                      AND f.value_key = v.value_key
                      AND f.superseded_by_id IS NULL AND f.removed_at IS NULL);

-- 4. record_link, identifier and search_document for the touched records, same set-based shape.
COMMIT;
```

`pnpm db:reproject` is step 3 without the `touched` restriction: a full rebuild of every derived table
from `fact`. **Stage 1's test suite runs it after every fixture load and after the API mutation suite,
and asserts the result is byte-identical.** That assertion — not the shape of the tables — is the whole
safety argument for maintaining a projection, and it is a CI gate, not a nice-to-have.

### 4.7 Attribute deletion (§6.7) and option deletion

```sql
-- The confirmation dialog's count comes first, index-backed by av_attr_rec_idx:
SELECT count(DISTINCT record_id) FROM attribute_value WHERE attribute_id = $1;

BEGIN;
  DELETE FROM attribute_definition WHERE id = $1;   -- cascades fact, attribute_value, record_link,
                                                    -- attribute_option
COMMIT;
```

**No `DROP INDEX`, no `managed_index` bookkeeping, no drizzle-kit ignore-list.** Deleting an attribute
is one `DELETE`. This is the mirror image of "creating an attribute is one `INSERT`", and it is the
practical reason this design was chosen.

**Option deletion** is deliberately not a cascade. `attribute_value.option_id` and `fact.option_id` are
`ON DELETE RESTRICT`, and the §6.7 flow is: (1) ask clear-or-remap; (2) append superseding facts that
clear or remap the values; (3) project; (4) set `archived_at` on the option so it disappears from
pickers but history still renders its label. A hard `DELETE` succeeds only for a genuinely unused
option, which `RESTRICT` proves. The alternative (`ON DELETE CASCADE` on the value rows) deletes the
values but leaves the facts live, so `db:reproject` resurrects them and then fails the FK — a real trap
that this ordering avoids.

### 4.8 Merge (§6.9)

```sql
BEGIN;
SELECT 1 FROM record WHERE id IN ($survivor, $loser) ORDER BY id FOR UPDATE;  -- ordered: no deadlock

-- 1. For each single-valued attribute where the user chose the SURVIVOR's value, supersede the
--    loser's live fact with the survivor's, so the loser's value becomes visible history rather
--    than a competing live fact. Where the user chose the LOSER's value, do the reverse.
--    (This must happen before the repoint, or fact_live_uq fires.)
-- 2. Repoint everything at the survivor.
UPDATE fact                SET record_id  = $survivor WHERE record_id  = $loser;
UPDATE record_link         SET from_record_id = $survivor WHERE from_record_id = $loser;
UPDATE record_link         SET to_record_id   = $survivor WHERE to_record_id   = $loser;
UPDATE identifier          SET record_id  = $survivor WHERE record_id  = $loser;
UPDATE interaction_contact SET contact_id = $survivor WHERE contact_id = $loser;
UPDATE follow_up           SET contact_id = $survivor WHERE contact_id = $loser;
-- 3. Rebuild, then delete the shell.
SELECT project_record($survivor, NULL);
DELETE FROM record WHERE id = $loser;         -- cascades the (now empty) subtype row
COMMIT;
```

Both merged records' provenance survives, because losing values are superseded facts, not deleted rows.
The `ON DELETE CASCADE` from `record` is what makes step 3 safe: there is nothing left to orphan.

---

## 5. The read path, exactly

### 5.1 Three queries, not one

The list endpoint issues **three** queries, and this separation is deliberate:

| # | Purpose | Shape |
|---|---|---|
| Q1 | filter + sort + paginate | narrow: `(id, sort_key)` only — ~40-byte sort tuples, so the sort can never spill `work_mem` |
| Q2 | hydrate the ≤50 surviving ids | `WHERE record_id = ANY($1)` over `av_record_attr_uq` |
| Q3 | the "Rows: 2,236" footer | separate, over the same compiled `WHERE`, cached per filter signature |

**Q3 is never `count(*) OVER ()`.** A window function with no `PARTITION` and no frame ordering must
buffer its entire input into a tuplestore before emitting the first row, so `LIMIT 50` cannot
short-circuit anything: on an unfiltered page it materialises all 10k rows. Instead Q3 is a narrow
`SELECT count(*)` over the same predicate (index-only or bitmap-only), memoised per filter signature
for the duration of a view, and replaced by `reltuples`-based estimation above a configurable
threshold.

The API returns an **opaque cursor** rather than an offset, so `OFFSET` can become keyset pagination
later with no API change and no UI change.

### 5.2 Q1 — the brief's headline query

*Contacts where `job_role` is one of (Investor, Angel) AND `city` contains "Munich" AND
`areas_of_interest` contains any of (climate) AND `last_interaction_at` older than 90 days, sorted by
the custom number attribute `check_size` descending, paginated.*

```sql
SELECT r.id,
       sv.num_value AS sort_key
  FROM record r
  JOIN contact c            ON c.id = r.id
  LEFT JOIN contact_metrics m ON m.contact_id = r.id
  -- The sort join is a plain LEFT JOIN, not a LATERAL: every sortable type is single-valued, so
  -- value_key = '' and av_record_attr_uq guarantees at most one row. That gives the planner more
  -- freedom than a lateral with LIMIT 1 and produces the same result.
  LEFT JOIN attribute_value sv
         ON sv.record_id = r.id AND sv.attribute_id = $sort_attr AND sv.value_key = ''
 WHERE r.workspace_id = $ws
   AND r.object_type  = 'contact'

   -- single_select is one of  → av_attr_opt_idx
   AND EXISTS (SELECT 1 FROM attribute_value v
                WHERE v.record_id = r.id AND v.attribute_id = $job_role
                  AND v.option_id = ANY($role_option_ids::uuid[]))

   -- short_text contains      → av_trgm_idx, scoped to this attribute
   AND EXISTS (SELECT 1 FROM attribute_value v
                WHERE v.record_id = r.id AND v.attribute_id = $city
                  AND v.text_norm LIKE '%' || $city_q || '%')

   -- tags contains any of     → av_attr_key_idx, exact normalised keys
   AND EXISTS (SELECT 1 FROM attribute_value v
                WHERE v.record_id = r.id AND v.attribute_id = $areas
                  AND v.value_key = ANY($area_keys::text[]))

   -- derived column: a real column, so a plain predicate → cm_last_idx
   -- Whether "never interacted" counts as ">90 days ago" is a PRODUCT decision; the compiler
   -- emits the IS NULL branch only when the view says so.
   AND (m.last_interaction_at IS NULL
        OR m.last_interaction_at < now() - ($days || ' days')::interval)

 ORDER BY sv.num_value DESC NULLS LAST, r.id DESC
 LIMIT $limit OFFSET $offset;
```

**Why `EXISTS` and not `JOIN` per predicate.** A `JOIN` multiplies rows for multi-valued attributes: a
contact with five tags appears five times and the footer count lies. `EXISTS` compiles to a semi-join,
returns each record once, and `NOT EXISTS` gives `is empty` for free through the same code path.
Crucially, writing each chip as an `EXISTS` lets Postgres **pull the sublink up into the join tree and
pick its own driving table** — if `city contains munich` is the selective chip it drives from
`av_trgm_idx`; if `job_role` is, it drives from `av_attr_opt_idx`. An application that pre-fetches id
lists has already made that choice, badly, and ships tens of thousands of uuids over the wire.

**Expected plan at 10k contacts** (extrapolated from index shapes — see §9): three index/bitmap scans
on `av_attr_opt_idx`, `av_trgm_idx` and `av_attr_key_idx`; hash semi-joins against a `record` scan
restricted by `record_list_idx`; a hash join to `contact_metrics` (≈500 kB, permanently cached); one
nested-loop probe per surviving row into `av_record_attr_uq` for the sort key; a top-N heapsort of
~40-byte tuples. **Single-digit milliseconds.**

**The honest weakness of this query is the `ORDER BY`.** The sort key comes from a join, so Postgres
sorts the whole filtered set rather than walking `av_attr_num_idx` in order. At 10k rows that is a few
milliseconds. It stops being free somewhere around 100k *matching* rows, and the documented escape
hatch (§9) is a query change, not a schema change — which is the entire point of having the typed
table.

### 5.3 The complete operator → SQL table

`r` = the driving record row. `$a` = attribute id (resolved from the slug; never interpolated).
`$q` = the needle, already `lower(unaccent(btrim(·)))`-normalised **in `packages/core`**, so the client
and the index agree on normalisation. `esc()` escapes `%`, `_` and `\` for `LIKE`. Every value is a
bind parameter; the only identifiers in the emitted SQL come from a closed set of eight column-name
literals chosen by `value_kind`. **There is no path from user input to a SQL identifier.**

All attribute predicates are wrapped in
`EXISTS (SELECT 1 FROM attribute_value v WHERE v.record_id = r.id AND v.attribute_id = $a AND ‹pred›)`
unless the table says otherwise.

| Type | Operator | `‹pred›` (or full fragment) | Index |
|---|---|---|---|
| `short_text` | contains | `v.text_norm LIKE '%'\|\|esc($q)\|\|'%'` | `av_trgm_idx` |
| | equals | `v.text_sort = left($q,256) AND v.text_norm = $q` | `av_attr_text_idx` (+ exact recheck) |
| | is empty | `NOT EXISTS (… v.attribute_id = $a)` | `av_attr_rec_idx` |
| `long_text` | contains | `v.text_norm LIKE '%'\|\|esc($q)\|\|'%'` | `av_trgm_idx` |
| | is empty | `NOT EXISTS (…)` | `av_attr_rec_idx` |
| `number` | = | `v.num_value = $n::numeric` | `av_attr_num_idx` |
| | ≠ | `v.num_value <> $n::numeric` *(= "has a value and it differs", §3.4)* | `av_attr_num_idx` |
| | < / > | `v.num_value < $n::numeric` | `av_attr_num_idx` |
| | between | `v.num_value BETWEEN $lo::numeric AND $hi::numeric` | `av_attr_num_idx` |
| | is empty | `NOT EXISTS (…)` | `av_attr_rec_idx` |
| `date` | before / after | `v.date_value < $d::date` / `> $d::date` | `av_attr_date_idx` |
| | between | `v.date_value BETWEEN $lo::date AND $hi::date` | `av_attr_date_idx` |
| | relative (last 30 days, this year) | resolved to absolute bounds **in `packages/core`** using the profile timezone, then `between`; the chip shows the resolved dates | `av_attr_date_idx` |
| | is empty | `NOT EXISTS (…)` | `av_attr_rec_idx` |
| `yes_no` | is yes | `v.bool_value` | `av_attr_bool_idx` |
| | is no | `NOT v.bool_value` | `av_attr_bool_idx` |
| | is empty | `NOT EXISTS (…)` | `av_attr_rec_idx` |
| `single_select` | is one of | `v.option_id = ANY($ids::uuid[])` | `av_attr_opt_idx` |
| | is not one of | `NOT EXISTS (… AND v.option_id = ANY($ids::uuid[]))` *(includes empties, §3.4)* | `av_attr_opt_idx` |
| | is empty | `NOT EXISTS (…)` | `av_attr_rec_idx` |
| `multi_select` | contains any of | `v.option_id = ANY($ids::uuid[])` | `av_attr_opt_idx` |
| | contains all of | `(SELECT count(DISTINCT v2.option_id) FROM attribute_value v2 WHERE v2.record_id=r.id AND v2.attribute_id=$a AND v2.option_id = ANY($ids::uuid[])) = cardinality($ids::uuid[])` | `av_attr_opt_idx` |
| | is empty | `NOT EXISTS (…)` | `av_attr_rec_idx` |
| `tags` | contains any of | `v.value_key = ANY($keys::text[])` | `av_attr_key_idx` |
| | is empty | `NOT EXISTS (…)` | `av_attr_rec_idx` |
| `url` | contains / is empty | as `short_text` | `av_trgm_idx` / `av_attr_rec_idx` |
| `email` | contains / is empty | as `short_text` | `av_trgm_idx` / `av_attr_rec_idx` |
| `phone` | contains / is empty | as `short_text` (value is E.164, so a `+49` prefix search works) | `av_trgm_idx` / `av_attr_rec_idx` |
| `relation` | has any of | `EXISTS (SELECT 1 FROM record_link l WHERE l.from_record_id = r.id AND l.attribute_id = $a AND l.to_record_id = ANY($ids::uuid[]))` | `rl_uq` |
| | is empty | `NOT EXISTS (SELECT 1 FROM record_link l WHERE l.from_record_id = r.id AND l.attribute_id = $a)` | `rl_uq` |
| **derived** `last_interaction_at` | more/less than N days ago, between, is empty | `m.last_interaction_at < now() - ($n \|\| ' days')::interval` | `cm_last_idx` |
| **derived** `interaction_count_12m` | =, ≠, <, >, between | `m.interaction_count_12m > $n` | `cm_count_idx` |
| **derived** `open_followups` | =, >, is zero | `m.open_followups > $n` | `cm_open_idx` |
| **derived** `warmth` | =, ≠, <, >, between | `m.warmth BETWEEN $lo AND $hi` | `cm_warm_idx` |
| **derived** `people_count` (org) | =, <, >, between | `om.people_count > $n` | `om_people_idx` |
| **system** `created_at`, `display_name`, `provenance.import_batch_id` | per type | plain predicates on `record` / `contact` | `record_list_idx`, `contact_name_sort_idx`, `record_batch_idx` |

**The table search box (§5.2 "quick substring search over visible text columns")** compiles to a
*single* `EXISTS` with an attribute-id array, not an `OR` of one `EXISTS` per column — an `OR` between
semi-joins defeats the pull-up and degrades to a sequential scan:

```sql
AND (r.display_label ILIKE '%' || esc($q) || '%'
     OR EXISTS (SELECT 1 FROM attribute_value v
                 WHERE v.record_id = r.id
                   AND v.attribute_id = ANY($visible_text_attrs::uuid[])
                   AND v.text_norm LIKE '%' || esc($q) || '%'))
```

The compiler is a pure function `(AttributeDefinition, Operator, Value[]) → SqlFragment` over a closed
set of eight slot literals — 12 types × ~4 operators ≈ 45 cases, exhaustively unit-testable without a
database plus a golden-file test of the emitted SQL string. That is precisely the "filter → query
compilation" §8.1 singles out for high coverage.

### 5.4 Plan stability, honestly

Q1 uses 4 base relations (`record`, `contact`, `contact_metrics`, the sort join) plus **one pulled-up
semi-join per filter chip**. With Postgres 16's defaults (`join_collapse_limit` = 8,
`geqo_threshold` = 12) that means the planner stops exhaustively reordering at roughly **5 chips** and
hands over to the genetic optimiser — non-deterministic plans — at roughly **9**. Raising the GUCs to
16/16/20 on the connection (§2.10) moves those to ~12 and ~17, which is past any realistic filter bar.

Above that, the documented fallback is a **grouped-scan compilation**:

```sql
r.id IN (SELECT record_id FROM attribute_value
          WHERE (attribute_id = $1 AND option_id = ANY($2))
             OR (attribute_id = $3 AND text_norm LIKE $4)
             OR (attribute_id = $5 AND value_key  = ANY($6))
          GROUP BY record_id HAVING count(DISTINCT attribute_id) = 3)
```

which is O(1) relations regardless of predicate count. It cannot express `is empty` (a `NOT EXISTS`),
so the compiler would need two strategies — genuine added complexity that is **not** being built now.
It is written down here so the person who needs it does not have to rediscover it.

### 5.5 Q2 — hydrate the 50 visible rows, one round trip, no N+1

```sql
SELECT v.record_id, d.slug, d.type,
       jsonb_agg(
         jsonb_strip_nulls(jsonb_build_object(
           'text',   v.text_value,
           'number', v.num_value,
           'date',   v.date_value,
           'bool',   v.bool_value,
           'option', v.option_id,
           'label',  o.label,
           'color',  o.color
         )) ORDER BY v.position) AS values
  FROM attribute_value v
  JOIN attribute_definition d ON d.id = v.attribute_id
  LEFT JOIN attribute_option o ON o.id = v.option_id
 WHERE v.record_id = ANY($1::uuid[])
 GROUP BY v.record_id, d.slug, d.type;
```

50 records × ~15 attributes ≈ 750 rows through `av_record_attr_uq`. Sub-millisecond. Relation columns
come from one parallel query over `rl_uq` joined to `record` for chip labels. **JSONB appears here, at
the API boundary, as a wire format — not as storage.** This query is the honest cost of not keeping a
`current_values` column, and it is a query written once.

### 5.6 Contact detail page, value history, bidirectional relations

```sql
-- (1) the record + derived metrics
SELECT r.*, c.*, m.* FROM record r JOIN contact c ON c.id = r.id
  LEFT JOIN contact_metrics m ON m.contact_id = r.id WHERE r.id = $1;

-- (2) every attribute value, including long_text — no seam, no second path
SELECT d.slug, d.type, d.group_name, v.* FROM attribute_value v
  JOIN attribute_definition d ON d.id = v.attribute_id
 WHERE v.record_id = $1 ORDER BY d.position, v.position;         -- av_record_attr_uq

-- (3) §4.5 value history for the hover card
SELECT f.id,
       coalesce(f.text_value, f.num_value::text, f.date_value::text, f.bool_value::text,
                o.label, tr.display_label)                       AS display_value,
       f.valid_from, f.observed_at, f.source, f.source_ref, f.confidence,
       f.removed_at,
       (f.superseded_by_id IS NULL AND f.removed_at IS NULL)      AS is_current
  FROM fact f
  LEFT JOIN attribute_option o ON o.id = f.option_id
  LEFT JOIN record tr          ON tr.id = f.target_record_id
 WHERE f.record_id = $1 AND f.attribute_id = $2
 ORDER BY f.valid_from DESC, f.observed_at DESC;                 -- fact_history_idx

-- (4) §6.5 Connections: work history, current first, reads as a CV
SELECT org.id, og.name, l.title, l.valid_from, l.valid_to, l.is_primary
  FROM record_link l JOIN record org ON org.id = l.to_record_id
  JOIN organization og ON og.id = org.id
 WHERE l.from_record_id = $1 AND l.attribute_id = $2
 ORDER BY l.is_primary DESC, (l.valid_to IS NULL) DESC, l.valid_from DESC NULLS LAST;  -- rl_current_idx

-- (5) the reverse direction — the organization's People tab — is the same rows read the other way,
--     which is what makes §4.3's "all relations are bidirectional" free rather than a second write
SELECT c.id, c.display_name, l.title, l.valid_from, l.valid_to
  FROM record_link l JOIN contact c ON c.id = l.from_record_id
 WHERE l.to_record_id = $1 AND l.attribute_id = $2
 ORDER BY (l.valid_to IS NULL) DESC, c.display_name;             -- rl_reverse_idx

-- (6) §6.5c "also at the same organization"
SELECT DISTINCT c2.id, c2.display_name
  FROM record_link mine
  JOIN record_link theirs ON theirs.to_record_id = mine.to_record_id
                         AND theirs.from_record_id <> mine.from_record_id
                         AND theirs.valid_to IS NULL
  JOIN contact c2 ON c2.id = theirs.from_record_id
 WHERE mine.from_record_id = $1 AND mine.valid_to IS NULL;       -- rl_same_org_idx
```

### 5.7 Global search (§4.8) — the ⌘K palette

Two mechanisms, deliberately: **trigram** for the "type three letters of a name" substring behaviour
the brief actually asks for, **tsvector** for word search over interaction bodies and custom text
attributes.

```sql
(SELECT 'record' AS kind, r.id, r.object_type, r.display_label AS label,
        similarity(lower(r.display_label), $1) AS score
   FROM record r
  WHERE r.workspace_id = $ws AND lower(r.display_label) % $1
  ORDER BY score DESC LIMIT 8)
UNION ALL
(SELECT 'identifier', r.id, r.object_type, r.display_label, 1.0
   FROM identifier i JOIN record r ON r.id = i.record_id
  WHERE i.workspace_id = $ws AND i.value LIKE lower($1) || '%' LIMIT 5)
UNION ALL
(SELECT 'search', d.record_id, d.object_type, d.title,
        ts_rank(d.tsv, websearch_to_tsquery('simple', $1))
   FROM search_document d
  WHERE d.workspace_id = $ws AND d.tsv @@ websearch_to_tsquery('simple', $1)
  ORDER BY 5 DESC LIMIT 8);
```

`gin_trgm_ops` needs **three characters** to extract a trigram; a 1–2 character pattern degenerates to
a full index scan. At this size that is still fast, but the palette should not fire until the second
keystroke and the substring path should not fire until the third.

### 5.8 Duplicate detection (§4.6, §6.8) — identifiers first, names never first

```sql
-- 1. certain: a shared identifier. One unique-index probe.
SELECT record_id FROM identifier WHERE workspace_id = $ws AND kind = $kind AND value = $value;

-- 2. fallback only: normalised name similarity + shared current organization
SELECT r.id, similarity(lower(r.display_label), lower($name)) AS name_sim
  FROM record r
 WHERE r.workspace_id = $ws AND r.object_type = 'contact'
   AND lower(r.display_label) % lower($name)
   AND EXISTS (SELECT 1 FROM record_link l
                WHERE l.from_record_id = r.id AND l.to_record_id = $org_id AND l.valid_to IS NULL)
 ORDER BY name_sim DESC LIMIT 5;
```

---

## 6. Typed sorting, per type, made correct

Sorting is where dynamic-attribute designs quietly produce wrong answers ("10" before "9"). Here every
sort key is a **native Postgres type in a real column**, so ordering is correct by construction rather
than by encoding discipline.

Every sort is `ORDER BY ‹key› ‹dir› NULLS LAST, r.id ‹dir›`. `NULLS LAST` in **both** directions, so
"empty" always sorts to the bottom regardless of direction and the plan shape does not change between
ascending and descending. `r.id` is the tiebreaker, which makes the order total and pagination stable.

### 6.1 Numbers and dates

`num_value numeric` and `date_value date`. No cast, no extractor function, no encoding scheme. `9`
sorts before `10`; `1988-03-12` sorts before `1990-01-01`. This is the single thing a JSONB projection
cannot give without either a hand-rolled immutable date parser or a zero-padded/offset-encoded decimal
string per numeric attribute.

### 6.2 Text (`short_text`, `email`)

`ORDER BY v.text_sort` — `left(lower(unaccent(btrim(value))), 256) COLLATE "C"`. Three properties worth
naming:

- **Case- and accent-insensitive**, because normalisation happened on write. "Ärztin" sorts next to
  "Arztin", which is what a person expects in a contact list.
- **`COLLATE "C"` is deterministic and portable.** The value is already lower-cased ASCII-folded, so
  byte order reads correctly for latin scripts; comparisons are `memcmp` with working abbreviated keys;
  and the index cannot be silently corrupted by a glibc collation change across an OS upgrade — a real
  hazard for an open-source project a stranger runs on an arbitrary machine.
- **Non-latin scripts sort by codepoint.** Documented, accepted for Phase 1. The fix, if wanted, is an
  ICU collation on `text_sort` — a one-column, one-index migration.

### 6.3 `yes_no` — "yes first"

`ORDER BY v.bool_value DESC NULLS LAST` → true, false, empty. Exactly §4.2's "yes first".

### 6.4 `single_select` — by option order, not alphabetically

```sql
LEFT JOIN attribute_value  sv ON sv.record_id = r.id AND sv.attribute_id = $sort_attr AND sv.value_key = ''
LEFT JOIN attribute_option so ON so.id = sv.option_id
ORDER BY so.position ASC NULLS LAST, r.id
```

A hash join against a ≤200-row, permanently cached table, then the same sort that would happen anyway.
This is why `option_pos` was dropped (§1.6): the denormalisation saves the join but not the sort, and
it costs a bulk write on every option reorder plus a resync obligation the projector must never forget.
`array_position($1::text[], …)` — a per-row function call over a parameter array — was also rejected:
it is not index-backed *and* not join-free, so it is strictly worse.

### 6.5 Non-sortable types

`long_text`, `multi_select`, `tags`, `url`, `phone`, `relation` — the brief gives them no sort ("—" in
§4.2). The attribute definition exposes `sortable: false`, the DataTable renders a non-clickable
header, and the API returns 400 for a sort request on them. **Explicit refusal, not a silent fallback
to insertion order.**

### 6.6 Pagination

- **Default sort** (`created_at DESC, id DESC`) uses **keyset** pagination against
  `record_list_idx (object_type, created_at DESC, id DESC)`: `WHERE (r.created_at, r.id) < ($ts, $id)`.
  Constant cost per page, which is what a virtualised 10k-row table wants.
- **Custom-attribute sorts** use `LIMIT/OFFSET`, wrapped in an opaque cursor at the API boundary. Honest
  limit: `OFFSET 5000` re-sorts the whole matching set. At 10k rows that is tens of milliseconds; at
  1M it is not. Because the cursor is opaque, switching to keyset over `(sort_key, id)` — which needs
  fiddly three-valued NULL handling in a row comparison — is a server-side change with no API or UI
  impact. Not built now: "never over-engineer".

---

## 7. Derived columns

`last_interaction_at`, `interaction_count_12m`, `open_followups`, `next_followup_at` and `warmth` are
**materialised** as real typed columns in `contact_metrics`, with plain btree indexes. §5.2 requires
them to be filterable and sortable like any other column, which means a real index, which means stored.

They are deliberately **not** attributes and **not** facts: they have no provenance, no history, no
confidence, and they are recomputed wholesale. Putting them in the attribute system would mean the
nightly warmth pass writing 10k facts a night into an append-only audit log — absurd.

### 7.1 One implementation, in TypeScript

§4.7 requires warmth to be *"a pure function in `packages/core` with unit tests"*. So it is, and it is
the **only** implementation — there is no second SQL version to drift from it. The nightly job is:

1. One query returning per-contact interaction aggregates (~10k rows):
   ```sql
   SELECT ic.contact_id, i.type, i.occurred_at
     FROM interaction_contact ic JOIN interaction i ON i.id = ic.interaction_id
    WHERE i.occurred_at > now() - interval '365 days';
   ```
2. `computeWarmth(interactions, overrides)` in `packages/core`.
3. One write-back: `UPDATE contact_metrics m SET … FROM (VALUES …) AS t(...) WHERE m.contact_id = t.id`,
   batched at 1000 rows.

At 10k contacts the whole sweep is well under a second. Rejecting the set-based SQL version is a
deliberate trade of a few hundred milliseconds for "one implementation, unit-tested, matching the
brief".

The constant `k`: monthly meetings over 365 days give
`signal = Σ_{n=0..12} 3.0·e^(−30n/90) = 3.0 · (1−e^(−13/3))/(1−e^(−1/3)) ≈ 10.445`, and
`warmth = 75` requires `e^(−k·10.445) = 0.25`, so **`k = ln 4 / 10.445 ≈ 0.1327`**. A unit test asserts
`computeWarmth(monthlyMeetingsForAYear) ∈ [74, 76]`, so the calibration cannot silently drift.

Overrides are applied last, from the real boolean columns on `contact`:
`warmth = min(not_important ? 10 : 100, max(pinned_important ? 60 : 0, raw))`.

### 7.2 Freshness policy

| Metric | When |
|---|---|
| `last_interaction_at`, `interaction_count_12m` | recomputed for the affected contacts **in the same transaction** as an interaction write (an interaction touches a handful of contacts) — always correct on write |
| `open_followups`, `next_followup_at` | same, on follow-up write |
| `warmth` | full nightly sweep via pg-boss, plus on-demand for the touched contacts after an interaction write |
| `organization_metrics.people_count` | recomputed for the affected organization in the same transaction as a `record_link` change |

Warmth is therefore stale by at most 24 h of exponential decay on a 90-day time constant — about 1 %,
invisible in a 0–100 score. A newly created contact gets a `contact_metrics` row in the same
transaction as the contact, so the row always exists. **Every list query still uses `LEFT JOIN
contact_metrics`, not `JOIN`** — an inner join would make any contact whose metrics row is missing
(a failed sweep, a partially completed import) invisible to every list in the product.

### 7.3 In the filter model

Derived columns are declared in `packages/core` beside the system attributes as pseudo attribute
definitions (`is_derived: true`, `source: 'metrics.warmth'`, `sortable: true`, plus their own operator
set), so they appear in the Columns picker and the filter picker like any other attribute. The compiler
has **three resolvers behind one interface** — `system column | metric column | attribute` — and the
API and the DataTable never know the difference. That is exactly what §5.2 asks for.

---

## 8. Search now, vectors later, one database

- **`tsvector` lives in `search_document.tsv`**, a `STORED` generated column over
  `setweight(to_tsvector('simple', title),'A') || setweight(to_tsvector('simple', body),'B')`. It is
  rebuilt by the projector (step 4 of §4.5), so **every custom string attribute is full-text
  searchable the moment it is populated**, with no schema change and no code change.
- **`pgvector` lives in `search_document.embedding vector(1536)`**, nullable, present from Stage 1 so
  the `search` API's `mode` parameter (`keyword` now, `semantic` later) has somewhere to point. The
  HNSW index is created **after** the first backfill, not on an empty column. Filtered semantic search
  reuses the same filter compiler — filter in SQL, then `SET LOCAL hnsw.iterative_scan =
  'relaxed_order'` so pgvector iterates instead of returning fewer rows than `LIMIT`.
- Both live in the same table as the search body, on rows that the contacts list never scans, so a
  6 kB vector cannot halve the heap density of the hot path.
- Nothing in this design changes when embeddings arrive. That is the test of the extension point.

---

## 9. The honest limits, with numbers

**Every latency figure below is an extrapolation from plan shapes, not a measurement.** There is no
Postgres in the environment where this was written. **Stage 1 must seed 10k contacts × 60 attributes
and record real `EXPLAIN (ANALYZE, BUFFERS)` output for each operator in §5.3 into
`docs/ARCHITECTURE.md`.** Until that runs, treat this table as hypotheses. It is also the single
biggest gap in the evidence base for this decision, and it was the same gap in all three proposals.

### 9.1 Sizing at the brief's scale

| | Rows | Heap | Indexes |
|---|---|---|---|
| `attribute_value` (10k contacts × 15 values) | 150k | ~27 MB | ~45 MB (9 indexes, 6 partial) |
| `fact` (with history, ~1.3× live) | ~200k | ~40 MB | ~25 MB |
| `record` + `contact` + `contact_metrics` | 10k each | ~4 MB | ~3 MB |
| `search_document` | 10k | ~15 MB | ~10 MB |
| **Total attribute store** | | | **~140 MB** — OS page cache, always warm |

### 9.2 Expected latency (extrapolated)

| Operation | Estimate |
|---|---|
| Q1: 3 filter chips + sort on a custom number, page 1 | 3–10 ms |
| Q1: no filters, sort on a custom number (worst realistic case: full 10k sort of 40-byte tuples) | 10–25 ms |
| Q2: hydrate 50 rows | < 2 ms |
| Q3: count with 3 chips | 3–10 ms |
| Contact detail page (3 queries) | < 5 ms |
| ⌘K palette, ≥3 characters | 2–8 ms |
| Write one attribute value (5 statements + projection) | 1–3 ms |
| 10k-row LinkedIn import, set-based path | 8–20 s (index-maintenance bound) |
| Nightly metrics sweep, 10k contacts | < 1 s |
| `pnpm db:reproject`, full rebuild | 5–15 s |

### 9.3 Where it degrades, and what the fix is

| Dimension | Comfortable | Degrades | Breaks | Fix when it does |
|---|---|---|---|---|
| Records per object type | ≤ 100k (~2M value rows) | 100k–500k *matching* rows: the sort of a lightly-filtered set moves from ms to hundreds of ms | > 500k: planner mis-estimation on the heterogeneous `attribute_value` starts producing unpredictably bad plans | Two-phase index-ordered pagination (§9.4) — a **query** change; then partition `attribute_value` by `value_kind` for real per-partition statistics — a schema change, not a data-model change |
| Simultaneous filter chips | ≤ 12 (with the raised GUCs) | 12–17: planning cost grows | > 17: GEQO, non-deterministic plans | Grouped-scan compilation (§5.4) |
| Populated attributes per record | ≤ 100 | 100–300: hydration row count grows linearly | > 300: Q2 becomes the page's cost | Restrict the view's visible columns in Q2 (already supported by the API) |
| Attribute definitions | **unbounded** — no per-attribute index, no per-attribute DDL | — | — | this is the axis the design was chosen for |
| Writes per second, same record | ≤ 200 | 200–1000: serialises on the `FOR UPDATE` row lock | > 1000 | debounced async projection; `attribute_value` becomes eventually consistent and the UI must cope |
| Bulk import size | ≤ 50k rows | 50k–200k: minutes | > 200k | drop and rebuild `av_trgm_idx` around the batch (`CREATE INDEX CONCURRENTLY`) |
| Deep pagination | `OFFSET` ≤ 2000 | 2000–20000: linear degradation | beyond | keyset over `(sort_key, id)`; opaque cursor means no API change |
| `contains` pattern length | ≥ 3 chars | 1–2 chars: full trigram index scan (~15 ms here) | unbounded at 100× scale | UI gates substring search at 3 characters |
| pgvector dimensions | ≤ 2000 (`vector`) / ≤ 4000 (`halfvec`) | — | > 4000: no index possible at all | `halfvec`, or dimension reduction; **write this into `ARCHITECTURE.md` in Stage 1** |

### 9.4 The documented escape hatch above ~100k matching rows

Sort-by-custom-attribute inverts: drive from `av_attr_num_idx` (or `_date`, `_text`) in index order
(`WHERE attribute_id = $sort ORDER BY num_value DESC, record_id DESC`), apply the remaining filters as
semi-joins, stop at `LIMIT`, then append the value-less tail (`NOT EXISTS` for that attribute, ordered
by id) in a second pass. **No schema change** — the typed index table is exactly what makes this
possible, and it is the reason the typed table exists rather than a jsonb expression index.

### 9.5 Accepted weaknesses, named

1. **Row-count amplification is ~15×.** 10k contacts become 150k value rows. Every `VACUUM`, every
   index rebuild, every aggregate over values touches 15× more tuples. Fine at this volume; wrong for
   a write-heavy system.
2. **Write amplification is ~3–4×.** One user edit = one fact insert + one supersede update + one
   `attribute_value` upsert + a `search_document` rebuild + possibly a metrics recompute. Plus **one
   composite-FK parent probe per fact and per value row** (a `KEY SHARE` lock on the definition row) —
   ~300k extra probes on a 10k × 15 import, against a tiny cached table. Priced into the 8–20 s
   estimate; must be verified in Stage 1.
3. **The planner is blind to per-attribute statistics.** `attribute_value` is one heterogeneous table,
   so `text_norm LIKE '%munich%'` is estimated identically whether the attribute is `city` (very
   selective) or `notes` (not), and extended statistics do not fix `LIKE` selectivity. This is the one
   thing per-attribute expression indexes genuinely do better, and it will occasionally produce a plan
   5× slower than the best one with no obvious cause. At 10k rows the *worst* plan is still ~25 ms.
4. **Every query is longer.** Q1 is ~35 lines where a JSONB equivalent is ~12. The verbosity is
   confined to one ~300-line compiler and never hand-written, but it is the first thing a new
   open-source contributor will complain about.
5. **`ORDER BY` on a custom attribute is a full sort of the filtered set**, not an index-ordered scan.
   Accepted to ~100k matching rows; §9.4 is the fix.
6. **Truncation is present but never load-bearing for correctness.** `text_sort` is capped at 256
   characters, so it is used for *sorting* and as the **indexed prefix** of an equality test that is
   always rechecked against full-length `text_norm`. Tag matching uses `value_key`, which is exact.
   There is no operator whose answer depends on the truncation.
7. **No cross-attribute or uniqueness constraints inside the attribute system.** "Email must be unique"
   lives in `identifier`; "if `job_role` = Investor then `fund_size` is required" cannot be expressed
   in the database at all. This is a limitation of *any* dynamic-attribute design, not of this one, and
   it is not being claimed as solved.
8. **The ORM cannot type user-defined attribute values.** Drizzle knows `attribute_value`, not
   `check_size`. Runtime typing comes from Zod schemas generated from `attribute_definition`. §3.2's
   "typed end-to-end" is true for the envelope, not for user attribute values — unavoidable in any
   dynamic design, but worth saying plainly rather than implying otherwise.
9. **Postgres lock-in is deep.** `NULLS NOT DISTINCT`, partial indexes, composite FKs to a non-PK
   unique target, `gin_trgm_ops`, `btree_gin`, `DISTINCT ON`, `num_nonnulls`, transition tables. The
   brief fixes Postgres 16, so this costs nothing now; it is real and should be stated.
10. **Concurrent multi-user editing of the same record is not addressed.** The fact log makes conflict
    *visible* (two facts, two sources, two confidences) but Phase 1 has no merge policy beyond "newest
    wins" and no optimistic-concurrency token on the API. First thing to design when §9's multi-user
    arrives.
11. **"Smooth at 10k rows" is mostly not a database problem.** The database never returns 10k rows —
    the API pages at 50 and the table virtualises. The load-bearing part is the API contract:
    server-side filter/sort/paginate behind an opaque cursor. A client that fetches 10k rows to filter
    in the browser defeats every word of this document.
12. **The `record` supertype costs a join everywhere.** A reviewer is entitled to ask whether two
    independent tables plus nullable FK pairs would have been more boring. The answer is that five
    polymorphic tables would then each need a two-column nullable-pair FK plus a CHECK, and the
    `relation` type would need two target columns — more machinery, not less.

### 9.6 The promotion escape hatch, in one paragraph

Because `fact` is the truth and `attribute_value` is derived, **promoting a hot attribute to a real
typed column on `contact` is a purely additive migration**: add `contact.city text`, backfill from
`attribute_value`, teach the column registry in `packages/core` that the slug `city` resolves to a
system column instead of an attribute, and the compiler emits `c.city ILIKE …` instead of an `EXISTS`.
No API change, no UI change, no data loss, no change to the fact log. That path — start generic,
promote the five attributes that matter when they matter — is exactly what "build what the current
stage needs, leave clean extension points" means here, and it is the honest answer to the co-founder's
inevitable "what happens at 100k rows".

---

## 10. Stage-1 definition of done for this decision

1. Migrations create every object in §2 and are reproducible from empty (`pnpm db:migrate` on a fresh
   database, asserted in CI).
2. `pnpm seed` produces ~200 contacts, ~60 organizations, ~500 interactions, ~40 follow-ups (§8.1).
3. `pnpm db:reproject` runs, and **CI asserts a full rebuild is byte-identical** after the fixture load
   *and* after the API mutation suite.
4. A **10k-contact × 60-attribute generator** exists, and `EXPLAIN (ANALYZE, BUFFERS)` output for each
   operator in §5.3 plus the three Q1 filter shapes is recorded in `docs/ARCHITECTURE.md`. Every number
   in §9.2 is either confirmed or corrected there.
5. **`EXPLAIN` regression assertions** per index shape: each of the nine `attribute_value` indexes is
   asserted to be chosen for its operator, and both sort directions are asserted to produce
   `NULLS LAST` without a spilled sort.
6. An integration test proves the §4.1 statement order never violates `fact_live_uq`, including two
   concurrent writers to the same record and attribute.
7. An integration test proves the §4.6 import path is idempotent: re-importing the same fixture creates
   no duplicate values and leaves exactly one live fact per single-valued attribute.
8. The filter compiler has ≥ 45 unit tests (12 types × operators) asserting the emitted SQL string and
   parameter array, with no database.
9. `computeWarmth` unit tests, including the `k` calibration assertion.
10. Migration 0002 fails loudly if `btree_gin` or `unaccent` is unavailable, with the documented
    fallback (single-column trigram GIN; drop `unaccent` from normalisation) recorded as an ADR.

---

## 11. Verified vs assumed

**Verified against Postgres 16 documentation, or verified during the judging pass:**

- GIN on `jsonb` (`jsonb_ops` / `jsonb_path_ops`) supports `@>`, `?`, `?|`, `?&`, `@?`, `@@` only — no
  range and no ordering support; the docs point at expression indexes for derived values. This is the
  factual basis for rejecting pure JSONB.
- Index expressions must be `IMMUTABLE`; `text → date`/`timestamp` casts are **not** (they depend on
  `DateStyle`), so `CREATE INDEX ON t (((j->>'d')::date))` is rejected outright.
- `to_tsvector(regconfig, …)` is `IMMUTABLE`; the one-argument form is only `STABLE` and cannot appear
  in a generated column or index. Queries must use the identical two-argument form to hit the index.
- Postgres 16 implements **stored** generated columns only; the expression must be immutable, may not
  use subqueries, and may not reference other rows or generated columns.
- `UNIQUE [NULLS [NOT] DISTINCT]` exists since Postgres 15: "null values are not considered equal,
  unless `NULLS NOT DISTINCT` is specified."
- Planner defaults: `from_collapse_limit` = 8, `join_collapse_limit` = 8, `geqo_threshold` = 12.
- `num_nonnulls(VARIADIC "any") → integer` is a built-in.
- A btree index tuple is capped at roughly one third of a page (~2704 bytes on the default 8 kB page);
  exceeding it raises an error at insert time, not at index-creation time.
- A **partial** unique index cannot be `DEFERRABLE` (only a full `UNIQUE`/`EXCLUDE` *constraint* can),
  and `CREATE UNIQUE INDEX` has no `DEFERRABLE` clause at all. This is why §4.1 relies on statement
  ordering, and why `ao_pos_uq` is a non-partial `UNIQUE` constraint.
- All `WITH` sub-statements and the outer query execute under **one snapshot and one command id**, so a
  function or `ON CONFLICT` in one part cannot see a sibling CTE's writes. This is why the write path
  and the projector are sequences of statements, not one big CTE.
- `btree_gin` ships a `uuid` operator class on Postgres 16, making a multicolumn
  `gin (attribute_id, text_norm gin_trgm_ops)` legal. *(Verified during the judging pass; migration
  0002 re-verifies it at runtime with a documented fallback.)*
- `gin_trgm_ops` supports `LIKE`/`ILIKE` without left anchoring; "a pattern with no extractable
  trigrams will degenerate to a full-index scan".
- pgvector: `vector` accepts up to 16000 dimensions, but **HNSW and IVFFlat support at most 2000 for
  `vector` and 4000 for `halfvec`**; HNSW defaults `m = 16, ef_construction = 64`; 0.8 added
  `hnsw.iterative_scan` for filtered queries. Pin ≥ 0.8.2.
- Supabase offers `pg_trgm`, `vector`, `unaccent` and `btree_gin` as installable extensions, so this
  schema is portable to the deployed instance with no Supabase-specific features.

**Assumed, and to be proven in Stage 1 (each has a stated fallback):**

- **`unaccent(text)` is `STABLE` rather than `IMMUTABLE`.** The design does not depend on it either
  way, because `text_norm` is a written column, not a generated column or index expression. If
  `unaccent` is unavailable, drop it from the normalisation expression; only accent-insensitivity is
  lost.
- **drizzle-kit 0.31.x coverage** of composite FKs to a `UNIQUE (id, value_kind, is_multi)` target,
  `NULLS NOT DISTINCT`, partial indexes, multicolumn GIN with a non-default opclass, functions and
  triggers. Anything it cannot express is a hand-authored SQL migration under drizzle-kit's numbering
  — §3.2's "versioned, in the repo, reproducible" holds either way. Drizzle 0.45.x is a v0 line; the
  v1.0.0-beta stream is a known future cost, not a surprise.
- **`LEFT JOIN attribute_value` for the sort key produces the same plan quality as
  `LEFT JOIN LATERAL … LIMIT 1`.** The unique index guarantees at most one row, so it should be
  strictly better (more join-order freedom). To be confirmed by the Stage-1 `EXPLAIN` suite; the
  lateral is the fallback.
- **`AFTER … FOR EACH STATEMENT` triggers with transition tables behave acceptably under `COPY`.** The
  bulk path bypasses the trigger via the session GUC precisely so this never matters, but the Stage-1
  test should confirm the GUC bypass works and that a forgotten bypass is caught by the reproject
  assertion rather than by a user.
- **Every latency number in §9.2 and every threshold in §9.3.** Extrapolations from index shapes. This
  is the largest remaining unknown, and §10 items 4 and 5 exist to close it.

---

## 12. ADRs to write into `docs/DECISIONS.md`

1. Typed EAV projection over an append-only fact log; no `current_values jsonb`; no runtime DDL.
2. `workspace_id` nullable per §9 but always populated; `NULLS NOT DISTINCT` on every unique
   constraint that carries it; not an index key in Phase 1.
3. `record` supertype for polymorphic referential integrity; `interaction` is a subtype from day one.
4. Hard delete, not soft delete (no `deleted_at`).
5. `number ≠ x` excludes empty; `single_select is not one of` includes empty.
6. `is empty` means "no live value row", for all twelve types, with `CHECK (text_value <> '')`.
7. `valid_from` is stored and displayed but does not gate currency in Phase 1.
8. `option_pos` denormalisation rejected; `single_select` sort joins `attribute_option`.
9. Select options are archived, never hard-deleted while in use; `option_id` FKs are `RESTRICT`.
10. `to_tsvector('simple', …)`, not `'english'` — a multilingual address book of proper nouns.
11. `text_sort` truncated to 256 and `COLLATE "C"`; equality always rechecked against `text_norm`.
12. Warmth has exactly one implementation, in `packages/core`, with `k = 0.1327` and a calibration test.
13. Row count is a separate cached query, never `count(*) OVER ()`; pagination uses an opaque cursor.
14. The "Ask the network" LLM filter grammar is AND-only, and the "How I searched" panel says so.
15. `join_collapse_limit`/`from_collapse_limit` = 16, `geqo_threshold` = 20 on every connection.
