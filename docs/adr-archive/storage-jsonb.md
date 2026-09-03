# Storage design: append-only fact log + `current_values jsonb` projection

**Position:** advocate for JSONB-with-GIN as the read path for the dynamic attribute system (§4.2),
with the append-only fact log (§4.5) as the source of truth.

**Target:** Postgres 16 (Supabase = managed Postgres only), `pgvector`, `pg_trgm`.
**Scale:** a single-user personal CRM. Realistically 2k–10k contacts, ~60 attributes per object type,
a few hundred writes a day, one 10k-row LinkedIn import as the peak write event.

---

## 0. The argument in one paragraph

The brief already forces an EAV table into existence: §4.5's fact log *is* EAV — `(record_id,
attribute_id, value, …)` — with history, provenance and confidence bolted on. So the real question is
not "EAV vs JSONB". It is: **given that we must maintain an append-only EAV log anyway, what should
the read path look like?** Reconstructing a 20-column contacts table from that log means a 20-way
self-join or a `crosstab`/`FILTER` pivot on every page load, every filter, every sort — for a table
whose column set changes at runtime. Projecting the log into one `jsonb` column per record collapses
that to a single heap fetch per row, makes the filter compiler small enough to unit-test exhaustively,
and lets one GIN index cover equality and set-membership on *every* attribute the user will ever
create, with no migration. The brief itself blesses this shape: *"a `current_values` JSONB per record
refreshed on write is fine — the fact log is the truth, the JSONB is the index."* This document is the
detailed version of that sentence, with the parts the sentence hides.

---

## 1. The layer cake

```
                     ┌──────────────────────────────────────────────┐
  truth              │  fact                (append-only, EAV)      │
                     │  record_link         (relations + metadata)  │
                     └───────────────────┬──────────────────────────┘
                                         │  reproject_record()  (trigger / batch)
                                         ▼
                     ┌──────────────────────────────────────────────┐
  read model         │  contact.current_values  jsonb               │
                     │  contact.search_tsv      tsvector (generated)│
                     │  contact.embedding       vector  (later)     │
                     └───────────────────┬──────────────────────────┘
                                         │  LEFT JOIN
                                         ▼
                     ┌──────────────────────────────────────────────┐
  derived            │  contact_metrics  (last_interaction_at,      │
                     │   interaction_count_12m, open_followups,     │
                     │   next_followup_at, warmth)                  │
                     └──────────────────────────────────────────────┘
```

`current_values` is **disposable**. `pnpm db:reproject` rebuilds every row from `fact` with one
set-based statement (§7.3), and CI asserts that a rebuild is a no-op. That property is what makes the
denormalisation safe rather than scary.

---

## 2. The encoding contract

This is the single most important table in the design. Everything else (filters, sorts, indexes,
validation) is derived from it. It is enforced in `packages/core` by a Zod codec per attribute type,
and it is the only place that knows how a value becomes JSON.

| Attribute type | Cardinality | JSON encoding in `current_values` | Example |
|---|---|---|---|
| `short_text` | one | string | `"Munich"` |
| `long_text` | one | **not stored in `current_values`** (see §2.2) | — |
| `number` | one | JSON number | `600000` |
| `date` | one | string, strict `YYYY-MM-DD` | `"1988-03-12"` |
| `yes_no` | one | boolean | `true` |
| `single_select` | one | string = option id | `"opt_investor"` |
| `multi_select` | many | array of option ids, sorted | `["opt_a","opt_c"]` |
| `tags` | many | array of strings, lowercased+sorted | `["climate","seed"]` |
| `url` | one | string | `"https://x.com"` |
| `email` | one | string, lowercased | `"a@b.com"` |
| `phone` | one | string, E.164 when parseable | `"+4915112345678"` |
| `relation` (one) | one | string = target uuid | `"3f2a…"` |
| `relation` (many) | many | array of target uuids, sorted | `["3f2a…","9c11…"]` |

### 2.1 Four invariants

1. **Key = attribute `slug`.** The brief makes slug immutable after creation (§4.2), which removes the
   single worst failure mode of JSONB schemas — key renames. (I considered keying by `attribute_id`,
   which is rename-proof by construction, and rejected it: the compiler resolves definitions anyway,
   and a `psql` dump you can read is worth a lot on a two-person project.)
2. **Absent key = empty.** We never store JSON `null`, never `[]`, never `""`. `is empty` is
   `NOT (current_values ? 'slug')`; `jsonb_typeof` is never `'null'`. This keeps the GIN index smaller
   and makes `ORDER BY` NULL handling uniform (`->` returns SQL NULL for a missing key).
3. **Homogeneous types per key.** Every value under one slug is the same JSON type. This is what makes
   jsonb btree ordering *correct* rather than merely defined (§5). Enforced by the codec; audited by a
   nightly query (§10.1).
4. **Canonical ordering inside arrays.** Multi-valued arrays are sorted on projection. Without this,
   `tags: ["a","b"]` and `["b","a"]` are different jsonb values, which breaks change detection and
   makes diffs noisy. Sorting costs nothing and buys byte-equality.

### 2.2 Why `long_text` is excluded

`long_text` has no sort, exactly two operators (`contains`, `is empty`), and is the only type that can
be kilobytes. Including it would routinely push `current_values` past Postgres's ~2 KB TOAST threshold,
at which point the whole datum goes out of line and **every** list query pays a detoast to read *any*
key. Excluding it keeps a 60-attribute contact's `current_values` at roughly 600–900 bytes — inline,
never TOASTed.

The current `long_text` value lives in the fact log, where it already is. The detail page loads it with
the same one query that loads value history; the `contains` filter compiles to an `EXISTS` over `fact`
with a trigram index (§6, row `long_text`). It also still feeds the full-text vector (§8).

This is the one seam in the "one row, one fetch" story, and I would rather name it than hide it.

---

## 3. DDL

### 3.1 Extensions and helpers

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;   -- installed now, column added now, index later (§9)

-- Immutable, guarded extractors. Guarded so that a bad value yields NULL instead of
-- aborting an INSERT from inside an index expression.
CREATE FUNCTION mut_num(cv jsonb, k text) RETURNS numeric
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT CASE WHEN jsonb_typeof(cv -> k) = 'number' THEN (cv ->> k)::numeric END
  $$;

CREATE FUNCTION mut_date(cv jsonb, k text) RETURNS date
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT CASE WHEN cv ->> k ~ '^\d{4}-\d{2}-\d{2}$'
                THEN make_date(substr(cv ->> k, 1, 4)::int,
                               substr(cv ->> k, 6, 2)::int,
                               substr(cv ->> k, 9, 2)::int) END
  $$;

CREATE FUNCTION mut_text(cv jsonb, k text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT lower(cv ->> k) $$;
```

Every ingredient here is immutable: `->`, `->>`, `jsonb_typeof`, `substr`, `text::int`, `text::numeric`,
`make_date`, `lower`, `~` with a constant pattern. Nothing is mislabelled to sneak past the planner.
`mut_date` deliberately avoids `::date` / `to_date`, which are **stable, not immutable**, because they
depend on `DateStyle` — the classic reason `CREATE INDEX … ((j->>'d')::date)` fails.

> **Verify in Stage 1, in CI:** Postgres const-folds index expressions when it loads them
> (`RelationGetIndexExpressions`), and inlines simple SQL functions in queries, so the two sides should
> match and the index should be used. I am confident but not certain of this for wrapper functions; the
> Stage 1 test suite must contain `EXPLAIN` assertions that each generated index is actually chosen.
> **Fallback if it does not hold:** the filter compiler emits the inlined `CASE …` expression verbatim
> on both the `CREATE INDEX` and the query side, which matches by construction. Slightly uglier SQL,
> zero risk.

### 3.2 Workspace and attribute definitions

```sql
CREATE TABLE workspace (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE object_type      AS ENUM ('contact','organization','interaction','followup');
CREATE TYPE attribute_type   AS ENUM ('short_text','long_text','number','date','yes_no',
                                      'single_select','multi_select','tags','url','email',
                                      'phone','relation');
CREATE TYPE cardinality      AS ENUM ('one','many');

CREATE TABLE attribute_definition (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid REFERENCES workspace(id) ON DELETE CASCADE,   -- §9: nullable, always NULL now
  object_type   object_type    NOT NULL,
  title         text           NOT NULL,
  slug          text           NOT NULL CHECK (slug ~ '^[a-z][a-z0-9_]{0,62}$'),
  type          attribute_type NOT NULL,
  cardinality   cardinality    NOT NULL,        -- derived from type + config at creation, then frozen
  config        jsonb          NOT NULL DEFAULT '{}',  -- options[], target_object_type, unit, decimals…
  attr_group    text,
  description   text,
  is_system     boolean        NOT NULL DEFAULT false,
  position      integer        NOT NULL DEFAULT 0,
  created_at    timestamptz    NOT NULL DEFAULT now(),
  updated_at    timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT attribute_slug_unique
    UNIQUE NULLS NOT DISTINCT (workspace_id, object_type, slug)
);
```

`UNIQUE NULLS NOT DISTINCT` (Postgres 15+) is doing real work: without it, `workspace_id IS NULL` on
every row would make every pair of rows "distinct" and the uniqueness of slugs would silently not be
enforced today. This same pattern applies to every unique constraint that carries `workspace_id`.

### 3.3 Records

```sql
CREATE TABLE contact (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid REFERENCES workspace(id) ON DELETE CASCADE,   -- §9
  first_name     text,
  last_name      text,
  display_name   text GENERATED ALWAYS AS
                   (btrim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))) STORED,
  provenance     jsonb NOT NULL DEFAULT '{}',    -- §4.4: created_via, import_batch_id, last_enriched_at…
  current_values jsonb NOT NULL DEFAULT '{}',    -- the projection
  pinned_important boolean NOT NULL DEFAULT false,   -- §4.7 warmth floor
  not_important    boolean NOT NULL DEFAULT false,   -- §4.7 warmth cap
  embedding      vector(1536),                   -- §9, nullable, no index yet
  search_tsv     tsvector GENERATED ALWAYS AS (
                   setweight(to_tsvector('simple',
                     coalesce(first_name,'') || ' ' || coalesce(last_name,'')), 'A')
                   ||
                   setweight(jsonb_to_tsvector('simple', current_values, '["string"]'), 'B')
                 ) STORED,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Keep the wide jsonb inline rather than out-of-line whenever it is at all possible.
ALTER TABLE contact ALTER COLUMN current_values SET STORAGE MAIN;

CREATE TABLE organization ( /* identical shape: name instead of first/last, same 5 read-model cols */ );
```

`to_tsvector(regconfig, text)` and `jsonb_to_tsvector(regconfig, jsonb, jsonb)` are immutable **because
the text-search config is explicit** — the one-argument forms are only stable (they read
`default_text_search_config`) and cannot be used in a generated column or an index. The `'["string"]'`
filter tells `jsonb_to_tsvector` to index string values only, skipping numbers, booleans and uuids,
which is exactly what we want: searching for "600000" is meaningless, searching for "climate" is not.

The nice property here is that **every custom attribute the user invents is full-text searchable the
moment it is populated, with no schema change and no code change** — the generated column just picks it
up out of `current_values`.

### 3.4 The fact log (the source of truth)

```sql
CREATE TYPE fact_source AS ENUM ('manual','import','quick_capture','agent','gmail','calendar','crawler');

CREATE TABLE fact (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid REFERENCES workspace(id) ON DELETE CASCADE,     -- §9
  object_type     object_type NOT NULL,
  record_id       uuid        NOT NULL,
  attribute_id    uuid        NOT NULL REFERENCES attribute_definition(id) ON DELETE CASCADE,

  -- For cardinality 'one': the whole value. For 'many': exactly ONE element of the set.
  value           jsonb       NOT NULL,

  valid_from      date        NOT NULL,       -- when it became true; defaults to observed_at::date
  observed_at     timestamptz NOT NULL DEFAULT now(),
  source          fact_source NOT NULL,
  source_ref      text,                       -- import_batch_id, interaction_id, message id…
  confidence      real        NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  superseded_by_id uuid REFERENCES fact(id) ON DELETE SET NULL,
  removed_at      timestamptz,                -- multi-valued removal (§4.5: "removal is a fact")
  removed_source  fact_source,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fact_live_is_not_superseded CHECK (NOT (superseded_by_id IS NOT NULL AND removed_at IS NOT NULL))
);

-- The hot path: "what are the live facts for this record?" and the projection rebuild.
CREATE INDEX fact_live_idx ON fact (record_id, attribute_id, valid_from DESC, observed_at DESC)
  WHERE superseded_by_id IS NULL AND removed_at IS NULL;

-- History panel for one attribute on one record (§4.5 UI), includes superseded rows.
CREATE INDEX fact_history_idx ON fact (record_id, attribute_id, observed_at DESC);

-- "Used in (count of records with a value)" on the attributes list (§6.7).
CREATE INDEX fact_attr_live_idx ON fact (attribute_id, record_id)
  WHERE superseded_by_id IS NULL AND removed_at IS NULL;

-- 'contains' on long_text, which is not in current_values (§2.2).
CREATE INDEX fact_text_trgm_idx ON fact USING gin ((value #>> '{}') gin_trgm_ops)
  WHERE superseded_by_id IS NULL AND removed_at IS NULL;
```

`value #>> '{}'` is the canonical "unwrap a jsonb scalar to text" idiom — `->>` needs a key or an array
index and does not work on a bare scalar. `#>>` with an empty path is immutable, so it indexes.

The partial predicate keeps it to *live* values only, so superseded history never enters the index.
On a few thousand contacts with two long_text attributes each that is a few thousand entries. It does
index the live value of every non-`long_text` attribute too, which is waste; adding
`AND attribute_id IN (SELECT …)` is not allowed in a partial index predicate (no subqueries), so the
practical fix if it ever matters is a `is_long_text boolean` column denormalised onto `fact` and used
in the predicate. Not worth it at this size.

### 3.5 Relations with link metadata (§4.3)

Relations are **not** owned by the JSONB. They are rows, because they carry metadata, must be
bidirectional, must survive target deletion cleanly, and must support join queries ("also at the same
organization"). `current_values` carries only a denormalised **id array** for table rendering and the
`has any of` filter.

```sql
CREATE TABLE record_link (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid REFERENCES workspace(id) ON DELETE CASCADE,      -- §9
  attribute_id  uuid NOT NULL REFERENCES attribute_definition(id) ON DELETE CASCADE,
  source_object_type object_type NOT NULL,
  source_record_id   uuid        NOT NULL,
  target_object_type object_type NOT NULL,
  target_record_id   uuid        NOT NULL,

  -- contact ↔ organization carries: title, from, to, is_primary  (§4.3)
  metadata      jsonb NOT NULL DEFAULT '{}',
  position      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT record_link_unique UNIQUE (attribute_id, source_record_id, target_record_id)
);

CREATE INDEX record_link_fwd ON record_link (source_record_id, attribute_id, position);
CREATE INDEX record_link_rev ON record_link (target_record_id, attribute_id);   -- bidirectional UI
-- "current employer" lookups: partial index on links whose 'to' is null.
CREATE INDEX record_link_current ON record_link (target_record_id, source_record_id)
  WHERE metadata ->> 'to' IS NULL;
```

A `AFTER INSERT/UPDATE/DELETE ON record_link` trigger reprojects the affected source record's
`current_values` key. That trigger is what keeps the id array in JSONB from ever dangling: deleting an
organization cascades to `record_link`, which fires the reprojection, which removes the id.

**I do not denormalise the org *label* into `current_values`.** It would make renaming an organization
an O(contacts) write, and the brief lists no sort for the `relation` type, so the label is never needed
for ordering. The API resolves labels for the visible page in one `WHERE id = ANY($1)` batch — 50 ids,
one index scan, sub-millisecond.

### 3.6 Identifiers, interactions, follow-ups, imports

```sql
CREATE TYPE identifier_kind AS ENUM ('email','phone','linkedin_url','website',
                                     'google_contact_id','telegram','whatsapp','other');

CREATE TABLE identifier (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,        -- §9
  object_type  object_type NOT NULL,
  record_id    uuid NOT NULL,
  kind         identifier_kind NOT NULL,
  value        text NOT NULL,                 -- normalised: lowercased email, E.164, canonical slug
  source       fact_source NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identifier_unique UNIQUE NULLS NOT DISTINCT (workspace_id, kind, value)
);
CREATE INDEX identifier_record_idx ON identifier (record_id);

CREATE TABLE interaction (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,        -- §9
  type         text NOT NULL,            -- Meeting|Call|Email|Message|Intro|Event|Note
  occurred_at  timestamptz NOT NULL,
  title        text,
  body         text,
  source       text NOT NULL DEFAULT 'manual',
  current_values jsonb NOT NULL DEFAULT '{}',   -- §4.1: "model it so it would be a small change"
  embedding    vector(1536),
  search_tsv   tsvector GENERATED ALWAYS AS (
                 to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body,''))) STORED,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interaction_occurred_idx ON interaction (occurred_at DESC);

CREATE TABLE interaction_contact (
  interaction_id uuid NOT NULL REFERENCES interaction(id) ON DELETE CASCADE,
  contact_id     uuid NOT NULL REFERENCES contact(id)     ON DELETE CASCADE,
  PRIMARY KEY (interaction_id, contact_id)
);
CREATE INDEX interaction_contact_rev ON interaction_contact (contact_id, interaction_id);

CREATE TABLE followup (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,        -- §9
  title        text NOT NULL,
  contact_id   uuid NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
  due_at       date NOT NULL,
  status       text NOT NULL DEFAULT 'open',     -- open|done|snoozed
  recurrence   jsonb,
  origin       text NOT NULL DEFAULT 'manual',   -- manual|system  (§9 nudges)
  notes        text,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX followup_open_idx ON followup (contact_id, due_at) WHERE status = 'open';

CREATE TABLE import_batch (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,        -- §9
  file_name    text NOT NULL,
  object_type  object_type NOT NULL,
  row_count    integer NOT NULL,
  mapping      jsonb NOT NULL,
  imported_at  timestamptz NOT NULL DEFAULT now()
);
```

### 3.7 Derived columns (§4.7 and §5.2)

Derived values are **not** facts. They have no provenance, no history, no confidence, and they are
recomputed wholesale by a job. Putting them in `current_values` would mean the nightly warmth pass
rewrites every contact's wide row — invalidating the generated `tsvector`, dirtying every jsonb index,
and creating a fresh dead tuple per contact for the vacuum to clean. So they get their own narrow
table:

```sql
CREATE TABLE contact_metrics (
  contact_id            uuid PRIMARY KEY REFERENCES contact(id) ON DELETE CASCADE,
  workspace_id          uuid REFERENCES workspace(id) ON DELETE CASCADE,   -- §9
  last_interaction_at   timestamptz,
  interaction_count_12m integer   NOT NULL DEFAULT 0,
  open_followups        integer   NOT NULL DEFAULT 0,
  next_followup_at      date,
  warmth                smallint  NOT NULL DEFAULT 0 CHECK (warmth BETWEEN 0 AND 100),
  computed_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contact_metrics_last_idx    ON contact_metrics (last_interaction_at DESC NULLS LAST);
CREATE INDEX contact_metrics_warmth_idx  ON contact_metrics (warmth DESC);
CREATE INDEX contact_metrics_open_idx    ON contact_metrics (open_followups DESC) WHERE open_followups > 0;
CREATE INDEX contact_metrics_next_idx    ON contact_metrics (next_followup_at) WHERE next_followup_at IS NOT NULL;
CREATE INDEX contact_metrics_count_idx   ON contact_metrics (interaction_count_12m DESC);
```

Result: the four derived columns are plain typed columns with plain btree indexes, so they filter and
sort exactly like any other column with *no* special cases — which is precisely what §5.2 asks for. The
filter compiler has three resolvers behind one interface (`system column | metric column | jsonb
attribute`); the column registry in `packages/core` declares which is which, next to the system
attributes, so they appear in the Columns picker like everything else.

Cost: one extra `LEFT JOIN` on every list query. On 10k rows that is a hash join over a table of
~40 bytes/row (≈400 KB, permanently in cache), or an index nested loop for a 50-row page. Immaterial.

---

## 4. Index strategy — the honest tiering

### Tier 0 — one index, every attribute, forever

```sql
CREATE INDEX contact_cv_gin ON contact USING gin (current_values jsonb_path_ops);
```

This single index accelerates **equality and set-membership on every attribute that exists or will ever
exist**, with zero DDL when a user creates an attribute:

- `short_text/email/url/phone/single_select` **equals / is one of** → `current_values @> '{"k":"v"}'`
- `number` **=** → `current_values @> '{"k":600000}'`
- `yes_no` **is yes / is no** → `current_values @> '{"k":true}'`
- `tags/multi_select` **contains any of** → `OR` of `@>` (planner does a bitmap OR)
- `tags/multi_select` **contains all of** → one `@>` with the full array
- `relation` **has any of** → `OR` of `@>`

That is the entire reason to prefer JSONB. No other approach gives a user-created attribute a working
index the instant it is created.

**Why `jsonb_path_ops` and not the default `jsonb_ops`?** `jsonb_path_ops` supports only `@>`, `@?`,
`@@`; it drops the key-existence operators `?`, `?|`, `?&`. In exchange it is much smaller and more
selective, because it hashes the whole key path with the value instead of indexing every key and every
value independently. The only operator in the brief's table that would want `?` is **`is empty`** — and
`is empty` is a *negation* (`NOT (cv ? 'slug')`), which GIN cannot accelerate under either opclass. So
`jsonb_ops` would buy us nothing here and cost index size and selectivity.

Honest caveat: if the UI ever grows an "is not empty" operator, or a "which attributes does this record
have" query, `jsonb_ops` becomes the right choice and the swap is a one-line migration. This is a
reversible decision, logged as such.

### Tier 1 — two indexes per attribute, created with the attribute

Range, substring and sort are **not** servable by the shared GIN index. They need per-attribute
expression indexes, created automatically by the attribute-creation path:

```sql
-- number: covers  =, ≠, <, >, between, is empty, AND numeric ORDER BY
CREATE INDEX contact_cv_aum_eur_num
  ON contact (mut_num(current_values, 'aum_eur'));

-- date: covers before, after, between, relative shortcuts, is empty, AND chronological ORDER BY
CREATE INDEX contact_cv_birthday_date
  ON contact (mut_date(current_values, 'birthday'));

-- short_text / email / url / phone: 'contains' (substring)
CREATE INDEX contact_cv_city_trgm
  ON contact USING gin ((current_values ->> 'city') gin_trgm_ops);

-- short_text / email: case-insensitive alphabetical ORDER BY
CREATE INDEX contact_cv_city_sort
  ON contact (mut_text(current_values, 'city'));

-- single_select: 'is one of' via = ANY, plus 'is empty' via IS NULL
CREATE INDEX contact_cv_job_role_btree
  ON contact ((current_values ->> 'job_role'));
```

**No Tier-1 index for `long_text` (§2.2), `multi_select`, `tags` or `relation`** — the brief gives them
no sort and no range operator, and Tier 0 already covers their containment operators.

So the per-type index budget is: `number` 1, `date` 1, `short_text`/`email` 2, `url`/`phone` 1,
`single_select` 1, `yes_no` 0, everything else 0. For the 14 seeded contact attributes that is about
12 indexes; a user with 40 more custom attributes lands around 40–50.

**The cost, stated plainly:** every index is write amplification. A 10k-row import with ~50 indexes on
`contact` runs at roughly a few thousand rows/second instead of tens of thousands — call it 3–8 seconds
instead of under one. It is a background job (pg-boss) with a progress bar, so nobody notices. But it
is real, and at 100k rows it would be minutes.

**The operational smell, stated plainly:** creating an attribute issues DDL at runtime. That is DDL
outside the migration files, which is exactly the kind of thing that makes a senior reviewer wince.
Mitigations, in order of how much I believe in them:

1. A `managed_index` table records every index this system created (`attribute_id, index_name,
   definition, created_at`). A `pnpm db:verify-indexes` command diffs catalog against table and is run
   in CI against a seeded DB. The set is therefore reconstructable and auditable, never a mystery.
2. `CREATE INDEX CONCURRENTLY` off the request path, in a pg-boss job, so attribute creation returns in
   milliseconds and a failed build (which leaves an `INVALID` index) is retried by the job.
3. `drizzle-kit` must be configured to ignore these indexes so it does not try to drop them on the next
   `generate`. This is a config line, but it is a config line that will bite someone once.

### Tier 2 — what stays unindexed, on purpose

- `is empty` (a negation) — served by the Tier-1 btree's `IS NULL` scan where one exists, otherwise a
  sequential scan.
- `≠` / `is not one of` — negations.
- `ORDER BY` on `single_select` **by option order** (§5.3) — a function of the option list, which
  changes when the user reorders options, so it cannot be a stable index expression.
- `contains` with a pattern shorter than 3 characters — trigram indexes need 3 characters.

At 10k rows a sequential scan of `contact` (narrow rows, `current_values` inline, ~1.2 KB/row ≈ 12 MB,
fully cached) is single-digit milliseconds, and a top-N heapsort of 10k rows is a few milliseconds. The
honest statement is: **at this scale, the unindexed cases are fast because the table is small, not
because the design is clever.** They are the first thing to break if this ever became a multi-tenant
product.

---

## 5. Typed sorting

This is where JSONB is usually assumed to be weak, and where it is in fact strong — but only because of
invariant 3 (homogeneous types per key).

### 5.1 Numbers sort numerically, dates chronologically

Postgres's jsonb btree ordering is documented as: `Object > Array > Boolean > Number > String > null`,
and *"Primitive JSON values are compared using the same comparison rules as for the underlying
PostgreSQL data type. Strings are compared using the default database collation."* So
`ORDER BY current_values -> 'aum_eur'` already sorts **numerically**, not lexically, because jsonb
numbers are `numeric` underneath. `"9"` does not sort before `"10"`.

I still prefer the extractor form, and use it everywhere:

```sql
ORDER BY mut_num(current_values, 'aum_eur') DESC NULLS LAST, contact.id DESC
```

because (a) it yields a real `numeric`/`date` to the API layer rather than a jsonb datum, (b) it avoids
the jsonb `1` vs `1.0` equality nuance entirely, and (c) it is the same expression the range filter
uses, so **one index serves both the filter and the sort**.

To make the index actually usable for ordering, it must be declared with the same direction and null
placement the query uses:

```sql
CREATE INDEX contact_cv_aum_eur_num_desc
  ON contact (mut_num(current_values, 'aum_eur') DESC NULLS LAST, id DESC);
```

The compiler generates the index in the sort direction the saved view uses; for the rarer opposite
direction Postgres can scan a btree backwards anyway, so one index covers both if null placement lines
up. In practice: create ascending `NULLS LAST`, and let the compiler always emit `NULLS LAST` in both
directions so plans stay index-driven.

### 5.2 Text sorts alphabetically, case-insensitively

`ORDER BY mut_text(current_values,'city')` = `lower(current_values ->> 'city')` under the database
collation, backed by `contact_cv_city_sort`. `lower(text)` is marked immutable in Postgres (a known
wart, but the reason `CREATE INDEX ON t (lower(email))` is universal practice), so this is safe.

### 5.3 `single_select` sorts by option order

The option list lives in `attribute_definition.config` and the user can reorder it. Materialising a
position into `current_values` would mean an O(rows) rewrite every time somebody drags an option, which
is a bad trade for a cosmetic action. So the compiler passes the ordered option ids as a parameter:

```sql
ORDER BY array_position($1::text[], current_values ->> 'job_role') NULLS LAST, contact.id DESC
-- $1 = ARRAY['opt_founder','opt_investor','opt_operator','opt_student','opt_community','opt_other']
```

Not index-backed. `array_position` over a 6-element array × 10k rows, feeding a top-N heapsort, is a
few milliseconds. Correct, always fresh, zero invalidation. I would take this trade every time at this
scale, and I would revisit it above ~500k rows.

### 5.4 Pagination

- **Default sort** (`created_at DESC, id DESC`) uses keyset pagination:
  `WHERE (created_at, id) < ($cursor_ts, $cursor_id)` — index-driven, constant cost per page,
  which is what the virtualised 10k-row table wants.
- **Arbitrary sorts** use `LIMIT/OFFSET`. Honest limit: `OFFSET 5000` re-sorts the whole matching set.
  At 10k rows that is still tens of milliseconds; at 1M it is not. Keyset over `(mut_num(...), id)` is
  possible and I would add it only if profiling says so — three-valued NULL handling in a row
  comparison is fiddly, and "never over-engineer" applies.

---

## 6. The filter compiler: all 12 types × all operators

`cv` = `contact.current_values`, `s` = attribute slug (a validated identifier, never user SQL),
`$n` = bound parameter. `esc()` escapes `%`, `_`, `\` for LIKE. **Nothing is string-interpolated except
the slug, which is validated against `^[a-z][a-z0-9_]{0,62}$` and a reserved-word list at creation
time.** Values are always bound.

| Type | Operator | Compiled SQL | Index used |
|---|---|---|---|
| `short_text` | contains | `cv ->> 's' ILIKE '%'\|\|esc($1)\|\|'%'` | T1 trgm |
| | equals | `cv @> jsonb_build_object('s', $1::text)` | T0 GIN |
| | is empty | `NOT (cv ? 's')` | — (or T1 `IS NULL`) |
| `long_text` | contains | `EXISTS (SELECT 1 FROM fact f WHERE f.record_id=c.id AND f.attribute_id=$1 AND f.superseded_by_id IS NULL AND f.removed_at IS NULL AND f.value #>> '{}' ILIKE '%'\|\|esc($2)\|\|'%')` | `fact_text_trgm_idx` |
| | is empty | `NOT EXISTS (…same, without ILIKE…)` | `fact_live_idx` |
| `number` | = | `mut_num(cv,'s') = $1::numeric` | T1 btree |
| | ≠ | `mut_num(cv,'s') IS DISTINCT FROM $1::numeric` | — |
| | < / > | `mut_num(cv,'s') < $1::numeric` | T1 btree |
| | between | `mut_num(cv,'s') BETWEEN $1 AND $2` | T1 btree |
| | is empty | `mut_num(cv,'s') IS NULL` | T1 btree |
| `date` | before / after | `mut_date(cv,'s') < $1::date` | T1 btree |
| | between | `mut_date(cv,'s') BETWEEN $1::date AND $2::date` | T1 btree |
| | relative (last 30 days / this year) | resolved to absolute bounds **in `packages/core`**, then `between` | T1 btree |
| | is empty | `mut_date(cv,'s') IS NULL` | T1 btree |
| `yes_no` | is yes | `cv @> '{"s":true}'` | T0 GIN |
| | is no | `cv @> '{"s":false}'` | T0 GIN |
| | is empty | `NOT (cv ? 's')` | — |
| `single_select` | is one of | `cv ->> 's' = ANY($1::text[])` | T1 btree |
| | is not one of | `cv ->> 's' IS DISTINCT FROM ALL($1::text[])` | — |
| | is empty | `cv ->> 's' IS NULL` | T1 btree |
| `multi_select` | contains any of | `cv @> jsonb_build_object('s', jsonb_build_array($1)) OR cv @> …($2)…` | T0 GIN (bitmap OR) |
| | contains all of | `cv @> jsonb_build_object('s', $1::jsonb)` (`$1` = full array) | T0 GIN |
| | is empty | `NOT (cv ? 's')` | — |
| `tags` | contains any of / all of / is empty | identical to `multi_select` | T0 GIN |
| `url` | contains / is empty | identical to `short_text` | T1 trgm |
| `email` | contains / is empty | identical to `short_text` | T1 trgm |
| `phone` | contains / is empty | identical to `short_text` (value is E.164, so `+49` prefix search works) | T1 trgm |
| `relation` | has any of | `cv @> jsonb_build_object('s', jsonb_build_array($1)) OR …` (many) / `cv @> jsonb_build_object('s',$1::text)` (one) | T0 GIN |
| | is empty | `NOT (cv ? 's')` | — |
| **derived** `last_interaction_at` | more/less than N days ago, between, is empty | `m.last_interaction_at < now() - ($1 \|\| ' days')::interval` | `contact_metrics_last_idx` |
| **derived** `interaction_count_12m` | =, ≠, <, >, between | `m.interaction_count_12m > $1` | `contact_metrics_count_idx` |
| **derived** `open_followups` | =, >, is zero | `m.open_followups > $1` | `contact_metrics_open_idx` |
| **derived** `warmth` | =, ≠, <, >, between | `m.warmth BETWEEN $1 AND $2` | `contact_metrics_warmth_idx` |

Every row of that table is a pure function `(AttributeDefinition, Operator, Value[]) → SqlFragment`,
which means it is exhaustively unit-testable without a database — 12 types × ~4 operators ≈ 45 cases,
plus a golden-file test of the generated SQL string. That testability is a large part of the argument:
an EAV compiler has to decide *which value column* and *which join alias* per predicate, and its unit
tests have to reason about join trees.

---

## 7. Writing: the fact log and the projection

### 7.1 Appending a single fact (single-valued attribute)

```sql
BEGIN;

-- 1. Lock the record row. This serialises concurrent appends to the same record so the
--    projection can never lose an update. Cheap: a single row lock, held for microseconds.
SELECT id FROM contact WHERE id = $record_id FOR UPDATE;

-- 2. Insert the new fact.
INSERT INTO fact (workspace_id, object_type, record_id, attribute_id, value,
                  valid_from, observed_at, source, source_ref, confidence)
VALUES ($ws, 'contact', $record_id, $attribute_id, $value::jsonb,
        COALESCE($valid_from::date, now()::date), now(), $source, $source_ref, $confidence)
RETURNING id INTO new_fact_id;

-- 3. Supersede the previous live fact for this (record, attribute).  §4.5: nothing is deleted.
UPDATE fact
   SET superseded_by_id = new_fact_id
 WHERE record_id = $record_id
   AND attribute_id = $attribute_id
   AND id <> new_fact_id
   AND superseded_by_id IS NULL
   AND removed_at IS NULL;

-- 4. Reproject (§7.3).
COMMIT;
```

For a **multi-valued** attribute, step 3 is skipped (facts coexist), and a *removal* is:

```sql
UPDATE fact SET removed_at = now(), removed_source = $source
 WHERE record_id = $r AND attribute_id = $a AND value = $v::jsonb
   AND superseded_by_id IS NULL AND removed_at IS NULL;
```

A later re-add inserts a **new** fact rather than clearing `removed_at`, so the history reads
"added → removed → added again" truthfully.

### 7.2 Reprojection for one record

```sql
CREATE FUNCTION reproject_record(p_object_type object_type, p_record_id uuid)
RETURNS jsonb LANGUAGE sql AS $$
WITH live AS (
  SELECT f.attribute_id, f.value, f.valid_from, f.observed_at, f.created_at,
         ad.slug, ad.cardinality, ad.type
    FROM fact f
    JOIN attribute_definition ad ON ad.id = f.attribute_id
   WHERE f.object_type = p_object_type
     AND f.record_id   = p_record_id
     AND f.superseded_by_id IS NULL
     AND f.removed_at IS NULL
     AND ad.type <> 'long_text'                       -- §2.2
),
singles AS (
  SELECT DISTINCT ON (attribute_id) slug, value
    FROM live WHERE cardinality = 'one'
   ORDER BY attribute_id, valid_from DESC, observed_at DESC, created_at DESC
),
multis AS (
  SELECT slug, jsonb_agg(value ORDER BY value) AS value        -- invariant 4: canonical order
    FROM live WHERE cardinality = 'many'
   GROUP BY slug
)
SELECT COALESCE(jsonb_object_agg(slug, value), '{}'::jsonb)
  FROM (SELECT * FROM singles UNION ALL SELECT * FROM multis) x
 WHERE value IS NOT NULL AND value <> 'null'::jsonb            -- invariant 2
   AND NOT (jsonb_typeof(value) = 'array'  AND jsonb_array_length(value) = 0)
   AND NOT (jsonb_typeof(value) = 'string' AND value #>> '{}' = '');
$$;
```

Relation keys are merged in from `record_link` in the same statement (omitted above for length): a
`LEFT JOIN LATERAL` that aggregates `target_record_id::text` per relation attribute.

The trigger:

```sql
CREATE FUNCTION fact_reproject_trg() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record := COALESCE(NEW, OLD);
BEGIN
  IF current_setting('mutuals.defer_projection', true) = 'on' THEN RETURN NULL; END IF;
  IF r.object_type = 'contact' THEN
    UPDATE contact SET current_values = reproject_record('contact', r.record_id),
                       updated_at = now()
     WHERE id = r.record_id;
  ELSIF r.object_type = 'organization' THEN
    UPDATE organization SET current_values = reproject_record('organization', r.record_id),
                            updated_at = now()
     WHERE id = r.record_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER fact_reproject AFTER INSERT OR UPDATE OR DELETE ON fact
  FOR EACH ROW EXECUTE FUNCTION fact_reproject_trg();
```

The trigger exists so the invariant survives a `psql` session, a fix-up script, or a future MCP tool
that writes facts directly. The application does not rely on it for normal writes — it calls
`reproject_record` explicitly inside the transaction — but nothing can bypass it.

### 7.3 Bulk path (imports) — the important operational detail

The row-level trigger is **O(facts × facts_per_record)**: a 10k-row import writing 14 facts each would
fire 140k triggers, each re-aggregating that record's facts. That is the obvious way to make imports
unusably slow, and it is worth naming loudly.

```sql
SET LOCAL mutuals.defer_projection = 'on';
-- COPY / multi-row INSERT of all facts for the batch
RESET mutuals.defer_projection;

-- Then one set-based reprojection over just the touched records:
UPDATE contact c
   SET current_values = reproject_record('contact', c.id), updated_at = now()
 WHERE c.id = ANY($touched_ids::uuid[]);
```

`pnpm db:reproject` is the same statement without the `WHERE` — the full rebuild that proves
`current_values` is derived. Stage 1's test suite runs it after every fixture load and asserts the
projection is byte-identical before and after. That test is the whole safety argument for the
denormalisation.

### 7.4 Attribute deletion

```sql
BEGIN;
  DELETE FROM attribute_definition WHERE id = $1;   -- cascades to fact, record_link
  UPDATE contact SET current_values = current_values - $slug WHERE current_values ? $slug;
  DROP INDEX IF EXISTS contact_cv_<slug>_num, contact_cv_<slug>_trgm, …;   -- from managed_index
  DELETE FROM managed_index WHERE attribute_id = $1;
COMMIT;
```

The confirmation dialog's "how many records have a value" count comes from the fact log, not the
projection, which is both more accurate and index-backed:

```sql
SELECT count(DISTINCT record_id) FROM fact
 WHERE attribute_id = $1 AND superseded_by_id IS NULL AND removed_at IS NULL;   -- fact_attr_live_idx
```

---

## 8. Representative queries

### 8.1 The brief's headline filter

*Contacts where `job_role` is one of (Investor, Angel) AND `city` contains "Munich" AND
`areas_of_interest` contains any of (climate) AND `last_interaction_at` older than 90 days, sorted by a
custom number attribute `aum_eur` descending, paginated.*

```sql
SELECT c.id,
       c.display_name,
       c.current_values,
       m.last_interaction_at,
       m.warmth
  FROM contact c
  LEFT JOIN contact_metrics m ON m.contact_id = c.id
 WHERE c.workspace_id IS NOT DISTINCT FROM $1                     -- §9: NULL today, a uuid later
   -- job_role is one of (…)                       → contact_cv_job_role_btree
   AND c.current_values ->> 'job_role' = ANY ($2::text[])         -- ['opt_investor','opt_angel']
   -- city contains 'Munich'                       → contact_cv_city_trgm
   AND c.current_values ->> 'city' ILIKE '%' || $3 || '%'         -- 'Munich', LIKE-escaped upstream
   -- areas_of_interest contains any of ('climate')→ contact_cv_gin
   AND c.current_values @> '{"areas_of_interest":["climate"]}'::jsonb
   -- last interaction older than 90 days          → contact_metrics_last_idx
   AND (m.last_interaction_at IS NULL                             -- product choice: "never" counts as stale
        OR m.last_interaction_at < now() - ($4 || ' days')::interval)
 ORDER BY mut_num(c.current_values, 'aum_eur') DESC NULLS LAST,
          c.id DESC
 LIMIT $5 OFFSET $6;
```

Expected plan on 10k contacts: bitmap-OR of `contact_cv_job_role_btree` and `contact_cv_gin` (both
highly selective), bitmap heap scan applying the trigram-backed `ILIKE` and the metrics predicate as
recheck filters, then a top-N heapsort of the surviving few hundred rows. Sub-10 ms warm. The
`ORDER BY` index is not used here — with selective filters, top-N sorting a few hundred rows is the
better plan and Postgres will pick it. The sort index earns its keep on the *unfiltered* "all contacts,
sorted by AUM" view, where it turns a 10k-row sort into an index scan with `LIMIT`.

Whether "never interacted" should count as ">90 days ago" is a **product** decision, not a technical
one; the compiler emits the `IS NULL` branch only when the view says so.

### 8.2 Value history for one attribute (§4.5 UI)

```sql
SELECT f.id, f.value, f.valid_from, f.observed_at, f.source, f.source_ref,
       f.confidence, f.superseded_by_id, f.removed_at,
       (f.superseded_by_id IS NULL AND f.removed_at IS NULL) AS is_current
  FROM fact f
 WHERE f.record_id = $1 AND f.attribute_id = $2
 ORDER BY f.valid_from DESC, f.observed_at DESC;                 -- fact_history_idx
```

Renders directly as *"Company: Stripe — since Jun 2025, from LinkedIn import · previously Northstar —
Jan 2023, manual"*.

### 8.3 The contact detail page in two queries

```sql
-- (1) the record + its derived metrics + its projection
SELECT c.*, m.* FROM contact c LEFT JOIN contact_metrics m ON m.contact_id = c.id WHERE c.id = $1;

-- (2) everything the projection does not hold: long_text values, and every link with metadata
SELECT 'value' AS kind, ad.slug, f.value, NULL::jsonb AS metadata, NULL::uuid AS target_id
  FROM fact f JOIN attribute_definition ad ON ad.id = f.attribute_id
 WHERE f.record_id = $1 AND ad.type = 'long_text'
   AND f.superseded_by_id IS NULL AND f.removed_at IS NULL
UNION ALL
SELECT 'link', ad.slug, NULL, rl.metadata, rl.target_record_id
  FROM record_link rl JOIN attribute_definition ad ON ad.id = rl.attribute_id
 WHERE rl.source_record_id = $1
 ORDER BY 1, 2;
```

### 8.4 Bidirectional relations and "also at the same organization" (§6.5)

```sql
-- B's detail page lists A  (reverse direction of the same link rows)
SELECT c.id, c.display_name, rl.metadata ->> 'title' AS title,
       rl.metadata ->> 'from' AS from_date, rl.metadata ->> 'to' AS to_date,
       (rl.metadata ->> 'is_primary')::boolean AS is_primary
  FROM record_link rl
  JOIN contact c ON c.id = rl.source_record_id
 WHERE rl.target_record_id = $1 AND rl.target_object_type = 'organization'
 ORDER BY (rl.metadata ->> 'to') IS NOT NULL, rl.metadata ->> 'from' DESC;   -- current first, reads as a CV

-- "Also at the same organization" — derived, read-only
SELECT DISTINCT other.id, other.display_name
  FROM record_link mine
  JOIN record_link theirs
    ON theirs.target_record_id = mine.target_record_id
   AND theirs.source_record_id <> mine.source_record_id
   AND theirs.metadata ->> 'to' IS NULL
  JOIN contact other ON other.id = theirs.source_record_id
 WHERE mine.source_record_id = $1 AND mine.metadata ->> 'to' IS NULL;        -- record_link_current
```

### 8.5 Global search (§4.8) — the ⌘K palette

```sql
-- names: substring, so trigram, not tsvector
CREATE INDEX contact_name_trgm ON contact USING gin (lower(display_name) gin_trgm_ops);

(SELECT 'contact' AS kind, id, display_name AS label,
        similarity(lower(display_name), $1) AS score
   FROM contact WHERE lower(display_name) % $1
  ORDER BY score DESC LIMIT 8)
UNION ALL
(SELECT 'organization', id, name, similarity(lower(name), $1) FROM organization
  WHERE lower(name) % $1 ORDER BY 4 DESC LIMIT 5)
UNION ALL
(SELECT 'contact', id, display_name, ts_rank(search_tsv, websearch_to_tsquery('simple',$1))
   FROM contact WHERE search_tsv @@ websearch_to_tsquery('simple',$1) ORDER BY 4 DESC LIMIT 5)
UNION ALL
(SELECT 'interaction', id, title, ts_rank(search_tsv, websearch_to_tsquery('simple',$1))
   FROM interaction WHERE search_tsv @@ websearch_to_tsquery('simple',$1) ORDER BY 4 DESC LIMIT 5);
```

Two mechanisms, deliberately: trigram for the "type three letters of a name" palette behaviour the
brief asks for (substring), tsvector for word search over bodies and every custom string attribute.

### 8.6 The derived-metrics refresh (nightly + on demand)

```sql
INSERT INTO contact_metrics (contact_id, workspace_id, last_interaction_at,
                             interaction_count_12m, open_followups, next_followup_at, warmth, computed_at)
SELECT c.id, c.workspace_id,
       i.last_at,
       COALESCE(i.cnt_12m, 0),
       COALESCE(f.open_cnt, 0),
       f.next_due,
       CASE WHEN c.not_important     THEN LEAST(10, w.warmth)
            WHEN c.pinned_important  THEN GREATEST(60, w.warmth)
            ELSE w.warmth END,
       now()
  FROM contact c
  LEFT JOIN LATERAL (
        SELECT max(ix.occurred_at) AS last_at,
               count(*) FILTER (WHERE ix.occurred_at > now() - interval '365 days') AS cnt_12m
          FROM interaction_contact ic JOIN interaction ix ON ix.id = ic.interaction_id
         WHERE ic.contact_id = c.id) i ON true
  LEFT JOIN LATERAL (
        SELECT count(*) AS open_cnt, min(due_at) AS next_due
          FROM followup fu WHERE fu.contact_id = c.id AND fu.status = 'open') f ON true
  LEFT JOIN LATERAL (
        SELECT round(100 * (1 - exp(-$1::numeric * COALESCE(sum(
                 CASE ix.type WHEN 'Meeting' THEN 3.0 WHEN 'Call' THEN 2.5 WHEN 'Event' THEN 2.0
                              WHEN 'Intro'   THEN 2.0 WHEN 'Note' THEN 1.5 WHEN 'Message' THEN 1.0
                              ELSE 0.7 END
                 * exp(-EXTRACT(epoch FROM now() - ix.occurred_at) / 86400.0 / 90.0)), 0))))::smallint
                 AS warmth
          FROM interaction_contact ic JOIN interaction ix ON ix.id = ic.interaction_id
         WHERE ic.contact_id = c.id AND ix.occurred_at > now() - interval '365 days') w ON true
ON CONFLICT (contact_id) DO UPDATE SET
  last_interaction_at   = EXCLUDED.last_interaction_at,
  interaction_count_12m = EXCLUDED.interaction_count_12m,
  open_followups        = EXCLUDED.open_followups,
  next_followup_at      = EXCLUDED.next_followup_at,
  warmth                = EXCLUDED.warmth,
  computed_at           = EXCLUDED.computed_at;
```

The SQL above is the **batch** implementation. The brief requires warmth to be *"a pure function in
`packages/core` with unit tests"* — so `packages/core` owns the reference implementation in TypeScript,
and a property test asserts the SQL and the TS agree on a fixture set to within rounding. If they ever
diverge, the test says so. (I would happily drop the SQL version and do the nightly pass in TypeScript
over batched rows if the co-founder prefers one implementation; at 10k contacts either is sub-second.)

### 8.7 Duplicate detection (§4.6) — identifiers first, names never first

```sql
-- 1. certain: shared identifier
SELECT i2.record_id, i2.kind, i2.value
  FROM identifier i1 JOIN identifier i2 ON i2.kind = i1.kind AND i2.value = i1.value
                                       AND i2.record_id <> i1.record_id
 WHERE i1.record_id = $1;

-- 2. fallback only: name + organization similarity
SELECT c.id, similarity(lower(c.display_name), lower($2)) AS name_sim
  FROM contact c
 WHERE lower(c.display_name) % lower($2)
   AND c.current_values @> jsonb_build_object('organization', jsonb_build_array($3::text))
 ORDER BY name_sim DESC LIMIT 5;
```

---

## 9. Full-text now, vectors later, one database

- **tsvector now:** a `STORED` generated column, no trigger, no application code, automatically
  covering every custom string attribute via `jsonb_to_tsvector('simple', current_values, '["string"]')`.
  Index: `CREATE INDEX contact_tsv_idx ON contact USING gin (search_tsv);`
- **pgvector later:** the `vector(1536)` column exists from Stage 1 and is `NULL`. Adding a nullable
  column later would be instant anyway, but having it present means the `search` API's `mode` parameter
  (`keyword` | `semantic`) has somewhere to point from day one. The index is added when embeddings are
  backfilled:
  ```sql
  CREATE INDEX contact_embedding_hnsw ON contact
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
  ```
  Verified constraint: pgvector's HNSW index supports up to **2000 dimensions** for `vector`
  (4000 for `halfvec`), while the `vector` type itself allows 16000. So the model choice is
  constrained by the *index*, not the column: `text-embedding-3-small` (1536) fits; a 3072-dim model
  would need `halfvec` or dimension reduction. Worth writing into `ARCHITECTURE.md` now so nobody
  picks a 4096-dim model in Stage 8 and discovers this the hard way.
- Neither of these interferes with the JSONB design. They are extra columns on the same row, and
  `SET STORAGE MAIN` on `current_values` keeps the wide row from pushing the vector out of line.

---

## 10. Weaknesses — the honest list

I would rather write these than have them found.

1. **No type enforcement in the database.** EAV with typed columns (`value_text`, `value_number`,
   `value_date`) gets a `CHECK` constraint and real column types for free. Here, a bug in the write path
   can put `"600000"` (string) where `600000` (number) belongs, and `mut_num` will return `NULL` rather
   than raise — so the row silently disappears from a numeric filter. **This is the single strongest
   argument against my approach.** Mitigations: (a) a Zod codec per type is the only writer;
   (b) a `CHECK` on `fact.value` using `jsonb_typeof` per attribute type is not expressible (it needs a
   lookup), but a trigger on `fact` *can* validate against `attribute_definition.type` and I would add
   it; (c) a nightly audit query flags every type mismatch:
   ```sql
   SELECT ad.slug, jsonb_typeof(c.current_values -> ad.slug) AS actual, ad.type AS expected, count(*)
     FROM contact c JOIN attribute_definition ad ON ad.object_type='contact'
    WHERE c.current_values ? ad.slug
      AND jsonb_typeof(c.current_values -> ad.slug) <> CASE ad.type
            WHEN 'number' THEN 'number' WHEN 'yes_no' THEN 'boolean'
            WHEN 'multi_select' THEN 'array' WHEN 'tags' THEN 'array'
            ELSE 'string' END
    GROUP BY 1,2,3;
   ```
   None of that is as good as a column type. It is a real cost, paid for schema flexibility.
2. **Runtime DDL.** Creating an attribute issues `CREATE INDEX`. Managed and audited (§4 Tier 1), but it
   is still DDL outside migrations, and it is the thing most likely to surprise a future contributor.
3. **Planner statistics are weak for jsonb.** Postgres has no per-key statistics inside a jsonb column.
   `@>` selectivity is estimated from a fixed default, so on a query with several jsonb predicates plus
   joins the planner can pick a bad order. Expression indexes bring their own stats for the keys they
   cover, and `CREATE STATISTICS` (PG14+) on expressions can help further — but a real column with a
   real histogram is simply better informed. At 10k rows and single-table queries this rarely bites.
   At 1M rows with joins it would.
4. **Write amplification.** One fact append rewrites the entire `current_values` datum (a new row
   version under MVCC), recomputes the generated `tsvector`, and touches every Tier-1 index on that
   table. EAV updates one narrow row and one index. Filling a 40-attribute contact one attribute at a
   time = 40 full row rewrites. Irrelevant at a few hundred writes a day; not irrelevant at scale.
5. **The TOAST cliff.** If `current_values` exceeds roughly 2 KB, the datum goes out of line and every
   query that touches *any* key pays a detoast. Excluding `long_text` (§2.2) and `SET STORAGE MAIN`
   push this out to roughly 100–150 populated attributes per record. Past that, list-query latency
   degrades in a step, not a slope — which makes it a nasty surprise rather than a gradual slowdown.
6. **`is empty` and `≠` are unindexable negations.** Fine at 10k rows (a cached seq scan). Not fine at
   1M.
7. **Sorting `single_select` by option order is a per-row function call, not an index.** Correct and
   always fresh, but a full sort.
8. **Relation ids inside JSONB have no foreign key.** `record_link` is the integrity boundary; the
   JSONB copy is only correct because a trigger keeps it so. A trigger that is dropped or a manual
   `UPDATE contact SET current_values = …` in psql breaks it silently. `pnpm db:reproject` fixes it, and
   CI proves reprojection is a no-op — but the invariant lives in a trigger, not in a constraint.
9. **jsonb number normalisation.** jsonb stores numbers as `numeric` and preserves scale in the text
   representation, so `{"n":1}` and `{"n":1.0}` are different byte strings even though they compare
   equal. Using `mut_num()` sidesteps this for filters and sorts, but `@>` containment on numbers, and
   byte-equality change detection, both want normalisation on write. The codec strips trailing zeros.
10. **Debuggability.** `SELECT * FROM contact` in psql prints a 900-byte jsonb blob per row. EAV rows
    are readable. A `contact_readable` view (`jsonb_pretty`, or a pivot of the top 10 attributes) is a
    ten-line fix, but it is a fix for a problem EAV does not have.
11. **`workspace_id` is nullable everywhere and therefore not usable as an index prefix today.** Every
    unique constraint uses `NULLS NOT DISTINCT` so uniqueness is actually enforced (§3.2). When
    workspaces become real, the composite indexes need to be rebuilt with `workspace_id` first — a
    mechanical migration, but a migration, and one that touches ~15 indexes.

---

## 11. Where this stops working, with numbers

| Dimension | Comfortable | Degrades | Breaks |
|---|---|---|---|
| Records per object type | ≤ 100k | 100k–1M (negations and unindexed sorts become seconds) | > 1M with multi-predicate jsonb filters — bad plans from weak selectivity estimates |
| Populated attributes per record | ≤ 60 (~900 B) | 60–150 (~2 KB, at the TOAST boundary) | > 150 — every list query detoasts; a 10k-row scan goes from ~30 ms to 300 ms+ |
| Tier-1 indexes on one table | ≤ 40 | 40–80 (import throughput roughly halves) | > 100 — a 10k-row import goes from seconds to minutes |
| Fact appends per second, same record | ≤ 100 | 100–500 (the `FOR UPDATE` row lock serialises) | > 500 — projection becomes the bottleneck; would need debounced async reprojection |
| Attributes filtered simultaneously | ≤ 4 | 5–8 | > 8 — the planner's jsonb estimates compound and plans become unstable |

**The escape hatch, and it is a good one:** because the fact log is the truth and `current_values` is
derived, promoting a hot attribute to a real typed column is a *pure additive* migration. Add
`contact.city text`, backfill from the projection, teach the column registry that `city` resolves to a
system column instead of a jsonb key, and the filter compiler emits `c.city ILIKE …` instead of
`c.current_values ->> 'city' ILIKE …`. No API change, no UI change, no data loss. That path — start
JSONB, promote the 5–10 attributes that matter when they matter — is exactly what "build what the
current stage needs, leave clean extension points" means here.

---

## 12. Verified vs assumed

**Verified against current documentation (September 2026):**

- GIN opclasses: `jsonb_ops` supports `?`, `?|`, `?&`, `@>`, `@?`, `@@`; `jsonb_path_ops` supports only
  `@>`, `@?`, `@@`, is "usually much smaller" and "faster to search", and produces no entries for empty
  JSON structures. — postgresql.org/docs/16/datatype-json.html
- jsonb ordering: `Object > Array > Boolean > Number > String > null`; *"Primitive JSON values are
  compared using the same comparison rules as for the underlying PostgreSQL data type. Strings are
  compared using the default database collation."* — same page. This is what makes `ORDER BY cv->'k'`
  sort numbers numerically.
- Postgres 16 implements **stored** generated columns only; the expression must use immutable functions
  and cannot reference other rows. — postgresql.org/docs/16/ddl-generated-columns.html
- `to_tsvector(regconfig, …)` and `to_tsvector(regconfig, json[b])` are marked **immutable**; the
  forms without an explicit config are only stable (they depend on `default_text_search_config`) and
  cannot be used in indexes or generated columns. — postgresql.org mailing-list commit
  "Mark to_tsvector(regconfig,json[b]) functions immutable".
- Text→date/timestamp casts are **not** immutable (they depend on `DateStyle`), so
  `CREATE INDEX … ((j->>'d')::date)` fails; the documented workarounds are a maintained column or a
  hand-written immutable parser. — postgresql.org mailing-list threads on
  "functions in index expression must be marked IMMUTABLE".
- `UNIQUE NULLS NOT DISTINCT` was added in Postgres 15. — PG15 release notes.
- pgvector 0.8.6: `vector` allows up to 16000 dimensions, but **HNSW and IVFFlat indexes support at most
  2000 dimensions for `vector` and 4000 for `halfvec`**; HNSW defaults `m=16, ef_construction=64`.
  — github.com/pgvector/pgvector
- Drizzle ORM 0.45.x (paired with drizzle-kit 0.31.x) is still a v0 line — 0.45.0/0.45.1 were bugfix
  releases (pg-native pool detection, subqueries in select fields, `$onUpdate` with SQL values), with
  the breaking changes queued behind the separate v1.0.0-beta stream. It has `jsonb()` with `$type<>()`,
  `generatedAlwaysAs()` for stored generated columns, and a `vector({ dimensions })` type; it does not
  create extensions for you. — orm.drizzle.team

**Assumed / to prove in Stage 1:**

- That a SQL wrapper function (`mut_num`, `mut_date`) in an index expression is matched against the
  same call in a query after the planner's constant folding. I believe Postgres const-folds index
  expressions on relcache load specifically so this works, but I have not re-verified it against the
  16.x source. **Stage 1 must contain `EXPLAIN`-asserting tests per index shape.** If it fails, the
  compiler emits the inlined `CASE` expression on both sides, which matches by construction.
- The latency figures in §11 are extrapolations from the shape of the plans, not measurements. Stage 1
  should seed 10k contacts × 60 attributes and record real `EXPLAIN (ANALYZE, BUFFERS)` numbers in
  `docs/ARCHITECTURE.md`. If any of my numbers are wrong, that is where it will show.
- That `jsonb_to_tsvector` inside a `STORED` generated column is accepted by Postgres 16 (it is
  immutable, so it should be) — trivially checked by running the migration.
- That drizzle-kit can be told to ignore runtime-created indexes without a fight. If it cannot, the
  Tier-1 indexes move into a hand-written migration file per attribute, generated by the app and
  committed — clunkier, but not a blocker.
