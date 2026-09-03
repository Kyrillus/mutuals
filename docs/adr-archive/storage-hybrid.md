# Storage design: fact log + materialised read model + typed index table

**Scope:** §4.2 (dynamic attributes), §4.3 (relations with link metadata), §4.5 (fact log),
§4.6 (identifiers), §4.7 (warmth / derived columns), §4.8 (search), §9 (nullable `workspace_id`).
**Target:** Postgres 16 + `pgvector` + `pg_trgm`, portable to Supabase-as-managed-Postgres.

---

## 0. The thesis in one paragraph

Three representations of the same value, each doing exactly one job, all derived from one truth:

| Layer | Table | Job | Never used for |
|---|---|---|---|
| **Truth** | `fact` (append-only) | history, provenance, conflict, merge, rebuild | reads on the hot path |
| **Projection** | `contact.current_values jsonb` | *what you SELECT* — one row renders one table row | `WHERE`, `ORDER BY` |
| **Index** | `attribute_value` (normalised, typed columns) | *what you WHERE and ORDER BY* | the SELECT list |

The discipline is the design. `current_values` is **not** a queryable JSONB store with GIN indexes —
it is a serialisation cache, and it carries no index at all in Phase 1. `attribute_value` is **not** a
read model — a page never pivots it. Facts are never read to render a table.

Everything except `fact` is **derivable**. `pnpm db:reproject` rebuilds `attribute_value`,
`current_values`, `record_link` and `search_document` from `fact` + attribute definitions.
That single property is what makes it safe to keep three copies: a projector bug is a rebuild,
not a data-loss incident.

---

## 1. Why not the two pure options

I want to state the alternatives fairly, because the hybrid is only worth its cost if the pure
options genuinely fail.

### 1.1 Pure JSONB + GIN on `current_values`

**What it does well.** `@>` containment on `jsonb_path_ops` GIN is excellent and cheap: it answers
`tags contains any of`, `multi_select contains any of/all of`, `single_select is one of`,
`relation has any of` and key-existence (`is empty`) with one small index that covers *every*
attribute at once and needs **zero DDL when a user creates an attribute**. For a personal CRM,
that covers maybe half the operator matrix.

**Where it breaks, concretely.**

1. **Typed range and typed sort need one expression index per attribute** —
   `CREATE INDEX ON contact (((current_values->>'arr')::numeric))`. That is DDL executed in
   response to a user clicking "Create attribute". It needs `CREATE INDEX CONCURRENTLY` (so: outside
   a transaction, with a failure/`INVALID` index cleanup path), it desynchronises the schema from
   the versioned migrations the brief demands (§3.2 "migrations must be versioned, in the repo and
   reproducible"), and it means the schema of a user's database is a function of their click history.
2. **Date attributes cannot be indexed this way at all.** Verified: index expressions must be
   `IMMUTABLE`, and `text → date/timestamp` conversion is not, because it depends on `DateStyle`
   (and `TimeZone`, and accepts `'now'`/`'today'`). `CREATE INDEX ON t (((j->>'d')::date))` is
   rejected outright. The workaround is to index the raw text and rely on ISO-8601 sorting
   lexicographically — which does work for `date`, and I'll grant that.
3. **…but the same trick fails for `number`.** Text ordering puts `"10"` before `"9"`. You'd need a
   zero-padded/offset-encoded decimal string per numeric attribute — a homegrown encoding that has
   to be right for negatives and decimals, and that makes `between` unreadable.
4. **GIN cannot serve `ORDER BY`.** Every sort falls back to a full sort of the filtered set,
   *and* to a `->>` extraction plus cast per row.
5. **`single_select` sorts by option order,** which is not a property of the value at all — it's a
   property of the definition. A JSONB-only design has to join the option table to sort, killing any
   index-ordered scan.

The result of pushing pure JSONB hard is: a per-attribute DDL machine, plus a bespoke encoding
scheme, plus a sort that can never use an index. That is more machinery than the hybrid, not less.

### 1.2 Pure EAV (`attribute_value` only, no `current_values`)

Filtering and sorting are excellent — that's the half I keep. The failure is on **reads**.

Rendering a 50-row page with 20 visible columns means 1 000 narrow rows that must be pivoted, either
by `crosstab`/conditional aggregation in SQL (schema known only at runtime → dynamic SQL with one
`FILTER` clause per column) or in application code. The contact detail page needs *all* attributes,
so it's a second fan-out. The API then has to rebuild JSON that was already JSON. This is the classic
EAV read tax, and it is real: it turns a single sequential fetch into a wide join plus a pivot on
every list request, and it makes the API's serialisation layer the hottest code in the app.

`current_values` deletes that tax for one `jsonb` column per row.

### 1.3 The one option that is genuinely faster, and why I still reject it

`ALTER TABLE contact ADD COLUMN` per user attribute gives the planner real per-column statistics,
real btree indexes, and index-ordered sorts. At 1M rows it beats everything here. It is rejected
because: DDL on user action (worse than 1.1 — it takes an `ACCESS EXCLUSIVE` lock and rewrites
nothing but blocks everything), the 1 600-column limit, no natural home for the fact log or for
multi-valued attributes, and a delete-attribute flow that is a table rewrite. It is the right answer
for a product with 20 fixed columns and the wrong answer for one whose selling point is that
"nothing about the schema is hard-coded beyond a small core".

---

## 2. DDL

### 2.1 Extensions, enums, workspace

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- substring "contains" search
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector; column added in Phase 1, populated later

CREATE TYPE object_type     AS ENUM ('contact','organization','interaction','follow_up');
CREATE TYPE attribute_type  AS ENUM (
  'short_text','long_text','number','date','yes_no',
  'single_select','multi_select','tags','url','email','phone','relation');
-- which physical slot an attribute_type lands in. Derived from attribute_type in code,
-- stored here so the database can enforce it (see the composite FK in 2.4).
CREATE TYPE value_kind      AS ENUM ('text','number','date','bool','option','relation');
CREATE TYPE fact_source     AS ENUM ('manual','import','quick_capture','agent','gmail','calendar','crawler');
CREATE TYPE created_via     AS ENUM ('manual','import','api','agent');

-- §9: multi-tenancy stays possible. One row exists, seeded at migration time.
CREATE TABLE workspace (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

**Deliberate deviation from §9, to log in `docs/DECISIONS.md`:** the brief says
"every table gets a nullable `workspace_id` column now (always the single default workspace)".
The column is nullable as required, **but the application always populates it** with the seeded
default workspace id. Reason: if the column is really NULL everywhere, every predicate has to be
`IS NOT DISTINCT FROM $ws` (which cannot use a plain equality index well), and the day multi-tenancy
arrives you discover which query forgot the filter. Populating it means every query is `= $ws` from
day one, and the later migration is `SET NOT NULL` plus index rebuilds — no logic changes.

`workspace_id` is **not** part of any index key in Phase 1 (it would be a constant column in every
index, pure overhead). The documented multi-tenant migration is one pass of
`CREATE INDEX CONCURRENTLY` with `workspace_id` prepended, then drop the old indexes.

### 2.2 Core records

```sql
CREATE TABLE contact (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid REFERENCES workspace(id),          -- nullable per §9
  first_name      text,
  last_name       text,
  display_name    text NOT NULL,
  -- projection cache. attribute slug -> typed JSON. Never filtered on, never sorted on.
  current_values  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- §4.4 provenance
  created_via     created_via NOT NULL DEFAULT 'manual',
  import_batch_id uuid REFERENCES import_batch(id),
  last_enriched_at timestamptz,
  enriched_by     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX contact_ws_live   ON contact (workspace_id, id) WHERE deleted_at IS NULL;
CREATE INDEX contact_created   ON contact (created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX contact_name_sort ON contact (lower(display_name) COLLATE "C", id) WHERE deleted_at IS NULL;

-- organization is structurally identical (id, workspace_id, name, current_values, provenance…)
-- and is omitted here for length.
```

`current_values` shape — **ids only, no denormalised labels**:

```json
{
  "email": "anna@northstar.vc",
  "job_role": "opt_7f3…",
  "areas_of_interest": ["climate tech", "energy"],
  "birthday": "1988-04-02",
  "target_check_size": 250000,
  "organization": [{"id": "org_1a…", "title": "Partner", "from": "2021-03-01", "to": null, "is_primary": true}]
}
```

I considered denormalising option labels/colours and organization names into `current_values` so a
page needs literally one query. **Rejected**: renaming an option or an organization would then fan
out an `UPDATE` across every referencing record. Instead the API hydrates labels from an in-memory
cache of attribute definitions (tiny, fully cached) and resolves relation targets with one
`WHERE id = ANY($1)` per page — a handful of ids for a 50-row page. Renames stay O(1).

### 2.3 Attribute definitions and options

```sql
CREATE TABLE attribute_definition (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid REFERENCES workspace(id),
  object_type   object_type NOT NULL,
  title         text NOT NULL,
  slug          text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9_]{0,62}$'),
  type          attribute_type NOT NULL,
  value_kind    value_kind NOT NULL,      -- derived from type in code, enforced by CHECK below
  is_multi      boolean NOT NULL,         -- tags, multi_select, relation-many
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  group_name    text,
  description   text,
  is_system     boolean NOT NULL DEFAULT false,
  position      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT attr_kind_matches_type CHECK (
    (type IN ('short_text','long_text','url','email','phone') AND value_kind = 'text')
    OR (type = 'number'        AND value_kind = 'number')
    OR (type = 'date'          AND value_kind = 'date')
    OR (type = 'yes_no'        AND value_kind = 'bool')
    OR (type IN ('single_select','multi_select') AND value_kind = 'option')
    OR (type = 'tags'          AND value_kind = 'text')
    OR (type = 'relation'      AND value_kind = 'relation')),
  CONSTRAINT attr_multi_matches_type CHECK (
    (type IN ('tags','multi_select') AND is_multi)
    OR (type = 'relation')                       -- one or many, from config
    OR (type NOT IN ('tags','multi_select','relation') AND NOT is_multi))
);
CREATE UNIQUE INDEX attr_slug_uq ON attribute_definition (workspace_id, object_type, slug);
-- targets for the composite foreign keys that make type drift impossible:
ALTER TABLE attribute_definition ADD CONSTRAINT attr_kind_uq   UNIQUE (id, value_kind);
ALTER TABLE attribute_definition ADD CONSTRAINT attr_multi_uq  UNIQUE (id, is_multi);

CREATE TABLE attribute_option (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid REFERENCES workspace(id),
  attribute_id  uuid NOT NULL REFERENCES attribute_definition(id) ON DELETE CASCADE,
  key           text NOT NULL,             -- stable; label is renameable, key is not
  label         text NOT NULL,
  color         text,
  position      integer NOT NULL,          -- THE sort order for single_select
  archived_at   timestamptz
);
CREATE UNIQUE INDEX attr_option_key_uq ON attribute_option (attribute_id, key);
CREATE UNIQUE INDEX attr_option_pos_uq ON attribute_option (attribute_id, position)
  DEFERRABLE INITIALLY DEFERRED;           -- so a reorder can swap positions in one statement
```

### 2.4 `attribute_value` — the index model

```sql
CREATE TABLE attribute_value (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid REFERENCES workspace(id),
  object_type   object_type NOT NULL,
  record_id     uuid NOT NULL,
  attribute_id  uuid NOT NULL REFERENCES attribute_definition(id) ON DELETE CASCADE,
  value_kind    value_kind NOT NULL,
  is_multi      boolean NOT NULL,
  value_key     text NOT NULL,   -- '' for single-valued; canonical value for multi-valued
  fact_id       uuid NOT NULL,   -- the live fact this row projects

  -- exactly one typed slot is populated
  text_value    text,            -- verbatim, for display/round-trip
  text_norm     text,            -- lower + unaccent + trim, FULL length -> trigram GIN
  text_sort     text COLLATE "C",-- left(text_norm, 256), NULL for long_text -> btree
  num_value     numeric,
  date_value    date,
  bool_value    boolean,
  option_id     uuid REFERENCES attribute_option(id) ON DELETE CASCADE,
  option_pos    integer,         -- copy of attribute_option.position -> index-ordered select sort
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- the database, not the app, guarantees the right slot for the right type
  CONSTRAINT av_kind_fk  FOREIGN KEY (attribute_id, value_kind) REFERENCES attribute_definition (id, value_kind),
  CONSTRAINT av_multi_fk FOREIGN KEY (attribute_id, is_multi)   REFERENCES attribute_definition (id, is_multi),
  CONSTRAINT av_no_relations CHECK (value_kind <> 'relation'),   -- relations live in record_link
  CONSTRAINT av_single_key   CHECK (is_multi OR value_key = ''),
  CONSTRAINT av_slot CHECK (
    CASE value_kind
      WHEN 'text'   THEN text_norm IS NOT NULL AND num_value IS NULL AND date_value IS NULL
                         AND bool_value IS NULL AND option_id IS NULL
      WHEN 'number' THEN num_value  IS NOT NULL AND text_norm IS NULL AND date_value IS NULL
                         AND bool_value IS NULL AND option_id IS NULL
      WHEN 'date'   THEN date_value IS NOT NULL AND text_norm IS NULL AND num_value  IS NULL
                         AND bool_value IS NULL AND option_id IS NULL
      WHEN 'bool'   THEN bool_value IS NOT NULL AND text_norm IS NULL AND num_value  IS NULL
                         AND date_value IS NULL AND option_id IS NULL
      WHEN 'option' THEN option_id  IS NOT NULL AND option_pos IS NOT NULL AND text_norm IS NULL
                         AND num_value IS NULL AND date_value IS NULL AND bool_value IS NULL
      ELSE false
    END)
);
```

That `CHECK` plus the two composite foreign keys is the direct answer to the standard objection that
EAV is untyped: a `number` attribute physically cannot acquire a text value, and an attribute's
`value_kind` cannot be changed while values exist (the FK blocks it) — which is exactly the brief's
"changing the type of an attribute is not supported", enforced by the database rather than by a
comment.

Indexes:

```sql
-- workhorse: correlated EXISTS and the per-record read for reprojection
CREATE UNIQUE INDEX av_record_attr ON attribute_value (record_id, attribute_id, value_key);

-- one contiguous key range per attribute => a "per-attribute index" without per-attribute DDL
CREATE INDEX av_num   ON attribute_value (attribute_id, num_value,  record_id) WHERE num_value  IS NOT NULL;
CREATE INDEX av_date  ON attribute_value (attribute_id, date_value, record_id) WHERE date_value IS NOT NULL;
CREATE INDEX av_bool  ON attribute_value (attribute_id, bool_value, record_id) WHERE bool_value IS NOT NULL;
CREATE INDEX av_opt   ON attribute_value (attribute_id, option_pos, option_id, record_id) WHERE option_id IS NOT NULL;
CREATE INDEX av_text  ON attribute_value (attribute_id, text_sort,  record_id) WHERE text_sort IS NOT NULL;

-- substring "contains" for every text attribute at once
CREATE INDEX av_trgm  ON attribute_value USING gin (text_norm gin_trgm_ops) WHERE text_norm IS NOT NULL;
```

Six indexes, fixed forever. **Creating an attribute is an `INSERT`, not a `CREATE INDEX`.** That is
the single biggest practical win over per-attribute expression indexes, and it is why the migrations
stay versioned and reproducible.

Two non-obvious choices in that block:

- **`text_sort` is a separate, truncated (`left(text_norm, 256)`), `COLLATE "C"` column.**
  Truncated because a btree index row is capped at ~2 704 bytes — indexing a `long_text` value would
  raise `index row size … exceeds maximum` at runtime, on real user data, at import time. Making it a
  separate `NULL`-for-long_text column means the partial index predicate (`text_sort IS NOT NULL`) is
  something the planner can actually *prove* from a query that filters on `attribute_id` — a
  `length(text_norm) <= 512` predicate would not be provable and the index would silently never be
  used. `COLLATE "C"` because the value is already lower-cased and unaccented, so byte order reads
  correctly for latin scripts, it is faster, and it is immune to the glibc collation changes that
  silently corrupt locale-collated indexes across OS upgrades.
- **`option_pos` is denormalised** from `attribute_option.position`. This is what lets
  `single_select` sort *by option order* off an index (`av_opt`) instead of joining the option table
  and losing index ordering. Cost: reordering options rewrites the `option_pos` of that attribute's
  value rows — one bounded `UPDATE … FROM attribute_option`, a few thousand rows, well under a
  second. Renaming or recolouring an option costs nothing.

Text normalisation (`lower` + `unaccent` + whitespace trim) is computed **in TypeScript**, in
`packages/core`, not by a generated column. Reason: `unaccent(text)` is `STABLE`, not `IMMUTABLE`
(the 1-argument form resolves the default dictionary at runtime), so it is illegal in a generated
column or index expression. The usual workaround — wrapping it in a function falsely marked
`IMMUTABLE` — is a lie to the planner that breaks when the dictionary changes. Doing it in TypeScript
makes it unit-testable (which the brief asks for anyway) and keeps the bulk-import path fast, since
the importer is already touching every string.

### 2.5 `fact` — the truth

```sql
CREATE TABLE fact (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid REFERENCES workspace(id),
  object_type      object_type NOT NULL,
  record_id        uuid NOT NULL,
  attribute_id     uuid NOT NULL REFERENCES attribute_definition(id) ON DELETE CASCADE,
  is_multi         boolean NOT NULL,
  value            jsonb NOT NULL,      -- typed by attribute_definition.type
  value_key        text NOT NULL,       -- '' single-valued; canonical value for multi-valued
  valid_from       date NOT NULL,       -- when it became true
  observed_at      timestamptz NOT NULL,-- when we learned it
  source           fact_source NOT NULL,
  source_ref       text,                -- import_batch id, interaction id, message id …
  confidence       numeric(3,2) NOT NULL DEFAULT 1.0 CHECK (confidence > 0 AND confidence <= 1),
  superseded_by_id uuid REFERENCES fact(id),
  removed_at       timestamptz,         -- a removal is a fact, not a delete (§4.5)
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fact_multi_fk  FOREIGN KEY (attribute_id, is_multi) REFERENCES attribute_definition (id, is_multi),
  CONSTRAINT fact_single_key CHECK (is_multi OR value_key = '')
);

-- exactly one LIVE fact per value slot. For single-valued attributes value_key = ''
-- so this reduces to "one live fact per (record, attribute)" — the same constraint
-- expresses both cardinalities.
CREATE UNIQUE INDEX fact_live_uq ON fact (record_id, attribute_id, value_key)
  WHERE superseded_by_id IS NULL;

CREATE INDEX fact_history ON fact (record_id, attribute_id, observed_at DESC, created_at DESC);
CREATE INDEX fact_source_ref ON fact (source, source_ref) WHERE source_ref IS NOT NULL;
```

Live value set = `superseded_by_id IS NULL AND removed_at IS NULL`.

Write rules (in `packages/core`, one transaction):

| Event | Fact rows |
|---|---|
| set single-valued value | insert new fact (`value_key=''`); `UPDATE` the previous live fact's `superseded_by_id` |
| add a tag / option / relation | insert fact with `value_key = <canonical>`; supersedes only a prior fact with the same key (typically a tombstone) |
| remove a tag / option / relation | insert a fact with `removed_at = now()` and the same `value_key`, carrying its own `source`/`confidence`; it supersedes the additive fact |
| re-add later | a new additive fact supersedes the tombstone |

`valid_from` is stored, shown in the history popover, and **does not gate currency in Phase 1** —
current = newest non-superseded, exactly as §4.5 states. The bitemporal extension point is a
projector variant `projectAsOf(date)` that additionally filters `valid_from <= date`; it needs no
schema change.

### 2.6 `record_link` — relations, with link metadata

Relations are the one attribute type that does **not** go through `attribute_value`. They get a
first-class table, because the contact↔organization link carries its own attributes (§4.3) and
because a single table gives bidirectionality for free.

```sql
CREATE TABLE record_link (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid REFERENCES workspace(id),
  attribute_id      uuid NOT NULL REFERENCES attribute_definition(id) ON DELETE CASCADE,
  from_object_type  object_type NOT NULL,
  from_record_id    uuid NOT NULL,
  to_object_type    object_type NOT NULL,
  to_record_id      uuid NOT NULL,
  -- §4.3 link metadata (contact -> organization)
  title             text,
  valid_from        date,
  valid_to          date,          -- NULL = current
  is_primary        boolean NOT NULL DEFAULT false,
  fact_id           uuid NOT NULL REFERENCES fact(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX link_uq      ON record_link (from_record_id, attribute_id, to_record_id);
CREATE UNIQUE INDEX link_primary ON record_link (from_record_id, attribute_id) WHERE is_primary;
CREATE INDEX link_reverse        ON record_link (to_record_id, attribute_id, from_record_id);
CREATE INDEX link_current        ON record_link (from_record_id, attribute_id, valid_to NULLS FIRST, valid_from DESC);
```

`link_reverse` is what makes §4.3's "all relations are bidirectional in the UI" a single index
lookup rather than a second stored row. `link_current` orders a contact's organizations
current-then-past so the Connections tab "reads as a CV" (§6.5) straight off the index.

I considered mirroring links into `attribute_value.target_record_id` so that *every* filter is one
uniform `EXISTS` against one table. **Rejected**: two homes for the same edge is two things to keep
in sync, and the cost of avoiding it is one extra branch in the filter compiler (~10 lines). The
link's metadata is versioned through facts: the fact's `value_key` is the target id and its `value`
is `{"target": …, "title": …, "from": …, "to": …, "is_primary": …}`, so changing a job title
supersedes a fact and updates `record_link` in place — the work history is auditable.

### 2.7 Derived columns (§4.7 and §5.2)

```sql
CREATE TABLE contact_metrics (
  contact_id            uuid PRIMARY KEY REFERENCES contact(id) ON DELETE CASCADE,
  workspace_id          uuid REFERENCES workspace(id),
  last_interaction_at   timestamptz,
  interaction_count_12m integer NOT NULL DEFAULT 0,
  open_followups        integer NOT NULL DEFAULT 0,
  next_followup_at      date,
  warmth                smallint NOT NULL DEFAULT 0 CHECK (warmth BETWEEN 0 AND 100),
  computed_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cm_last  ON contact_metrics (last_interaction_at DESC NULLS LAST, contact_id);
CREATE INDEX cm_warm  ON contact_metrics (warmth DESC, contact_id);
CREATE INDEX cm_count ON contact_metrics (interaction_count_12m DESC, contact_id);
CREATE INDEX cm_open  ON contact_metrics (open_followups DESC, contact_id) WHERE open_followups > 0;
```

A table, not a view: derived columns must be **filterable and sortable like any other column**
(§5.2), which means a real index, which means materialised. It is 1:1 with `contact` and could be
columns on `contact` itself; it is separate so that the nightly warmth sweep rewrites a narrow
40-byte row rather than the wide `contact` row with its `current_values` jsonb, keeping `contact`'s
heap dense and its visibility map clean.

Freshness split:
- **counts and `last_interaction_at`**: recomputed for the affected contacts **in the same
  transaction** as an interaction/follow-up write (an interaction touches a handful of contacts).
  Always correct on write.
- **warmth**: full sweep nightly via pg-boss, plus on-demand after new interactions. Stale by ≤24 h
  of exponential decay on a 90-day time constant — about 1 %, invisible in a 0–100 score.

Derived columns are declared in code beside the system attributes as pseudo attribute definitions
(`is_derived: true`, `source: 'metrics.warmth'`), so they appear in the Columns picker and the filter
picker like any other attribute; the compiler just routes them to `contact_metrics` instead of
`attribute_value`.

### 2.8 Search: tsvector now, pgvector later, one database

```sql
CREATE TABLE search_document (
  object_type  object_type NOT NULL,
  record_id    uuid NOT NULL,
  workspace_id uuid REFERENCES workspace(id),
  title        text NOT NULL,
  body         text NOT NULL,          -- name + org + email + tags + notes + interaction bodies
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED,
  embedding    vector(1536),           -- Phase 1: column exists, always NULL
  embedded_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object_type, record_id)
);
CREATE INDEX search_tsv  ON search_document USING gin (tsv);
CREATE INDEX search_trgm ON search_document USING gin (body gin_trgm_ops);
-- created in Phase 2, after the backfill, so it isn't built on an empty column:
-- CREATE INDEX search_emb ON search_document USING hnsw (embedding vector_cosine_ops);
```

Three verified details behind that:

1. **`to_tsvector('simple', body)` — the two-argument form is mandatory.** The one-argument form is
   only `STABLE` (it reads `default_text_search_config`), so it cannot appear in a generated column
   or an index. The two-argument form with an explicit config is `IMMUTABLE`. The query side must use
   the *same* two-argument call or the index is not used.
2. **`'simple'`, not `'english'`, on purpose.** This is a multilingual address book full of proper
   nouns; English stemming would mangle names and would be wrong for German/French entries. §4.8
   asks for *substring* search anyway — that is the trigram index's job. `tsv` is there for
   word-level relevance ranking over interaction bodies. If accent-insensitive FTS is wanted later,
   the correct route is a custom text-search configuration with `unaccent` in the dictionary chain,
   not an immutable-wrapper hack.
3. **A separate table, not columns on `contact`.** A `vector(1536)` is ~6 KB; putting it on the
   contact row would push every contact into TOAST and halve the heap density of the table that the
   contacts list scans. Interactions and organizations share the same search table, and the
   embedding column can be backfilled without touching `contact`.

pgvector 0.8 (Nov 2024) matters for the Phase 2 design: it added **iterative index scans**
(`hnsw.iterative_scan = strict_order | relaxed_order`), which is precisely the fix for
"semantic search combined with an attribute filter returns too few rows" — the over-filtering
problem this app will hit the moment "semantic search among investors in Munich" is asked. That is
the reason `mode=semantic` can reuse the same filter compiler: filter in SQL, let pgvector iterate.
`halfvec` is the escape hatch if a >2 000-dimension embedding model is ever chosen.

### 2.9 Identifiers (§4.6)

```sql
CREATE TABLE identifier (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id),
  object_type  object_type NOT NULL,
  record_id    uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('email','phone','linkedin_url','website',
                                             'google_contact_id','telegram','whatsapp','other')),
  value        text NOT NULL,   -- normalised: lower(email), E.164 phone, canonical LinkedIn slug
  source       fact_source NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX identifier_uq  ON identifier (kind, value);
CREATE INDEX identifier_record     ON identifier (record_id, kind);
```

The projector writes through here for `email`/`phone`/`linkedin_url`/`website` attributes, so
duplicate detection is a unique-index probe (`kind`,`value`) — deterministic, no LLM, exactly as
§4.8 demands ("the LLM extracts; code decides").

---

## 3. The operator matrix, as actual SQL

Every attribute filter compiles to `EXISTS (SELECT 1 FROM attribute_value v WHERE v.record_id = c.id
AND v.attribute_id = $a AND <predicate>)`; `is empty` is the same shape with `NOT EXISTS` and no
predicate. Below, `$q` is the normalised needle (`lower(unaccent(input))`), computed in TypeScript.

| Type | Operator | Predicate | Index used |
|---|---|---|---|
| short_text | contains | `v.text_norm LIKE '%'\|\|$q\|\|'%'` | `av_trgm` |
| short_text | equals | `v.text_sort = $q` | `av_text` |
| short_text | is empty | `NOT EXISTS(…)` | `av_record_attr` |
| long_text | contains | `v.text_norm LIKE '%'\|\|$q\|\|'%'` | `av_trgm` |
| long_text | is empty | `NOT EXISTS(…)` | `av_record_attr` |
| number | = ≠ < > | `v.num_value = $n` / `<> $n` / `< $n` / `> $n` | `av_num` |
| number | between | `v.num_value BETWEEN $lo AND $hi` | `av_num` |
| date | before/after | `v.date_value < $d` / `> $d` | `av_date` |
| date | between | `v.date_value BETWEEN $lo AND $hi` | `av_date` |
| date | last 30 days / this year | resolved **server-side** to absolute dates, then `between` | `av_date` |
| yes_no | is yes / is no | `v.bool_value` / `NOT v.bool_value` | `av_bool` |
| single_select | is one of | `v.option_id = ANY($ids::uuid[])` | `av_opt` |
| single_select | is not one of | `NOT EXISTS(… AND v.option_id = ANY($ids))` | `av_opt` |
| multi_select | contains any of | `v.option_id = ANY($ids)` | `av_opt` |
| multi_select | contains all of | `(SELECT count(DISTINCT v2.option_id) FROM attribute_value v2 WHERE v2.record_id=c.id AND v2.attribute_id=$a AND v2.option_id = ANY($ids)) = cardinality($ids)` | `av_record_attr` |
| tags | contains any of | `v.text_sort = ANY($tags_norm::text[])` | `av_text` |
| url / email / phone | contains | `v.text_norm LIKE '%'\|\|$q\|\|'%'` | `av_trgm` |
| relation | has any of | `EXISTS (SELECT 1 FROM record_link l WHERE l.from_record_id=c.id AND l.attribute_id=$a AND l.to_record_id = ANY($ids))` | `link_uq` |
| relation | is empty | `NOT EXISTS (… record_link …)` | `link_uq` |
| *derived* | last_interaction older than N days | `m.last_interaction_at IS NULL OR m.last_interaction_at < now() - $n * interval '1 day'` | `cm_last` |
| *derived* | warmth / counts, numeric ops | `m.warmth > $n` etc. | `cm_warm`, `cm_count` |

Two semantics I had to decide (the brief does not say; both go in `docs/DECISIONS.md` and are shown
verbatim in the filter chip tooltip):

- **`number ≠ x`** means *has a value, and it differs* — it does **not** include records with no
  value. Empty is a separate operator. The opposite convention silently returns every empty record,
  which reads as a bug.
- **`single_select is not one of`** means `NOT (is one of)` and therefore **does** include records
  with no value, matching how people read "is not an Investor".

Sort mapping — always exactly one key plus `contact.id` as tiebreaker (§5.2: multi-sort not required):

| Type | ORDER BY | Type | ORDER BY |
|---|---|---|---|
| short_text, email | `text_sort` | yes_no | `bool_value DESC` (yes first) |
| number | `num_value` | single_select | `option_pos` |
| date | `date_value` | long_text, multi_select, tags, url, phone, relation | **not sortable** — API returns 400 |

Empty always sorts last: `ORDER BY <key> ASC NULLS LAST` / `DESC NULLS LAST`.

---

## 4. Representative queries

### 4.1 The canonical list query

*Contacts whose job_role is Investor or Angel, city contains "Munich", areas_of_interest contains
"climate", no interaction in 90 days; sorted by the custom number attribute `target_check_size`
descending; paginated.*

```sql
SELECT c.id,
       c.display_name,
       c.current_values,
       m.last_interaction_at,
       m.warmth,
       count(*) OVER () AS total_rows          -- the "Rows: 2,236" footer, same pass
FROM contact c
JOIN contact_metrics m ON m.contact_id = c.id
LEFT JOIN LATERAL (
  SELECT v.num_value
  FROM attribute_value v
  WHERE v.record_id = c.id
    AND v.attribute_id = $sort_attr            -- target_check_size
  LIMIT 1
) sort_v ON true
WHERE c.workspace_id = $ws
  AND c.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM attribute_value v
              WHERE v.record_id = c.id AND v.attribute_id = $job_role
                AND v.option_id = ANY($role_ids::uuid[]))
  AND EXISTS (SELECT 1 FROM attribute_value v
              WHERE v.record_id = c.id AND v.attribute_id = $city
                AND v.text_norm LIKE '%' || $city_q || '%')
  AND EXISTS (SELECT 1 FROM attribute_value v
              WHERE v.record_id = c.id AND v.attribute_id = $areas
                AND v.text_sort = ANY($area_tags::text[]))
  AND (m.last_interaction_at IS NULL
       OR m.last_interaction_at < now() - interval '90 days')
ORDER BY sort_v.num_value DESC NULLS LAST, c.id DESC
LIMIT $limit OFFSET $offset;
```

Why this shape rather than pre-fetching id sets in application code and passing `IN (…)`:
writing each chip as an `EXISTS` lets Postgres **pull the subquery up into a semi-join** and choose
its own driving table. If `city contains munich` is the selective one, it can drive from `av_trgm`
and hash-join back to `contact`. If `job_role` is selective, it drives from `av_opt`. An application
that materialises id lists has already made that choice, badly, and has to ship potentially tens of
thousands of uuids over the wire per filter.

**The honest weakness in this query** is the `ORDER BY`: the sort key comes from a lateral, so it
cannot be produced in index order — Postgres sorts the whole filtered set. At 10k contacts that is a
few-thousand-row sort of a `numeric`, single-digit milliseconds. It stops being free somewhere around
100k–500k *matching* rows. The documented escape hatch, if that day comes, is to invert the query for
sort-by-custom-attribute: walk `av_num` in index order (`WHERE attribute_id = $sort_attr ORDER BY
num_value DESC, record_id DESC`), apply the filters as semi-joins, stop at `LIMIT`, then append the
value-less records ordered by id in a second pass. That is a query-planner change, not a schema
change — which is the point of having the typed table.

### 4.2 Reading one contact's detail page

```sql
SELECT c.*, m.*
FROM contact c JOIN contact_metrics m ON m.contact_id = c.id
WHERE c.id = $1;
```

One row. Every attribute value is already in `current_values`. This is what `current_values` buys,
and it is why the EAV read tax never appears.

### 4.3 Writing a value (single-valued), with supersession

```sql
WITH new_fact AS (
  INSERT INTO fact (workspace_id, object_type, record_id, attribute_id, is_multi,
                    value, value_key, valid_from, observed_at, source, source_ref, confidence)
  VALUES ($ws,'contact',$rec,$attr,false,
          to_jsonb($val::text), '', $valid_from, now(), 'quick_capture', $interaction_id, 0.9)
  RETURNING id
), superseded AS (
  UPDATE fact f SET superseded_by_id = (SELECT id FROM new_fact)
  WHERE f.record_id = $rec AND f.attribute_id = $attr
    AND f.superseded_by_id IS NULL
    AND f.id <> (SELECT id FROM new_fact)
  RETURNING f.id
)
INSERT INTO attribute_value (workspace_id, object_type, record_id, attribute_id, value_kind,
                             is_multi, value_key, fact_id, text_value, text_norm, text_sort)
VALUES ($ws,'contact',$rec,$attr,'text',false,'',(SELECT id FROM new_fact),
        $val, $val_norm, left($val_norm,256))
ON CONFLICT (record_id, attribute_id, value_key)
DO UPDATE SET fact_id = EXCLUDED.fact_id, text_value = EXCLUDED.text_value,
              text_norm = EXCLUDED.text_norm, text_sort = EXCLUDED.text_sort,
              updated_at = now();

UPDATE contact SET current_values = current_values || jsonb_build_object($slug, to_jsonb($val::text)),
                   updated_at = now()
WHERE id = $rec;
```

Note the ordering: the `UPDATE … superseded` runs before the unique partial index
`fact_live_uq` can complain, because both statements are in the same CTE and the index is checked at
statement end. If that proves fragile in practice the constraint becomes `DEFERRABLE`.

### 4.4 Removing a tag (multi-valued) — a removal is a fact

```sql
WITH tomb AS (
  INSERT INTO fact (workspace_id, object_type, record_id, attribute_id, is_multi, value, value_key,
                    valid_from, observed_at, source, confidence, removed_at)
  VALUES ($ws,'contact',$rec,$attr,true,to_jsonb($tag::text),$tag_norm,
          current_date, now(), 'manual', 1.0, now())
  RETURNING id
), sup AS (
  UPDATE fact f SET superseded_by_id = (SELECT id FROM tomb)
  WHERE f.record_id=$rec AND f.attribute_id=$attr AND f.value_key=$tag_norm
    AND f.superseded_by_id IS NULL AND f.id <> (SELECT id FROM tomb)
  RETURNING 1
)
DELETE FROM attribute_value
WHERE record_id=$rec AND attribute_id=$attr AND value_key=$tag_norm;

UPDATE contact
SET current_values = jsonb_set(current_values, ARRAY[$slug],
      COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(current_values->$slug) e
                WHERE e <> to_jsonb($tag::text)), '[]'::jsonb))
WHERE id = $rec;
```

The `attribute_value` row is deleted, not tombstoned — it is a cache. The history lives in `fact`.

### 4.5 The value history popover (§4.5 UI)

```sql
SELECT f.value, f.valid_from, f.observed_at, f.source, f.source_ref,
       f.confidence, f.removed_at, f.superseded_by_id IS NULL AS is_live
FROM fact f
WHERE f.record_id = $1 AND f.attribute_id = $2
ORDER BY f.observed_at DESC, f.created_at DESC
LIMIT 20;
```

Straight off `fact_history`. This renders *"Company: Stripe — since Jun 2025, from LinkedIn import ·
previously Northstar — Jan 2023, manual"* with no extra machinery.

### 4.6 Warmth (§4.7), set-based, nightly

`k` is pinned by the brief's calibration "one meeting per month ≈ 75": twelve monthly meetings give
`signal = Σ 3.0·e^(−30n/90) ≈ 10.39`, so `k = ln(4)/10.39 ≈ 0.133`. The constant lives in
`packages/core` with a unit test asserting `warmth(monthlyMeetings) ∈ [74,76]`.

```sql
UPDATE contact_metrics m
SET last_interaction_at   = s.last_at,
    interaction_count_12m = s.cnt_12m,
    warmth = GREATEST(
      CASE WHEN (c.current_values->>'pinned_important')::boolean THEN 60 ELSE 0 END,
      LEAST(
        CASE WHEN (c.current_values->>'not_important')::boolean THEN 10 ELSE 100 END,
        round(100 * (1 - exp(-0.133 * COALESCE(s.signal,0))))::int)),
    computed_at = now()
FROM contact c
LEFT JOIN LATERAL (
  SELECT max(i.occurred_at) AS last_at,
         count(*) FILTER (WHERE i.occurred_at > now() - interval '365 days') AS cnt_12m,
         sum(w.weight * exp(-(extract(epoch FROM now() - i.occurred_at)/86400.0)/90.0))
           FILTER (WHERE i.occurred_at > now() - interval '365 days') AS signal
  FROM interaction_contact ic
  JOIN interaction i ON i.id = ic.interaction_id
  JOIN interaction_weight w ON w.type = i.type
  WHERE ic.contact_id = c.id
) s ON true
WHERE m.contact_id = c.id AND c.deleted_at IS NULL;
```

This is the one place `current_values` is read inside a predicate. It is a full sweep over every
contact anyway, so there is no index to miss; the alternative (a join to `attribute_value` for two
booleans) is strictly more work.

### 4.7 Global search (§4.8), keyword mode

```sql
SELECT d.object_type, d.record_id, d.title,
       ts_rank(d.tsv, websearch_to_tsquery('simple', $q)) AS rank
FROM search_document d
WHERE d.workspace_id = $ws
  AND (d.tsv @@ websearch_to_tsquery('simple', $q)   -- word matches, ranked
       OR d.body ILIKE '%' || $q || '%')             -- substring, trigram-backed
ORDER BY rank DESC, d.title
LIMIT 20;
```

`mode=semantic` later replaces the `WHERE` with `ORDER BY d.embedding <=> $vec` (or Drizzle's
`cosineDistance`) plus `SET LOCAL hnsw.iterative_scan = 'relaxed_order'` when attribute filters are
combined with it — same table, same API shape, one new branch in the compiler.

### 4.8 Bulk import — the path that must not use the per-record writer

10k rows × 15 attributes = 150 000 facts. Running §4.3's five-statement flow 150 000 times is
minutes. The importer instead:

```sql
COPY fact (id, workspace_id, object_type, record_id, attribute_id, is_multi, value, value_key,
           valid_from, observed_at, source, source_ref, confidence) FROM STDIN;   -- ~2 s

INSERT INTO attribute_value (workspace_id, object_type, record_id, attribute_id, value_kind,
                             is_multi, value_key, fact_id, text_value, text_norm, text_sort,
                             num_value, date_value, bool_value, option_id, option_pos)
SELECT … FROM fact f JOIN attribute_definition a ON a.id = f.attribute_id
WHERE f.source_ref = $batch AND f.superseded_by_id IS NULL AND f.removed_at IS NULL
ON CONFLICT (record_id, attribute_id, value_key) DO UPDATE SET …;                 -- ~3 s

UPDATE contact c SET current_values = p.vals
FROM (SELECT f.record_id, jsonb_object_agg(a.slug, …) AS vals
      FROM fact f JOIN attribute_definition a ON a.id = f.attribute_id
      WHERE f.source_ref = $batch AND f.superseded_by_id IS NULL AND f.removed_at IS NULL
      GROUP BY f.record_id) p
WHERE c.id = p.record_id;                                                          -- ~5 s
```

Normalised strings (`text_norm`, `text_sort`, E.164 phones) are computed in TypeScript during CSV
parsing and go into the `COPY` stream, so the SQL side stays set-based. Estimated ~15 s for a 10k-row
LinkedIn import. **This path has to exist from Stage 1**, not be retrofitted in Stage 5 — the write
amplification is the design's main cost and the importer is where it bites.

### 4.9 Attribute deletion and contact merge — why the fact log pays for itself

Delete an attribute (§6.7 confirmation needs the count first):

```sql
SELECT count(DISTINCT record_id) FROM attribute_value WHERE attribute_id = $1;
DELETE FROM attribute_definition WHERE id = $1;             -- cascades fact, attribute_value, links
UPDATE contact SET current_values = current_values - $slug WHERE current_values ? $slug;
```

Merge two contacts (§6.9) is a repoint plus a reprojection, not a field-by-field copy:

```sql
UPDATE fact SET record_id = $survivor WHERE record_id = $loser;
UPDATE interaction_contact SET contact_id = $survivor WHERE contact_id = $loser;
UPDATE follow_up SET contact_id = $survivor WHERE contact_id = $loser;
UPDATE identifier SET record_id = $survivor WHERE record_id = $loser;
-- for each single-valued attribute where the user picked the survivor's value, supersede the
-- loser's fact; then:
SELECT reproject_record('contact', $survivor);
DELETE FROM contact WHERE id = $loser;
```

Both merged records' provenance survives, because the losing values are superseded facts, not
deleted rows. A wide-table design has to throw that away.

---

## 5. The projector

One pure function in `packages/core`:

```
project(records: RecordId[], tx) →
  read live facts + attribute definitions
  → upsert attribute_value rows (delete rows with no live fact)
  → upsert record_link rows
  → rebuild current_values jsonb
  → rebuild search_document.body
```

Run inside the same transaction as every fact write. Properties that matter:

- **Idempotent and total.** `pnpm db:reproject` truncates the three caches and rebuilds from `fact`.
  A 5k-contact / 100k-fact database rebuilds in seconds.
- **Testable without a database** for the value-mapping half (fact → typed slot + jsonb),
  which is the part with all the type-specific branches.
- **Verified in CI.** An integration test runs the seed dataset, mutates it through the API, then
  asserts `project(facts) == stored caches` byte-for-byte. Plus a nightly consistency job in
  production that logs (does not fix) any drift.

Application-side rather than a trigger, deliberately: normalisation needs `unaccent` in TypeScript
(see §2.4), the bulk path needs to bypass per-row work, and the brief wants this logic unit-tested.
**Honest cost:** any writer that bypasses the API — `psql`, a future MCP tool that writes SQL
directly, a hand-run migration — silently skips projection. A trigger would be safer. The mitigations
are: the API is the only sanctioned writer, `db:reproject` is cheap, and the CI/nightly check catches
drift. If a second writer ever appears, the projector moves into a `STATEMENT`-level trigger on
`fact` and the bulk path gets `SET session_replication_role = replica` around the `COPY`.

---

## 6. Honest weaknesses

Ranked by how likely they are to actually hurt.

1. **Write amplification, ~3–4×.** One attribute edit writes a fact, updates a supersession, upserts
   an `attribute_value` row, updates a jsonb column and touches `search_document`. Storage is roughly
   3× a wide table. At 5k contacts this is tens of megabytes and single-digit-millisecond writes —
   irrelevant. At import scale it is the dominant cost, which is why §4.8 exists. If the set-based
   import path is ever allowed to rot, imports go from 15 seconds to minutes.
2. **The planner is blind to per-attribute statistics.** `attribute_value` is one heterogeneous
   table, so Postgres estimates the selectivity of `text_norm LIKE '%munich%'` identically whether
   the attribute is `city` (very selective) or `notes` (not). Extended statistics don't fix `LIKE`
   selectivity. This is the thing a per-attribute expression index or a wide table does genuinely
   better. At 10k rows the *worst* plan is still ~20 ms, so it is an accepted cost — but it is the
   first thing that would bite at 1M rows, and it will occasionally produce a plan that is 5× slower
   than the best one with no obvious cause.
3. **`ORDER BY` a custom attribute cannot use an index in the general case** (§4.1). Full sort of the
   filtered set. Fine to ~100k matching rows; the two-phase rewrite is documented, not built.
4. **Three copies can drift.** The whole design rests on the projector being right. Mitigated by
   determinism, `db:reproject`, and a CI equality assertion — but a projector bug that ships and is
   not caught for a week means a week of subtly wrong tables. The data is never *lost* (facts are
   truth), which is the reason this trade is acceptable at all.
5. **`current_values` is stored and never queried.** A reviewer is right to ask why it exists at all
   when `attribute_value` holds the same data. The answer is read cost (§1.2) and nothing else. If
   profiling ever showed the pivot was cheap enough, `current_values` is the layer to delete — and it
   can be deleted without touching truth.
6. **Option reordering rewrites value rows.** Bounded (`UPDATE attribute_value SET option_pos = …
   FROM attribute_option WHERE attribute_id = $1`), sub-second at this scale, but it is a write
   triggered by a settings action, which is the kind of thing that surprises people.
7. **Tags are strings, not options** (per §4.2, they're created inline). Renaming a tag globally is a
   bulk fact rewrite plus reproject, and there is no "used in N records" integrity the way there is
   for select options. Promoting tags to a lightweight option table is the obvious later fix.
8. **No cross-attribute `OR`.** The `EXISTS`-per-chip shape assumes AND-only, which §5.2 guarantees.
   An `OR` of two `EXISTS` clauses defeats the semi-join pull-up and degrades to a sequential scan.
   If the "Ask the network" LLM is ever allowed to emit `OR`, this needs revisiting — I'd constrain
   the LLM's filter grammar to AND-only and say so in the "How I searched" panel.
9. **Single sort key only.** The design leans on §5.2's "multi-sort not required". Adding it means
   multiple laterals and strictly worse sorts.
10. **Timezone semantics are unspecified by the brief.** `date` attributes are `date` (no time), but
    the relative filters ("last 30 days") and `last_interaction_at` comparisons need a timezone. I
    resolve relative ranges to absolute dates server-side using a configured `APP_TIMEZONE`
    (defaulting to the profile's, once §6.6 stores one) and show the resolved dates in the filter
    chip. **Open question for Simon:** should "this year" mean his calendar year in his timezone —
    yes, but the profile needs a timezone field the brief doesn't list.
11. **The `fact_live_uq` partial unique index and the insert-then-supersede ordering** (§4.3) is the
    subtlest thing here. If it turns out to fire mid-CTE, the constraint becomes `DEFERRABLE INITIALLY
    DEFERRED`. This must be covered by an integration test on day one.
12. **"Smooth at 10k rows" is mostly not a database problem.** The database never returns 10k rows;
    the API pages at 50–100 and the table virtualises. If anyone builds a client that fetches 10k
    rows to filter in the browser, none of this matters. The API contract (server-side filter, sort,
    paginate, with an opaque cursor so offset can become keyset without an API change) is the part
    that has to hold.

---

## 7. Where this stops working

Concretely, with numbers, assuming a single 2-vCPU Supabase/Postgres instance:

- **Comfortable to ~100k records** (≈ 2M `attribute_value` rows, ≈ 3M facts). Filtered list queries
  stay under ~50 ms because the sorts stay under ~50k rows and the `EXISTS` semi-joins hit btree
  indexes.
- **First failure, ~100k–500k matching rows: sorting by a custom attribute.** The lateral sort
  becomes tens of milliseconds and then hundreds. Fix: the two-phase index-ordered pagination in
  §4.1. No schema change.
- **Second failure, ~500k+ rows: planner mis-estimation** (weakness 2) starts producing plans that
  are seconds instead of milliseconds, unpredictably, because `attribute_value` has no per-attribute
  statistics. Fix at that point: partition `attribute_value` by `value_kind` (five partitions, real
  per-partition statistics, same query shape) or by `attribute_id` hash. That is a schema change but
  not a data-model change.
- **Third failure, ~1M+ rows with heavy write traffic:** the 3–4× write amplification and the
  `current_values` jsonb rewrite per edit start producing serious table bloat and autovacuum
  pressure on `contact`. Fix: move `current_values` to a side table so `contact` stops being rewritten
  on every attribute edit.
- **Not addressed at all:** concurrent multi-user editing of the same record. The fact log makes
  conflict *visible* (two facts, two sources, two confidences) but Phase 1 has no merge policy beyond
  "newest wins", and no optimistic-concurrency token on the API. That is fine for a single-user CRM
  and is the first thing to design when §9's multi-user arrives.

For the brief's actual target — a few thousand contacts, one user, 10k rows in the table — this design
is comfortably over-provisioned, and the parts that are over-provisioned (the typed table, the fact
log) are precisely the parts §9 needs later.

---

## 8. Verified vs assumed

**Verified against current documentation/sources during this design:**

- PostgreSQL 16 implements **only stored** generated columns; the expression must be `IMMUTABLE`,
  cannot use subqueries, and **cannot reference another generated column**.
  (postgresql.org/docs/16/ddl-generated-columns.html)
- Index expressions must be `IMMUTABLE`; casting jsonb-extracted **text to `date`/`timestamp` is
  rejected**, because those conversions depend on `DateStyle`/`TimeZone` and accept `'now'`/`'today'`.
  This is why a pure-JSONB design cannot index a date attribute directly.
  (postgresql.org mailing-list threads on "functions in index expression must be marked IMMUTABLE";
  ongres.com "Limitations in Postgres Index definition")
- **`to_tsvector` one-argument form is `STABLE`, the two-argument form with an explicit regconfig is
  `IMMUTABLE`** and is required for generated columns and indexes; queries must use the same
  two-argument form to hit the index. (postgresql.org/docs — Text Search "Tables and Indexes")
- **pgvector 0.8.0** (Nov 2024) added **iterative index scans** (`hnsw.iterative_scan` /
  `ivfflat.iterative_scan`, `strict_order` vs `relaxed_order`) specifically to fix over-filtering
  when a vector search is combined with SQL filters; `halfvec` (0.7) is required for >2 000
  dimensions. (thenile.dev pgvector 0.8 announcement; Supabase pgvector docs)
- **Drizzle has first-class pgvector support**: `vector('embedding', { dimensions: 1536 })` from
  `drizzle-orm/pg-core`, distance helpers (`cosineDistance`, `l2Distance`, `innerProduct`, …), and
  `index().using('hnsw', table.embedding.op('vector_cosine_ops'))`. Generated columns landed in
  drizzle-orm 0.32.0. (orm.drizzle.team extensions/pg and vector-similarity-search guides)
- **Supabase offers `pg_trgm`, `vector`, `unaccent` and `btree_gin`** as installable extensions, so
  the schema is portable to the deployed instance without Supabase-specific features.
  (supabase.com/docs/guides/database/extensions)

**Assumed, and explicitly not verified in this environment (no Postgres available here):**

- That `(jsonb ->> 'k')::numeric` *is* immutable and indexable, unlike the date cast. The sources
  strongly indicate it, and I did not run it. **The design does not depend on it** — numbers live in
  a real `numeric` column.
- That `btree_gin` ships a `uuid` operator class, which would allow a multicolumn
  `gin (attribute_id, text_norm gin_trgm_ops)` index and remove the cross-attribute recheck on
  `contains`. Because I did not verify it, the shipped DDL uses a plain single-column trigram GIN
  that needs no `btree_gin` at all. Upgrading is one migration if it turns out to be available.
- That a partial unique index (`fact_live_uq`) tolerates the insert-then-supersede ordering inside a
  single CTE. Flagged as weakness 11 with `DEFERRABLE` as the fallback; it needs an integration test
  before anything is built on it.
- **All performance numbers are estimates derived from the plan shapes, not measurements.** There is
  no Postgres in this environment. A benchmark script (10k contacts × 20 attributes, `EXPLAIN
  (ANALYZE, BUFFERS)` on the §4.1 query with three filter shapes) is a **Stage 1 deliverable**, and
  the numbers in §7 should be treated as hypotheses until it runs.
- Exact `drizzle-kit` 0.31.x coverage of partial indexes, composite foreign keys to a
  `UNIQUE (id, value_kind)` target, and `CHECK` constraints. The assumption is that anything
  drizzle-kit cannot express is written as a hand-authored SQL migration file under drizzle-kit's
  versioning — which keeps §3.2's "versioned, in the repo, reproducible" true either way.
- That `unaccent()` is `STABLE` rather than `IMMUTABLE` (the basis for computing `text_norm` in
  TypeScript). This is long-standing Postgres behaviour but I did not re-verify it; if it were
  immutable, `text_norm` could become a generated column and the projector would get simpler.
