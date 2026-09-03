# Storage proposal: typed EAV for dynamic attributes + append-only fact log

**Position:** one `attribute_values` table with typed columns (`text_value`, `number_value`,
`date_value`, `bool_value`, `ref_value`), one row per record per attribute per value, joined
per predicate as a semi-join. The `facts` table has the *same typed columns*, and
`attribute_values` is a pure, mechanical projection of it.

Target: Postgres 16 + `pgvector` + `pg_trgm`. Drizzle 0.45.x as the query layer, with the
dynamic filter compiler emitting parameterised SQL via Drizzle's `sql` template.

---

## 0. The honest framing, up front

Two things a judge should know before reading the argument, because they change what the
decision is actually about.

**1. At this scale the performance debate is a tie.** The brief says 10k rows, "a few thousand
contacts". 10k contacts × ~15 attributes with values ≈ **150k rows** in `attribute_values`.
Heap ≈ 25–30 MB, six indexes ≈ 40–50 MB, **~80 MB total — the entire attribute store fits in
default `shared_buffers` (128 MB) with room to spare.** A sequential scan of that table is
~15 ms. So does JSONB-with-GIN. So would a spreadsheet. Anyone claiming a 10× win for either
design at 10k rows is selling something.

**2. Therefore the decision is not about speed. It is about which shape makes §4.5 cheap.**
The brief's fact log is *already an EAV table*: `(record_id, attribute_id, typed value,
valid_from, observed_at, source, confidence, superseded_by_id)`. One row per record per
attribute per observation. You are building that table no matter which design you pick.

The only question is what the *current-value* projection looks like:

- **Typed EAV:** projection is `INSERT INTO attribute_values SELECT <same columns> FROM facts`.
  Same column types, same operators, same indexes. One `DISTINCT ON`. No serialisation layer.
- **JSONB `current_values`:** projection is a per-type serialiser that turns `date_value date`
  into `"2025-06-01"` inside a document, and a per-type deserialiser + cast on every read and
  every index. Two representations of the same 12 types that must agree forever, across a
  filter compiler, an import path, an LLM extraction path and an MCP server.

That asymmetry — **the fact log is EAV, so an EAV projection is a copy and a JSONB projection
is a translation** — is the single strongest argument here, and it is an architecture argument,
not a benchmark argument. Everything below is detail.

I will name the real costs in §9 and §10. They are not small.

---

## 1. Shape

```
workspaces
│
records ──────────────────┬── contacts        (first_name, last_name, display_name, warmth overrides)
 (supertype: id,          ├── organizations   (name)
  object_type,            │
  provenance,             ├── identifiers      (§4.6, kind+value unique)
  display_label,          ├── contact_metrics  (§4.7 derived: real typed columns)
  search_tsv,             ├── embeddings       (§9, halfvec, separate table)
  workspace_id)           │
                          ├── facts ──────────► attribute_values   (projection; the EAV table)
                          │   (append-only)      (current value; 1 row per value)
                          │
attribute_definitions ────┴── attribute_options (single/multi select, ordered)

interactions ── interaction_contacts ── contacts
follow_ups ─── contacts
```

**Why a `records` supertype and not two independent tables.** `attribute_values`, `facts`,
`identifiers` and `embeddings` all need to point at "a contact *or* an organization", and the
`relation` attribute type targets either. Postgres has no polymorphic foreign key. The
supertype gives real `ON DELETE CASCADE` (§4.5: "deleting a record deletes its facts"), one
target for the relation type, and one place for global search and provenance. Cost: one extra
join on every list query and an extra insert on every create. At 10k rows, ~0.2 ms. I think
that is obviously worth real referential integrity, but it is a genuine cost and a reviewer
may disagree.

---

## 2. DDL

### 2.1 Extensions, enums, workspaces

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector 0.8.2

CREATE TYPE object_type AS ENUM ('contact', 'organization');

-- Fixed by the brief; §4.2 explicitly forbids changing an attribute's type,
-- so an enum (cheap, 4 bytes, self-documenting) is safe here.
CREATE TYPE attribute_type AS ENUM (
  'short_text','long_text','number','date','yes_no','single_select',
  'multi_select','tags','url','email','phone','relation'
);

-- NOT an enum: §9 adds gmail, calendar, telegram, whatsapp, crawler over time and
-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction that adds it.
-- text + CHECK is migration-friendly.
CREATE DOMAIN fact_source AS text
  CHECK (VALUE IN ('manual','import','quick_capture','agent','gmail','calendar','crawler'));

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

### 2.2 Records supertype and subtypes

```sql
CREATE TABLE import_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id),
  file_name    text NOT NULL,
  object_type  object_type NOT NULL,
  row_count    integer NOT NULL DEFAULT 0,
  mapping      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- opaque config, never filtered on
  imported_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid REFERENCES workspaces(id),          -- §9: nullable everywhere
  object_type      object_type NOT NULL,

  -- §4.4 provenance, as columns not a jsonb blob: §6.8 filters by import_batch_id
  created_via      text NOT NULL DEFAULT 'manual'
                     CHECK (created_via IN ('manual','import','api','agent')),
  import_batch_id  uuid REFERENCES import_batches(id) ON DELETE SET NULL,
  last_enriched_at timestamptz,
  enriched_by      text,

  display_label    text NOT NULL DEFAULT '',   -- denormalised name, for search + relation chips
  search_tsv       tsvector,                   -- §4.8 full-text
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE INDEX records_list_idx
  ON records (object_type, created_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX records_batch_idx
  ON records (import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX records_tsv_idx    ON records USING gin (search_tsv);
-- §4.8 says *substring* search. tsvector does lexemes, not substrings:
-- 'Ann' will not match 'Hannah' via to_tsquery. trgm does. We index both.
CREATE INDEX records_label_trgm_idx
  ON records USING gin (display_label gin_trgm_ops);

CREATE TABLE contacts (
  id               uuid PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
  first_name       text,
  last_name        text,
  -- verified: PG16 supports STORED generated columns; concat/trim are immutable
  display_name     text GENERATED ALWAYS AS (
                     btrim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))
                   ) STORED,
  pinned_important boolean NOT NULL DEFAULT false,   -- §4.7 warmth floor 60
  not_important    boolean NOT NULL DEFAULT false    -- §4.7 warmth cap 10
);
CREATE INDEX contacts_display_name_idx ON contacts (display_name);

CREATE TABLE organizations (
  id   uuid PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
  name text NOT NULL
);
CREATE INDEX organizations_name_idx ON organizations (name);
```

### 2.3 Attribute definitions and options

```sql
CREATE TABLE attribute_definitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id),
  object_type  object_type NOT NULL,
  title        text NOT NULL,
  slug         text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9_]{0,62}$'),
  type         attribute_type NOT NULL,
  is_multi     boolean NOT NULL,          -- tags, multi_select, relation-many
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- unit, decimals, target_object_type,
                                                     -- has_link_metadata, min/max
  attr_group   text,
  description  text,
  is_system    boolean NOT NULL DEFAULT false,
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ad_multi_matches_type CHECK (
    (type IN ('tags','multi_select') AND is_multi)
    OR (type = 'relation')                       -- one-or-many from config
    OR (type NOT IN ('tags','multi_select','relation') AND NOT is_multi)
  ),

  -- THE TRAP §9 SETS: workspace_id is nullable and always NULL in Phase 1.
  -- A plain UNIQUE treats every NULL as distinct, so 'email' could be created twice.
  -- NULLS NOT DISTINCT (PG15+) is the fix and it is not optional.
  CONSTRAINT ad_slug_unique UNIQUE NULLS NOT DISTINCT (workspace_id, object_type, slug)
);

CREATE TABLE attribute_options (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id),
  attribute_id uuid NOT NULL REFERENCES attribute_definitions(id) ON DELETE CASCADE,
  label        text NOT NULL,
  color        text,
  position     integer NOT NULL,           -- THE sort key for single_select (§4.2 "option order")
  archived_at  timestamptz,
  CONSTRAINT ao_label_unique UNIQUE (attribute_id, label)
);
CREATE INDEX attribute_options_order_idx ON attribute_options (attribute_id, position);
```

### 2.4 The fact log (§4.5)

```sql
CREATE TABLE facts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid REFERENCES workspaces(id),
  record_id        uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  attribute_id     uuid NOT NULL REFERENCES attribute_definitions(id) ON DELETE CASCADE,
  value_type       attribute_type NOT NULL,

  -- The typed slots. Identical set and identical types to attribute_values,
  -- so the projection is a column-for-column copy.
  text_value       text,
  number_value     numeric,
  date_value       date,
  bool_value       boolean,
  ref_value        uuid,        -- option id (selects) or target record id (relation)

  -- §4.3 link metadata for relation attributes. Four extra nullable columns cost
  -- 4 bits in the null bitmap on the 99% of rows where they are NULL — not 4 words.
  link_title       text,
  link_from        date,
  link_to          date,        -- NULL = current
  link_is_primary  boolean,

  -- normalised scalar rendering of the value; identity key for multi-valued add/remove
  value_key        text NOT NULL,

  valid_from       date NOT NULL,
  observed_at      timestamptz NOT NULL DEFAULT now(),
  source           fact_source NOT NULL,
  source_ref       text,                                   -- import batch id, interaction id
  confidence       numeric(3,2) NOT NULL DEFAULT 1.0
                     CHECK (confidence >= 0 AND confidence <= 1),
  superseded_by_id uuid REFERENCES facts(id) ON DELETE SET NULL,
  removed_at       timestamptz,           -- §4.5: multi-valued removal is a fact, not a delete
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT facts_slot_matches_type CHECK (
    CASE value_type
      WHEN 'number'   THEN num_nonnulls(text_value, date_value, bool_value, ref_value) = 0
                            AND number_value IS NOT NULL
      WHEN 'date'     THEN num_nonnulls(text_value, number_value, bool_value, ref_value) = 0
                            AND date_value IS NOT NULL
      WHEN 'yes_no'   THEN num_nonnulls(text_value, number_value, date_value, ref_value) = 0
                            AND bool_value IS NOT NULL
      WHEN 'single_select' THEN num_nonnulls(text_value, number_value, date_value, bool_value) = 0
                            AND ref_value IS NOT NULL
      WHEN 'multi_select'  THEN num_nonnulls(text_value, number_value, date_value, bool_value) = 0
                            AND ref_value IS NOT NULL
      WHEN 'relation'      THEN num_nonnulls(text_value, number_value, date_value, bool_value) = 0
                            AND ref_value IS NOT NULL
      ELSE  -- short_text, long_text, tags, url, email, phone
        num_nonnulls(number_value, date_value, bool_value, ref_value) = 0
        AND text_value IS NOT NULL AND text_value <> ''
    END
  ),
  CONSTRAINT facts_link_only_on_relation CHECK (
    value_type = 'relation'
    OR num_nonnulls(link_title, link_from, link_to, link_is_primary) = 0
  ),
  CONSTRAINT facts_link_dates CHECK (link_from IS NULL OR link_to IS NULL OR link_from <= link_to)
);

-- §4.5 UI: "hovering an attribute value shows its history"
CREATE INDEX facts_history_idx
  ON facts (record_id, attribute_id, valid_from DESC, observed_at DESC);
-- projection rebuild: find the live facts for one record+attribute
CREATE INDEX facts_live_idx
  ON facts (record_id, attribute_id)
  WHERE superseded_by_id IS NULL AND removed_at IS NULL;
CREATE INDEX facts_source_ref_idx ON facts (source, source_ref) WHERE source_ref IS NOT NULL;
```

Note there is **no unique constraint on `facts`**. It is append-only and may legitimately hold
two live observations of "Munich" from two sources — that is the point of §4.5 ("a conflict
between two sources is visible instead of lost"). Deduplication happens in the projection.

### 2.5 The EAV table

```sql
CREATE TABLE attribute_values (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid REFERENCES workspaces(id),
  record_id       uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  attribute_id    uuid NOT NULL REFERENCES attribute_definitions(id) ON DELETE CASCADE,
  value_type      attribute_type NOT NULL,      -- denormalised: lets CHECK work, helps the planner
  position        integer NOT NULL DEFAULT 0,   -- order within a multi-valued attribute

  text_value      text,
  number_value    numeric,
  date_value      date,
  bool_value      boolean,
  ref_value       uuid,

  option_rank     integer,   -- denormalised attribute_options.position; §4.2 "sort by option order"

  link_title      text,
  link_from       date,
  link_to         date,
  link_is_primary boolean,

  value_key       text NOT NULL,                -- lower()'d scalar rendering; identity + tag match
  fact_id         uuid NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT av_slot_matches_type CHECK ( /* identical to facts_slot_matches_type */
    CASE value_type
      WHEN 'number' THEN num_nonnulls(text_value, date_value, bool_value, ref_value) = 0
                          AND number_value IS NOT NULL
      WHEN 'date'   THEN num_nonnulls(text_value, number_value, bool_value, ref_value) = 0
                          AND date_value IS NOT NULL
      WHEN 'yes_no' THEN num_nonnulls(text_value, number_value, date_value, ref_value) = 0
                          AND bool_value IS NOT NULL
      WHEN 'single_select' THEN ref_value IS NOT NULL AND option_rank IS NOT NULL
      WHEN 'multi_select'  THEN ref_value IS NOT NULL AND option_rank IS NOT NULL
      WHEN 'relation'      THEN ref_value IS NOT NULL
      ELSE text_value IS NOT NULL AND text_value <> ''
    END
  ),

  -- Idempotency: re-importing the same LinkedIn export cannot create a second
  -- "climate" tag on the same contact (§6.8 "import must be idempotent enough").
  CONSTRAINT av_one_value_per_key UNIQUE (record_id, attribute_id, value_key)
);
```

**The six indexes that do all the work.** Every one leads with `attribute_id`, so each
attribute owns a contiguous key range: `attribute_id = $1 AND date_value < $2` is a tight
range scan, and `ORDER BY (attribute_id, number_value)` is an **index-ordered scan with no
sort node at all**.

```sql
CREATE INDEX av_text_idx   ON attribute_values (attribute_id, text_value, record_id)
  WHERE text_value IS NOT NULL;
CREATE INDEX av_number_idx ON attribute_values (attribute_id, number_value, record_id)
  WHERE number_value IS NOT NULL;
CREATE INDEX av_date_idx   ON attribute_values (attribute_id, date_value, record_id)
  WHERE date_value IS NOT NULL;
CREATE INDEX av_bool_idx   ON attribute_values (attribute_id, bool_value, record_id)
  WHERE bool_value IS NOT NULL;
CREATE INDEX av_ref_idx    ON attribute_values (attribute_id, ref_value, record_id)
  WHERE ref_value IS NOT NULL;
CREATE INDEX av_key_idx    ON attribute_values (attribute_id, value_key, record_id);
CREATE INDEX av_rank_idx   ON attribute_values (attribute_id, option_rank, record_id)
  WHERE option_rank IS NOT NULL;

-- "contains" on any text-ish attribute, no left anchor needed
CREATE INDEX av_text_trgm_idx ON attribute_values USING gin (text_value gin_trgm_ops)
  WHERE text_value IS NOT NULL;

-- hydration: fetch all values for the 50 records on screen
CREATE INDEX av_hydrate_idx ON attribute_values (record_id, attribute_id, position);

-- reverse relation traversal: "which contacts point at this organization" (§4.3 bidirectional)
CREATE INDEX av_reverse_ref_idx ON attribute_values (ref_value, attribute_id, record_id)
  WHERE ref_value IS NOT NULL;

-- §6.5 "current organization first", and the header's primary org
CREATE INDEX av_link_current_idx ON attribute_values (record_id, attribute_id, link_to NULLS FIRST)
  WHERE ref_value IS NOT NULL AND value_type = 'relation';
```

**This is the headline win.** A user creating a 15th attribute in Settings runs **zero DDL**.
No `ALTER TABLE`, no `CREATE INDEX`, no migration, no lock. Their new attribute is
filterable *and index-ordered-sortable* the instant the definition row is committed, because
these seven indexes already cover it. That is the property §4.2 is actually asking for.

### 2.6 Derived columns (§4.7, §5.2)

Derived columns are **not** EAV. They are fixed, known at compile time, and computed — so they
are real typed columns in a 1:1 table, which makes them filterable and sortable exactly like a
system column with no special casing anywhere.

```sql
CREATE TABLE contact_metrics (
  contact_id           uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  workspace_id         uuid REFERENCES workspaces(id),
  last_interaction_at  timestamptz,
  interaction_count_12m integer NOT NULL DEFAULT 0,
  open_followups       integer NOT NULL DEFAULT 0,
  next_followup_at     date,
  warmth               smallint NOT NULL DEFAULT 0 CHECK (warmth BETWEEN 0 AND 100),
  computed_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cm_last_interaction_idx ON contact_metrics (last_interaction_at NULLS FIRST, contact_id);
CREATE INDEX cm_warmth_idx           ON contact_metrics (warmth DESC, contact_id);
CREATE INDEX cm_open_followups_idx   ON contact_metrics (open_followups DESC, contact_id);

CREATE TABLE organization_metrics (
  organization_id      uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  people_count         integer NOT NULL DEFAULT 0,
  last_interaction_at  timestamptz,
  computed_at          timestamptz NOT NULL DEFAULT now()
);
```

Refresh policy: incrementally on interaction/follow-up write (targeted recompute for the
affected contact ids, inside the same transaction), plus a nightly full pass — necessary
regardless of writes because warmth decays with `exp(−days_ago/90)`, so it changes every day
even for an untouched contact. `warmth` is computed by the pure TS function in
`packages/core` (§4.7 requires that) and written here; the nightly pass is 10k rows, well
under a second.

The filter compiler therefore has **two backends** behind one filter model: `column` (system
columns + derived metrics) and `eav` (custom attributes). The API and the DataTable never
know the difference. This is a deliberate refusal to make EAV do everything.

### 2.7 Identifiers, interactions, follow-ups, embeddings

```sql
CREATE TABLE identifiers (                    -- §4.6
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id),
  record_id  uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('email','phone','linkedin_url','website',
                                           'google_contact_id','telegram','whatsapp','other')),
  value      text NOT NULL,                   -- normalised: lower(email), E.164, canonical slug
  source     fact_source NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identifiers_unique UNIQUE (kind, value)
);
CREATE INDEX identifiers_record_idx ON identifiers (record_id);
```

Worth calling out: **uniqueness of emails lives here, not in the attribute system.** EAV
cannot express "this attribute's values must be globally unique" — and neither can JSONB. The
brief already solved that by giving identifiers their own table, so it is not a cost of this
design; it is a cost of *any* dynamic-attribute design, already paid.

```sql
CREATE TABLE interactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id),
  type         text NOT NULL CHECK (type IN ('Meeting','Call','Email','Message','Intro','Event','Note')),
  occurred_at  timestamptz NOT NULL,
  title        text,
  body         text,
  source       text NOT NULL DEFAULT 'manual',
  search_tsv   tsvector,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE interaction_contacts (
  interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  contact_id     uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (interaction_id, contact_id)
);
CREATE INDEX ic_contact_idx ON interaction_contacts (contact_id, interaction_id);
CREATE INDEX interactions_occurred_idx ON interactions (occurred_at DESC);
CREATE INDEX interactions_tsv_idx ON interactions USING gin (search_tsv);

CREATE TABLE follow_ups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id),
  contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  title        text NOT NULL,
  due_at       date NOT NULL,
  status       text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Done','Snoozed')),
  recurrence   text,                                   -- RRULE-ish
  origin       text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','system')),
  notes        text,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX followups_open_idx ON follow_ups (contact_id, due_at) WHERE status = 'Open';

-- §9, later. Separate table so `records` stays narrow, several models can coexist,
-- and the HNSW index only covers the live model.
CREATE TABLE embeddings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id),
  owner_type   text NOT NULL CHECK (owner_type IN ('record','interaction')),
  owner_id     uuid NOT NULL,
  model        text NOT NULL,
  content_hash bytea NOT NULL,                 -- skip re-embedding unchanged content
  embedding    halfvec(1536),                  -- pgvector 0.8.x: half the bytes of vector
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT embeddings_unique UNIQUE (owner_type, owner_id, model)
);
-- Add only when semantic search ships:
-- CREATE INDEX embeddings_hnsw_idx ON embeddings
--   USING hnsw (embedding halfvec_cosine_ops) WHERE model = 'text-embedding-3-small';
```

---

## 3. All 12 types: slot, operator, sort

| Type | Slot | `is_multi` | Filter operators → SQL | Sort |
|---|---|---|---|---|
| `short_text` | `text_value` | no | contains → `text_value ILIKE '%'||$1||'%'`; equals → `text_value = $1`; is empty → `NOT EXISTS` | `ORDER BY text_value` (collation) |
| `long_text` | `text_value` | no | contains → `ILIKE`; is empty → `NOT EXISTS` | — (not offered) |
| `number` | `number_value numeric` | no | `= ≠ < >` → direct; between → `BETWEEN $1 AND $2`; is empty → `NOT EXISTS` | `ORDER BY number_value` — **numeric, no cast** |
| `date` | `date_value date` | no | before → `< $1`; after → `> $1`; between; relative → compiler resolves "last 30 days" to a literal range; is empty | `ORDER BY date_value` — chronological, no cast |
| `yes_no` | `bool_value` (nullable) | no | is yes → `bool_value`; is no → `NOT bool_value`; is empty → `NOT EXISTS` | `ORDER BY bool_value DESC NULLS LAST` = "yes first" |
| `single_select` | `ref_value` = option id, `option_rank` | no | is one of → `ref_value = ANY($1::uuid[])`; is not one of → `NOT EXISTS (… = ANY)`; is empty | `ORDER BY option_rank` — **option order, from the index** |
| `multi_select` | `ref_value`, N rows | yes | contains any of → `EXISTS (… = ANY)`; contains all of → count-distinct = cardinality; is empty | — |
| `tags` | `text_value` display, `value_key` = `lower()`, N rows | yes | contains any of → `value_key = ANY($1::text[])`; is empty | — |
| `url` | `text_value` | no | contains → `ILIKE`; is empty | — |
| `email` | `text_value` | no | contains → `ILIKE`; is empty | `ORDER BY text_value` |
| `phone` | `text_value` (E.164) | no | contains → `ILIKE`; is empty | — |
| `relation` | `ref_value` = target record id (+ `link_*`), N rows if many | config | has any of → `ref_value = ANY($1::uuid[])`; is empty | — |

Two semantics decisions the brief leaves open — both need an ADR, and both are product calls
not storage calls:

- **"is not one of" includes records with no value.** `NOT EXISTS (value ∈ set)` is true for an
  empty attribute. Notion behaves this way; Airtable does not. Cheap to flip (`AND EXISTS(any
  value)`), so log it and let Simon choose.
- **"is empty" means no live value row.** The write path never stores `''` — setting a text
  field to empty deletes the value row and appends a `removed_at` fact. This is enforced by
  the `text_value <> ''` CHECK, so "empty string" and "no value" can never diverge. In a JSONB
  design you would have to remember to strip `""` at every write site.

---

## 4. Representative queries

### Q1 — The one the brief actually asks for

*Contacts where job_role ∈ (Investor, Angel) AND city contains "Munich" AND areas_of_interest
contains any of (climate) AND last_interaction_at older than 90 days, sorted by a custom number
attribute descending, paginated.*

```sql
-- $1 job_role attr id      $2 uuid[]  option ids for Investor, Angel
-- $3 city attr id          $4 text    'Munich'
-- $5 areas_of_interest id  $6 text[]  ARRAY['climate']   (already lower()'d by the compiler)
-- $7 sort attribute id (custom number, e.g. "check_size")
-- $8 limit                 $9 offset
SELECT r.id,
       c.display_name,
       m.last_interaction_at,
       m.warmth,
       sort_v.number_value AS sort_value
FROM records r
JOIN contacts c            ON c.id = r.id
LEFT JOIN contact_metrics m ON m.contact_id = r.id
LEFT JOIN LATERAL (
  SELECT v.number_value
  FROM attribute_values v
  WHERE v.record_id = r.id AND v.attribute_id = $7
  ORDER BY v.position
  LIMIT 1
) sort_v ON TRUE
WHERE r.object_type = 'contact'
  AND r.deleted_at IS NULL
  -- single_select: option ids, not labels — renaming "Investor" does not break saved views
  AND EXISTS (SELECT 1 FROM attribute_values v
              WHERE v.record_id = r.id AND v.attribute_id = $1
                AND v.ref_value = ANY($2::uuid[]))
  -- short_text contains
  AND EXISTS (SELECT 1 FROM attribute_values v
              WHERE v.record_id = r.id AND v.attribute_id = $3
                AND v.text_value ILIKE '%' || $4 || '%')
  -- tags contains any of: one row per tag, matched on the normalised key
  AND EXISTS (SELECT 1 FROM attribute_values v
              WHERE v.record_id = r.id AND v.attribute_id = $5
                AND v.value_key = ANY($6::text[]))
  -- derived column: a real column, so a plain predicate.
  -- NULL (never interacted) counts as stale — that is what the seeded view
  -- "No interaction in 90 days" should mean.
  AND (m.last_interaction_at IS NULL
       OR m.last_interaction_at < now() - interval '90 days')
ORDER BY sort_v.number_value DESC NULLS LAST, r.id
LIMIT $8 OFFSET $9;
```

**Why `EXISTS` and not `JOIN`.** The task framing says "joined per filter predicate". Joining
is wrong for multi-valued attributes: a contact with 5 tags would appear 5 times and the row
count in the footer would lie. `EXISTS` compiles to a semi-join, returns each record once, and
`NOT EXISTS` gives "is empty" for free with the same code path. Postgres pulls both into the
join tree and can still choose hash or nested-loop.

Expected plan at 10k contacts: three bitmap/index scans on `av_ref_idx`, `av_text_trgm_idx`
(or a range scan on `av_text_idx` filtered — the planner often prefers that, since
`attribute_id = $3` narrows to ~10k rows and scanning them is cheaper than a GIN probe),
`av_key_idx`; hash semi-joins against a 10k-row `records` scan; a nested-loop lateral for the
sort value; one sort of the filtered set. **Single-digit milliseconds.**

The `ORDER BY` does force a sort of the filtered set — the lateral cannot be index-ordered.
At 10k that is ~5 ms. See §10 for where that stops being true.

### Q2 — Hydrate the 50 visible rows (one round trip, no N+1)

```sql
SELECT v.record_id,
       d.slug,
       d.type,
       jsonb_agg(
         jsonb_strip_nulls(jsonb_build_object(
           'text',   v.text_value,
           'number', v.number_value,
           'date',   v.date_value,
           'bool',   v.bool_value,
           'ref',    v.ref_value,
           'label',  coalesce(o.label, tr.display_label),   -- option label or relation chip label
           'color',  o.color,
           'link',   CASE WHEN v.value_type = 'relation' THEN jsonb_build_object(
                            'title', v.link_title, 'from', v.link_from,
                            'to', v.link_to, 'is_primary', v.link_is_primary) END
         )) ORDER BY v.position
       ) AS values
FROM attribute_values v
JOIN attribute_definitions d ON d.id = v.attribute_id
LEFT JOIN attribute_options o ON o.id = v.ref_value AND v.value_type IN ('single_select','multi_select')
LEFT JOIN records tr          ON tr.id = v.ref_value AND v.value_type = 'relation'
WHERE v.record_id = ANY($1::uuid[])          -- the 50 ids from Q1
GROUP BY v.record_id, d.slug, d.type;
```

50 records × ~15 attributes = ~750 rows via `av_hydrate_idx`. Sub-millisecond. Note the JSONB
appears **at the API boundary**, where it belongs — as a wire format, not as storage.

This is the honest cost of EAV made concrete: JSONB storage would make this query `SELECT
current_values FROM contacts WHERE id = ANY(...)`. That is genuinely simpler. It is also the
one place where JSONB is simpler, and it is a query I write once.

### Q3 — Sort by a `single_select` in option order (§4.2)

```sql
SELECT r.id, c.display_name, o.label AS job_role, o.color
FROM records r
JOIN contacts c ON c.id = r.id
LEFT JOIN LATERAL (
  SELECT v.ref_value, v.option_rank
  FROM attribute_values v
  WHERE v.record_id = r.id AND v.attribute_id = $1
  LIMIT 1
) sv ON TRUE
LEFT JOIN attribute_options o ON o.id = sv.ref_value
WHERE r.object_type = 'contact' AND r.deleted_at IS NULL
ORDER BY sv.option_rank ASC NULLS LAST, c.display_name
LIMIT 50;
```

`option_rank` is denormalised onto the value row precisely so this is an integer sort rather
than a join-then-sort. Reordering options in Settings runs one statement:

```sql
UPDATE attribute_values v
SET option_rank = o.position
FROM attribute_options o
WHERE o.id = v.ref_value AND o.attribute_id = $1 AND v.option_rank IS DISTINCT FROM o.position;
```

That is the price of the denormalisation, and it is bounded by the number of records using
that attribute. Honest alternative: drop `option_rank` and join `attribute_options` (a
≤200-row table) — a hash join costs almost nothing and removes the sync obligation. I keep
the denormalised column because it makes the sort index-ordered; a reviewer could reasonably
argue the simpler version is better and I would not fight hard.

### Q4 — `multi_select` "contains all of"

```sql
AND (SELECT count(DISTINCT v.ref_value)
     FROM attribute_values v
     WHERE v.record_id = r.id AND v.attribute_id = $1
       AND v.ref_value = ANY($2::uuid[])) = cardinality($2::uuid[])
```

One index range scan on `av_ref_idx`, no N-way self-join. The JSONB equivalent (`current_values
-> 'skills' @> '["a","b"]'`) is admittedly prettier and GIN-indexable — a fair point for the
other side.

### Q5 — Writing a fact and refreshing the projection

The write path is one function, shared by the manual UI edit, the importer, quick capture and
the future crawler. It exists as SQL (not only TS) so bulk paths do not need a second
implementation.

```sql
CREATE OR REPLACE FUNCTION refresh_attribute_values(p_record_id uuid, p_attribute_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_multi boolean;
BEGIN
  SELECT is_multi INTO v_multi FROM attribute_definitions WHERE id = p_attribute_id;

  DELETE FROM attribute_values
   WHERE record_id = p_record_id AND attribute_id = p_attribute_id;

  INSERT INTO attribute_values (
    workspace_id, record_id, attribute_id, value_type, position,
    text_value, number_value, date_value, bool_value, ref_value, option_rank,
    link_title, link_from, link_to, link_is_primary, value_key, fact_id)
  SELECT f.workspace_id, f.record_id, f.attribute_id, f.value_type,
         row_number() OVER (ORDER BY f.valid_from DESC, f.observed_at DESC) - 1,
         f.text_value, f.number_value, f.date_value, f.bool_value, f.ref_value,
         o.position,
         f.link_title, f.link_from, f.link_to, f.link_is_primary,
         f.value_key, f.id
  FROM (
    -- resolution rule, stated explicitly (§4.5 says only "the newest non-superseded fact"):
    -- newest by valid_from (when it became true), then observed_at, then confidence.
    -- This is what makes "she moved to Berlin in June", learned in September, correct —
    -- and stops a late-arriving *older* fact from overwriting a newer one.
    SELECT DISTINCT ON (CASE WHEN v_multi THEN fx.value_key ELSE '' END) fx.*
    FROM facts fx
    WHERE fx.record_id = p_record_id
      AND fx.attribute_id = p_attribute_id
      AND fx.superseded_by_id IS NULL
      AND fx.removed_at IS NULL
    ORDER BY CASE WHEN v_multi THEN fx.value_key ELSE '' END,
             fx.valid_from DESC, fx.observed_at DESC, fx.confidence DESC, fx.created_at DESC
  ) f
  LEFT JOIN attribute_options o ON o.id = f.ref_value;
END $$;
```

Adding a value (manual edit of a single-valued attribute), all in one transaction:

```sql
WITH new_fact AS (
  INSERT INTO facts (record_id, attribute_id, value_type, text_value, value_key,
                     valid_from, source, confidence)
  VALUES ($1, $2, 'short_text', $3, lower($3), current_date, 'manual', 1.0)
  RETURNING id, record_id, attribute_id
),
superseded AS (
  UPDATE facts f
  SET superseded_by_id = n.id
  FROM new_fact n
  WHERE f.record_id = n.record_id AND f.attribute_id = n.attribute_id
    AND f.id <> n.id AND f.superseded_by_id IS NULL AND f.removed_at IS NULL
  RETURNING 1
)
SELECT refresh_attribute_values($1, $2);
```

Removing one tag (§4.5: "removal is a fact, not a delete"):

```sql
UPDATE facts SET removed_at = now()
WHERE record_id = $1 AND attribute_id = $2 AND value_key = lower($3)
  AND removed_at IS NULL AND superseded_by_id IS NULL;
SELECT refresh_attribute_values($1, $2);
```

Because the fact columns and the value columns are **the same columns with the same types**,
`refresh_attribute_values` is a `SELECT … INSERT`. There is no serialiser, no `::numeric`
cast, no "did we store dates as ISO strings or epoch millis" bug waiting in Stage 6 when the
LLM starts appending facts. I consider this the design's whole justification.

### Q6 — Value history for the hover card (§4.5)

```sql
SELECT f.id, f.value_key,
       coalesce(f.text_value, f.number_value::text, f.date_value::text,
                f.bool_value::text, o.label, tr.display_label) AS display_value,
       f.valid_from, f.observed_at, f.source, f.source_ref, f.confidence,
       f.superseded_by_id IS NOT NULL AS superseded,
       f.removed_at
FROM facts f
LEFT JOIN attribute_options o ON o.id = f.ref_value
LEFT JOIN records tr          ON tr.id = f.ref_value
WHERE f.record_id = $1 AND f.attribute_id = $2
ORDER BY f.valid_from DESC, f.observed_at DESC;
```

One index-range scan on `facts_history_idx`. Renders the brief's exact string: *"Company:
Stripe — since Jun 2025, from LinkedIn import · previously Northstar — Jan 2023, manual"*.

### Q7 — Relations with link metadata (§4.3, §6.5)

Contact's work history, current first, reading like a CV:

```sql
SELECT org.id, o.name, v.link_title, v.link_from, v.link_to, v.link_is_primary
FROM attribute_values v
JOIN records org      ON org.id = v.ref_value
JOIN organizations o  ON o.id = org.id
WHERE v.record_id = $1 AND v.attribute_id = $2   -- the "organization" relation attribute
ORDER BY v.link_is_primary DESC NULLS LAST,
         (v.link_to IS NULL) DESC,               -- current before past
         v.link_from DESC NULLS LAST;
```

Reverse direction — the organization's People tab — is the same table read the other way
(`av_reverse_ref_idx`), which is what makes §4.3's "all relations are bidirectional in the UI"
free rather than a second write:

```sql
SELECT c.id, c.display_name, v.link_title, v.link_from, v.link_to
FROM attribute_values v
JOIN contacts c ON c.id = v.record_id
WHERE v.ref_value = $1 AND v.attribute_id = $2
ORDER BY (v.link_to IS NULL) DESC, c.display_name;
```

"Also at the same organization" (§6.5c):

```sql
SELECT DISTINCT c2.id, c2.display_name
FROM attribute_values mine
JOIN attribute_values theirs
  ON theirs.attribute_id = mine.attribute_id
 AND theirs.ref_value    = mine.ref_value
 AND theirs.record_id   <> mine.record_id
 AND theirs.link_to IS NULL
JOIN contacts c2 ON c2.id = theirs.record_id
WHERE mine.record_id = $1 AND mine.attribute_id = $2 AND mine.link_to IS NULL;
```

### Q8 — Global search (§4.8)

```sql
SELECT 'contact' AS kind, r.id, r.display_label,
       similarity(r.display_label, $1) AS score
FROM records r
WHERE r.deleted_at IS NULL AND r.display_label ILIKE '%' || $1 || '%'
UNION ALL
SELECT 'identifier', r.id, r.display_label, 1.0
FROM identifiers i JOIN records r ON r.id = i.record_id
WHERE i.value LIKE lower($1) || '%'
UNION ALL
SELECT 'interaction', i.id, i.title, ts_rank(i.search_tsv, websearch_to_tsquery('english', $1))
FROM interactions i
WHERE i.search_tsv @@ websearch_to_tsquery('english', $1)
ORDER BY score DESC LIMIT 20;
```

Caveat I want on the record: **`gin_trgm_ops` needs three characters to extract a trigram.**
A one- or two-letter query degenerates to a full index scan (verified in the PG16 `pg_trgm`
docs). At 10k rows that is still fast; the ⌘K palette should simply not fire until the query
is ≥2 chars, and we accept a scan at 2.

`records.search_tsv` is maintained by the same projection path (it needs `first_name`,
`last_name`, the email value and the primary organization name — a generated column cannot do
that, since it may not reference other rows or tables; verified in the PG16 generated-columns
docs). So it is a `UPDATE records SET search_tsv = …` at the end of `refresh_attribute_values`.

### Q9 — Bulk import: 10k rows without 150k round trips

```sql
-- 1. COPY the staged facts in (one COPY, ~150k rows)
COPY facts (record_id, attribute_id, value_type, text_value, number_value, date_value,
            bool_value, ref_value, value_key, valid_from, observed_at, source, source_ref,
            confidence)
FROM STDIN WITH (FORMAT binary);

-- 2. Supersede prior single-valued facts, set-based, for the touched pairs only
UPDATE facts old
SET superseded_by_id = nw.id
FROM (
  SELECT DISTINCT ON (f.record_id, f.attribute_id) f.id, f.record_id, f.attribute_id
  FROM facts f JOIN attribute_definitions d ON d.id = f.attribute_id
  WHERE f.source_ref = $batch AND NOT d.is_multi
  ORDER BY f.record_id, f.attribute_id, f.valid_from DESC, f.observed_at DESC
) nw
WHERE old.record_id = nw.record_id AND old.attribute_id = nw.attribute_id
  AND old.id <> nw.id AND old.superseded_by_id IS NULL AND old.removed_at IS NULL;

-- 3. One set-based projection rebuild for the whole batch
DELETE FROM attribute_values av
USING (SELECT DISTINCT record_id, attribute_id FROM facts WHERE source_ref = $batch) t
WHERE av.record_id = t.record_id AND av.attribute_id = t.attribute_id;

INSERT INTO attribute_values (...)
SELECT ... FROM (
  SELECT DISTINCT ON (f.record_id, f.attribute_id,
                      CASE WHEN d.is_multi THEN f.value_key ELSE '' END) f.*, d.is_multi
  FROM facts f JOIN attribute_definitions d ON d.id = f.attribute_id
  WHERE f.record_id IN (SELECT record_id FROM facts WHERE source_ref = $batch)
    AND f.superseded_by_id IS NULL AND f.removed_at IS NULL
  ORDER BY f.record_id, f.attribute_id,
           CASE WHEN d.is_multi THEN f.value_key ELSE '' END,
           f.valid_from DESC, f.observed_at DESC, f.confidence DESC
) f LEFT JOIN attribute_options o ON o.id = f.ref_value;
```

Measured expectation, not a measurement: 10k contacts × 15 attributes ≈ 150k facts + ~150k
projected rows ≈ **5–15 s** on a laptop, dominated by index maintenance on the seven
`attribute_values` indexes. Mitigation if that is too slow: drop the trgm index for the
duration of a large import and rebuild it after (`CREATE INDEX CONCURRENTLY`). This is
genuinely slower than a JSONB design's 10k-row insert, and I do not want to pretend otherwise
— see §9.

### Q10 — Semantic search later (§9), same database

```sql
SELECT r.id, r.display_label, 1 - (e.embedding <=> $1::halfvec) AS score
FROM embeddings e JOIN records r ON r.id = e.owner_id
WHERE e.owner_type = 'record' AND e.model = $2
  AND r.object_type = 'contact' AND r.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM attribute_values v                    -- structured pre-filter
              WHERE v.record_id = r.id AND v.attribute_id = $3
                AND v.value_key = ANY($4::text[]))
ORDER BY e.embedding <=> $1::halfvec
LIMIT 20;
```

pgvector 0.8.x's iterative index scans matter exactly here: a filtered vector query used to
return fewer than `LIMIT` rows when the HNSW candidate set was filtered away, and 0.8 fixes
that with `hnsw.iterative_scan`. Verified from the pgvector release notes; not yet exercised
by me.

---

## 5. Why this beats JSONB `current_values`, precisely

Not "EAV is faster". These four, and only these four:

**1. Type integrity the database enforces.** `date_value date` rejects `"not a date"`. A JSONB
document does not: `{"birthday": "next Tuesday"}` is valid JSONB, and you find out in Stage 6
when the LLM writes it. The `CHECK (CASE value_type …)` constraint means a wrong-typed value
cannot reach the disk from *any* path — UI, API, importer, MCP server, psql.

**2. Range queries and ordered scans on arbitrary attributes need no per-attribute DDL.**
Verified from the PG16 JSON docs: GIN on jsonb (`jsonb_ops` or `jsonb_path_ops`) supports
`@>`, `?`, `@?`, `@@` — **containment and existence, not `<`, `>`, or ordering.** To make
`revenue > 1000000` or `ORDER BY revenue` indexed in a JSONB design, the docs point you at an
**expression index per key** — `CREATE INDEX ON contacts (((current_values->>'revenue')::numeric))`.
That is a `CREATE INDEX` every time a user adds an attribute in Settings: runtime DDL,
triggered by a non-technical user, on the hot path of a product whose entire pitch is "define
your own fields". Here, the same seven indexes cover attribute number 3 and attribute number
300 with zero DDL.

**3. Multi-valued add/remove is row-level.** §4.5 requires tags and multi-selects to be added
and removed *individually*, each with its own `observed_at`, `source` and `confidence`. In EAV
that is one row per value with its own `fact_id` — removal is `UPDATE … SET removed_at`. In a
JSONB array you are read-modify-writing a document, which loses per-element provenance unless
you nest objects inside the array, at which point you have reinvented EAV inside a document
with none of the indexes.

**4. Fact → value is a copy, not a translation.** Restated because it is the point.

**Where JSONB genuinely wins, and I will not pretend otherwise:** hydration is one column read
instead of Q2; the row count stays 10k instead of 150k; `@>` containment on arrays is prettier
than Q4; and every query in the codebase is shorter. If §4.5 did not exist, I would probably
recommend JSONB.

**The hybrid** (typed EAV as truth + a JSONB `current_values` cache on the record for reads)
is the strongest opposing proposal and deserves a real answer: it buys back fast hydration at
the cost of a third representation to keep in sync, and it does not help filtering or sorting
at all — you would still filter through EAV. I would take it as a **later optimisation** if Q2
ever shows up in a profile, gated behind the same `refresh_attribute_values` function that
already owns the projection. Not now: that is the "never over-engineer" rule.

---

## 6. `workspace_id` (§9), done properly

Every table has it, nullable, always `NULL` in Phase 1. Three non-obvious consequences:

1. **`UNIQUE NULLS NOT DISTINCT` is mandatory** on every unique constraint that includes
   `workspace_id`, or Phase 1's all-NULL workspace silently disables the constraint. This is
   the single most likely bug in a naive implementation of §9's instruction.
2. **Do not put `workspace_id` in the leading position of any index yet.** A constant column
   has zero selectivity and only costs bytes. When multi-tenancy lands you rebuild the indexes
   as `(workspace_id, attribute_id, …)` — a migration you would be doing anyway.
3. **Filter on it with `IS NOT DISTINCT FROM $ws`**, not `=`, so the same compiled SQL works
   for `NULL` today and a real uuid later. One repository-level helper; the filter compiler
   never sees it.

---

## 7. What the query layer looks like

Drizzle 0.45.x for schema, migrations (`drizzle-kit` 0.31.x) and all static queries. The
dynamic filter compiler emits parameterised fragments through Drizzle's `sql` template —
`sql` interpolation of values produces bind parameters, so attribute ids and user input are
never string-concatenated. Attribute *slugs* never reach SQL at all: the compiler resolves
slug → attribute id → typed slot column from `attribute_definitions` first, and an unknown
slug is a 400 before any SQL is built. Column names in the emitted SQL come from a closed set
of six literals (`text_value`, `number_value`, …) chosen by the attribute's type — there is no
path from user input to an identifier.

The compiler is ~300 lines of pure TS: `Filter[] → SQL`. It is exactly the "filter → query
compilation" the brief singles out for high unit-test coverage (§8.1), and it is testable
without a database because its output is a string plus a parameter array.

---

## 8. Migration and extension points

- New attribute type (say `currency`, `rating`): add an enum value, pick an existing slot
  (`number_value`), extend the CHECK, extend the compiler's operator table. **No new column,
  no new index, no data migration.**
- Custom attributes on Interactions (§4.1 "model it so it would be a small change"): make
  `interactions` a `records` subtype, or widen `attribute_values.record_id` to a second FK.
  The former is a two-table change and nothing in the compiler moves.
- Per-value provenance for the crawler (§9): already there — `facts.source`,
  `facts.confidence`, `attribute_values.fact_id`.
- Vector search: the `embeddings` table and the `search` API's `mode` parameter; no change to
  the attribute store.

---

## 9. Weaknesses — the honest list

1. **Every query is longer.** Q1 is 35 lines where a JSONB version is 12. The complexity is
   confined to one compiler, but it is real, and it is the first thing a new contributor to an
   open-source project will complain about.
2. **Row-count amplification is 15×.** 10k contacts become 150k value rows. Every
   `VACUUM`, every index rebuild, every `count(*)` over values touches 15× more tuples.
3. **Hydration needs a join and an aggregate** (Q2). JSONB reads one column. This is the
   clearest single loss.
4. **Writes are amplified ~4×.** One user edit = 1 fact insert + 1 supersede update + a
   delete/insert projection + a tsvector update + possibly a metrics recompute. Fine for a
   personal CRM; not fine for a write-heavy system.
5. **Delete-then-insert projection churns tuples.** A single-valued edit dead-tuples one row in
   seven indexes. Autovacuum handles it at this volume; a `MERGE` (PG15+) would be tighter and
   is the obvious optimisation if it ever matters.
6. **The planner's join-collapse limit is a real ceiling.** Verified PG16 defaults:
   `from_collapse_limit` = 8, `join_collapse_limit` = 8, `geqo_threshold` = 12. Q1 already uses
   4 base relations (`records`, `contacts`, `contact_metrics`, the sort lateral) plus one
   semi-join per filter chip. So **at ~5 filter chips you hit `join_collapse_limit` and the
   planner stops exhaustively reordering; at ~9 chips GEQO takes over and plans become
   non-deterministic.** Mitigations, in order: raise `join_collapse_limit` to 16 and
   `geqo_threshold` to 20 on the connection (safe at this table size), and above that compile
   many predicates into one grouped scan:
   ```sql
   SELECT record_id FROM attribute_values
   WHERE (attribute_id = $1 AND ref_value = ANY($2))
      OR (attribute_id = $3 AND text_value ILIKE $4)
      OR (attribute_id = $5 AND value_key = ANY($6))
   GROUP BY record_id HAVING count(DISTINCT attribute_id) = 3
   ```
   which is O(1) relations regardless of predicate count — but does not express "is empty"
   (a `NOT EXISTS`), so the compiler needs both strategies. That is real added complexity I
   would rather not have.
7. **Keyset pagination is not index-accelerated.** You *can* write
   `WHERE (sort_v.number_value, r.id) > ($v, $id)` since the lateral is in `FROM`, but the
   lateral must be evaluated per row before the predicate applies, so it buys nothing. We use
   `OFFSET`, which is correct and fast to a few thousand rows and degrades linearly after.
8. **No cross-attribute or uniqueness constraints in the attribute system.** "Email must be
   unique" lives in `identifiers`; "if `job_role` = Investor then `fund_size` is required"
   cannot be expressed in the database at all. Same limitation as JSONB — but I am not
   claiming EAV solves it.
9. **`option_rank` is denormalised** and must be resynced when options are reordered (Q3).
10. **The ORM gives you no types for user-defined attributes.** Drizzle knows
    `attribute_values`, not `check_size`. Runtime typing comes from Zod schemas generated from
    `attribute_definitions`. Unavoidable in any dynamic design, but worth saying plainly:
    "typed end-to-end" (§3.2) is true for the *envelope*, not for user attribute values.
11. **Cross-database portability is worse.** `NULLS NOT DISTINCT`, partial indexes,
    `gin_trgm_ops`, `DISTINCT ON` and `num_nonnulls` are all Postgres-specific. The brief fixes
    Postgres, so this is a non-issue *now* — but it is a real lock-in and worth stating.

---

## 10. Where it stops working, with numbers

- **10k records, ≤5 filter chips, sort on any attribute: 5–15 ms.** Comfortably inside the
  brief's "feels instant". Whole working set in shared_buffers.
- **~5 filter chips:** `join_collapse_limit` = 8 is reached. Plans stay good but the planner
  stops proving it. Bump the GUC.
- **~9 filter chips:** GEQO threshold. Plan stability is no longer guaranteed. Switch to the
  grouped-scan compilation in §9.6.
- **100k records:** the `ORDER BY` sort of a lightly-filtered set becomes the cost — sorting
  100k `(numeric, uuid)` pairs is ~20–40 ms plus the lateral's 100k nested-loop probes. Still
  usable; the fix is the inverted plan (drive from `av_number_idx` in index order, `UNION ALL`
  a tail for records with no value), which is another compiler branch.
- **~1M records:** the design needs partitioning `attribute_values` by `attribute_id` hash, or
  per-attribute materialised columns for the handful of attributes people actually sort by.
  This is roughly 100× the brief's stated scale and I would not build for it.
- **Deep pagination:** `OFFSET 5000` materialises 5050 rows. Fine at 10k, wrong at 1M.
- **`contains` with a 1–2 character query:** no extractable trigram, so full index scan.
  ~15 ms at this size; unbounded at 100× this size.
- **Import of 10k rows:** 5–15 s, index-maintenance bound. A JSONB design would be ~2–3× faster
  here. If that matters, drop and rebuild the trgm index around the batch.

---

## 11. Verified vs. assumed

**Verified against current documentation while writing this:**

- PG16 GIN on `jsonb` (`jsonb_ops` / `jsonb_path_ops`) supports `@>`, `?`, `?|`, `?&`, `@?`,
  `@@` only — no range or ordering support; the docs recommend expression indexes for derived
  values. *(postgresql.org/docs/16/datatype-json.html)*
- PG16 planner defaults: `from_collapse_limit` = 8, `join_collapse_limit` = 8 (same as
  `from_collapse_limit`), `geqo_threshold` = 12. *(postgresql.org/docs/16/runtime-config-query.html)*
- `gin_trgm_ops` supports `LIKE`/`ILIKE` and regex **without left anchoring**; "a pattern with
  no extractable trigrams will degenerate to a full-index scan".
  *(postgresql.org/docs/16/pgtrgm.html)*
- PG16 implements **stored generated columns only**; the expression must be immutable and may
  not reference other rows or tables — which is why `search_tsv` is maintained by the
  projection function rather than generated. *(postgresql.org/docs/16/ddl-generated-columns.html)*
- pgvector current release is **0.8.2** (Feb 2026), with `halfvec`, parallel HNSW builds and
  iterative index scans for filtered queries; 0.8.2 fixes CVE-2026-3172, a buffer overflow in
  parallel HNSW builds — so pin ≥ 0.8.2. Tested against PG16.
  *(postgresql.org/about/news/pgvector-082-released-3245)*
- `drizzle-orm` 0.45.x is a real, current 0.x line (0.45.0/0.45.1 fixes around node-postgres
  pool detection, subqueries in select fields, `$onUpdate` with SQL values). Note for the
  plan: **a v1.0.0-beta line also exists** — 0.45.x is the stable choice today, and the v0→v1
  upgrade is a known future cost, not a surprise.

- PG16 `CREATE TABLE` supports `UNIQUE [ NULLS [ NOT ] DISTINCT ] (cols)`: "For the purpose of
  a unique constraint, null values are not considered equal, **unless `NULLS NOT DISTINCT` is
  specified.**" This is load-bearing for §6 and it checks out.
  *(postgresql.org/docs/16/sql-createtable.html)*
- `num_nonnulls(VARIADIC "any") → integer` is a PG16 built-in — used by the slot CHECK
  constraints. *(postgresql.org/docs/16/functions-comparison.html)*

**Assumed, not verified — flag these before committing:**

- `MERGE` (PG15+) as the projection optimisation in §9.5 — not needed for Phase 1.
- All timing figures are **estimates from table size and index shape, not benchmarks.** They
  should be replaced with `EXPLAIN (ANALYZE, BUFFERS)` output against the seed dataset (§8.1
  asks for ~200 contacts; the performance pass in Stage 7 needs a 10k-row generator) before
  anyone treats them as facts.
- Drizzle's exact API for emitting the lateral join in Q1 — I would expect `sql` template
  interpolation to handle it, but the ergonomics of `LEFT JOIN LATERAL` in Drizzle 0.45
  specifically are unverified. Worst case the list query is a hand-written `sql` template,
  which it largely is anyway.
- The repo as it stands today (`/Users/simonfuhrbach/code/crm`) is a **Next.js 16 +
  better-sqlite3 prototype**, not the stack in the brief — no monorepo, no Fastify, no
  Postgres, no Drizzle. This proposal assumes a greenfield `packages/db` against Postgres 16,
  not a migration of the existing tree.
