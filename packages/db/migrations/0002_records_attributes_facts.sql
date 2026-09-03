-- The record supertype and its three subtypes, the attribute system, the append-only fact log,
-- the one derived model, relations, identifiers and follow-ups.

-- Polymorphic parent. Postgres has no polymorphic foreign key, and this is the only way fact,
-- attribute_value, identifier, record_link and search_document get a real ON DELETE CASCADE.
CREATE TABLE record (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid REFERENCES workspace(id) ON DELETE CASCADE,
  object_type      object_type NOT NULL,

  created_via      created_via NOT NULL DEFAULT 'manual',
  -- The FK is added in 0005, where import_batch is created. The column lives here because record
  -- is created first and the whole migration run is one transaction, so nothing observes the gap.
  import_batch_id  uuid,
  last_enriched_at timestamptz,
  enriched_by      text,

  -- Denormalised label for relation chips, global search and merge previews.
  -- Owner: sync_record_label() in 0003. Never written by hand.
  display_label    text NOT NULL DEFAULT '',
  -- ADR-019: mutuals_norm(display_label), written by the same trigger. A written column rather than
  -- a generated one because mutuals_norm is STABLE; it replaces the dropped contact.name_key.
  label_norm       text NOT NULL DEFAULT '',

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX record_list_idx  ON record (object_type, created_at DESC, id DESC);
CREATE INDEX record_batch_idx ON record (import_batch_id) WHERE import_batch_id IS NOT NULL;
-- The palette searches substrings, which tsvector cannot do.
CREATE INDEX record_label_trgm_idx ON record USING gin (label_norm gin_trgm_ops);

CREATE TABLE contact (
  id               uuid PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
  first_name       text,
  last_name        text,
  display_name     text GENERATED ALWAYS AS
                     (btrim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))) STORED,
  -- Manual warmth overrides. Real columns, not attributes: they are behaviour, not data.
  pinned_important boolean NOT NULL DEFAULT false,   -- floor 60
  not_important    boolean NOT NULL DEFAULT false    -- cap 10, and excluded from nudges
);
CREATE INDEX contact_name_sort_idx ON contact ((lower(display_name)) COLLATE "C", id);

CREATE TABLE organization (
  id   uuid PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
  name text NOT NULL
);
CREATE INDEX organization_name_sort_idx ON organization ((lower(name)) COLLATE "C", id);

-- A record subtype from day one, so giving interactions custom attributes later is inserting
-- attribute_definition rows and nothing else.
CREATE TABLE interaction (
  id           uuid PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('Meeting','Call','Email','Message','Intro','Event','Note')),
  occurred_at  timestamptz NOT NULL,
  title        text,
  body         text,
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
CREATE INDEX io_organization_idx ON interaction_organization (organization_id, interaction_id);

CREATE TABLE attribute_definition (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  object_type  object_type    NOT NULL,
  title        text           NOT NULL,
  slug         text           NOT NULL CHECK (slug ~ '^[a-z][a-z0-9_]{0,62}$'),
  type         attribute_type NOT NULL,
  value_kind   value_kind     NOT NULL,
  is_multi     boolean        NOT NULL,
  config       jsonb          NOT NULL DEFAULT '{}'::jsonb,
  group_name   text,
  description  text,
  is_system    boolean        NOT NULL DEFAULT false,
  position     integer        NOT NULL DEFAULT 0,
  created_at   timestamptz    NOT NULL DEFAULT now(),
  updated_at   timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT ad_kind_matches_type CHECK (
    (type IN ('short_text','long_text','url','email','phone','tags') AND value_kind = 'text')
    OR (type = 'number'                          AND value_kind = 'number')
    OR (type = 'date'                            AND value_kind = 'date')
    OR (type = 'yes_no'                          AND value_kind = 'bool')
    OR (type IN ('single_select','multi_select') AND value_kind = 'option')
    OR (type = 'relation'                        AND value_kind = 'relation')),

  CONSTRAINT ad_multi_matches_type CHECK (
    (type IN ('tags','multi_select') AND is_multi)
    OR (type = 'relation')                       -- one or many, from config
    OR (type NOT IN ('tags','multi_select','relation') AND NOT is_multi)),

  -- workspace_id is nullable, and a plain UNIQUE treats every NULL as distinct, so `email` could
  -- be created twice. NULLS NOT DISTINCT is not optional here (ADR-014).
  CONSTRAINT ad_slug_uq UNIQUE NULLS NOT DISTINCT (workspace_id, object_type, slug),

  -- The FK target that makes slot and cardinality drift impossible, and that turns "changing the
  -- type of an attribute is not supported" into something the database enforces while values exist.
  CONSTRAINT ad_shape_uq UNIQUE (id, value_kind, is_multi)
);
CREATE INDEX ad_object_pos_idx ON attribute_definition (object_type, position, id);

CREATE TABLE attribute_option (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  attribute_id uuid NOT NULL REFERENCES attribute_definition(id) ON DELETE CASCADE,
  key          text NOT NULL,          -- stable machine key; `label` is renameable, `key` is not
  label        text NOT NULL,
  color        text,                   -- a chip token name, never a hex string
  position     integer NOT NULL,       -- THE sort order for single_select
  archived_at  timestamptz,            -- options are archived, never hard-deleted while in use
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ao_key_uq   UNIQUE (attribute_id, key),
  CONSTRAINT ao_label_uq UNIQUE (attribute_id, label),
  -- A full (non-partial) UNIQUE constraint may be DEFERRABLE, so a drag-reorder rewrites every
  -- position in one statement. A partial unique index could not.
  CONSTRAINT ao_pos_uq   UNIQUE (attribute_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ao_order_idx ON attribute_option (attribute_id, position) WHERE archived_at IS NULL;

-- The truth. Append-only, typed.
CREATE TABLE fact (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid REFERENCES workspace(id) ON DELETE CASCADE,
  object_type      object_type NOT NULL,
  record_id        uuid NOT NULL REFERENCES record(id) ON DELETE CASCADE,
  attribute_id     uuid NOT NULL,
  value_kind       value_kind NOT NULL,
  is_multi         boolean    NOT NULL,

  -- Identical slot set and identical types to attribute_value, so the projection is a
  -- column-for-column copy: no serialiser, no cast, no encoding question to get wrong later.
  -- ADR-020: no derived column ever lives here, so db:reproject can rebuild everything from fact.
  text_value       text,
  num_value        numeric,
  date_value       date,
  bool_value       boolean,
  option_id        uuid REFERENCES attribute_option(id) ON DELETE RESTRICT,
  target_record_id uuid REFERENCES record(id) ON DELETE CASCADE,

  -- Link metadata for contact -> organization. Four nullable columns cost four bits in the null
  -- bitmap on the ~99% of rows where they are NULL, not four words.
  link_title       text,
  link_from        date,
  link_to          date,                       -- NULL = current
  link_is_primary  boolean,

  -- Identity of one value within an attribute: '' for single-valued, the canonical value for
  -- multi-valued, so one constraint expresses both cardinalities (ADR-018).
  value_key        text NOT NULL,

  valid_from       date        NOT NULL,                 -- when it became true
  observed_at      timestamptz NOT NULL DEFAULT now(),   -- when we learned it
  source           fact_source NOT NULL,
  source_ref       text,                                 -- import batch id, interaction id, ...
  confidence       numeric(3,2) NOT NULL DEFAULT 1.0 CHECK (confidence > 0 AND confidence <= 1),
  -- DEFERRABLE is load-bearing, not decoration. The write path supersedes the live fact BEFORE it
  -- inserts the new one — it has to, because fact_live_uq is a partial unique index and therefore
  -- cannot itself be deferred — so this column points at a row that does not exist yet for the
  -- duration of the transaction. Checked immediately, that write path fails on its first statement.
  superseded_by_id uuid REFERENCES fact(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  removed_at       timestamptz,                          -- removal is a fact, not a delete
  removed_source   fact_source,
  created_at       timestamptz NOT NULL DEFAULT now(),

  -- One composite FK, one parent probe, two invariants: a number attribute can never acquire a
  -- text value, and an attribute's type or cardinality cannot change while any fact exists.
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

-- At most one live fact per value slot. Tombstones are included deliberately: a tombstone occupies
-- the slot, which is what makes "removed then re-added" a clean supersession chain.
CREATE UNIQUE INDEX fact_live_uq ON fact (record_id, attribute_id, value_key)
  WHERE superseded_by_id IS NULL;

-- The hover card: the full history of one attribute on one record, superseded rows included.
CREATE INDEX fact_history_idx ON fact (record_id, attribute_id, valid_from DESC, observed_at DESC);

-- Projector reads: the live facts of one record, whole-record and per-attribute scopes.
CREATE INDEX fact_live_read_idx ON fact (record_id, attribute_id)
  WHERE superseded_by_id IS NULL AND removed_at IS NULL;

-- "Which records did import batch X touch", and undo and error reporting.
CREATE INDEX fact_source_ref_idx ON fact (source, source_ref) WHERE source_ref IS NOT NULL;

-- The one derived model. Every row here is, by construction, a current value: there is no liveness
-- predicate for a query to forget.
CREATE TABLE attribute_value (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  object_type  object_type NOT NULL,
  record_id    uuid NOT NULL REFERENCES record(id) ON DELETE CASCADE,
  attribute_id uuid NOT NULL,
  value_kind   value_kind NOT NULL,
  is_multi     boolean    NOT NULL,
  value_key    text       NOT NULL,
  position     integer    NOT NULL DEFAULT 0,
  fact_id      uuid NOT NULL REFERENCES fact(id) ON DELETE CASCADE,   -- per-value provenance

  text_value   text,                    -- verbatim, for display and round-trip
  text_norm    text,                    -- mutuals_norm, FULL length -> trigram GIN
  -- left(text_norm, 256), NULL for long_text. A btree tuple is capped at ~2704 bytes, so indexing
  -- a long_text value directly aborts at import time on real user data. COLLATE "C" makes the
  -- comparison a memcmp and is immune to glibc collation changes across an OS upgrade.
  text_sort    text COLLATE "C",
  num_value    numeric,
  date_value   date,
  bool_value   boolean,
  option_id    uuid REFERENCES attribute_option(id) ON DELETE RESTRICT,
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT av_shape_fk FOREIGN KEY (attribute_id, value_kind, is_multi)
    REFERENCES attribute_definition (id, value_kind, is_multi) ON DELETE CASCADE,

  -- Relations live in record_link, because the link carries its own attributes.
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

-- Nine indexes, none of which grows with the number of attributes: each is led by attribute_id, so
-- every attribute owns a contiguous key range. That is what makes "create attribute number 300"
-- one INSERT instead of one CREATE INDEX.

-- 1. hydration, value identity and import idempotency in one index
CREATE UNIQUE INDEX av_record_attr_uq ON attribute_value (record_id, attribute_id, value_key);

-- 2-6. one contiguous key range per attribute: a per-attribute index with no per-attribute DDL
CREATE INDEX av_attr_text_idx ON attribute_value (attribute_id, text_sort,  record_id)
  WHERE text_sort  IS NOT NULL;   -- `equals` prefix + alphabetical ORDER BY
CREATE INDEX av_attr_num_idx  ON attribute_value (attribute_id, num_value,  record_id)
  WHERE num_value  IS NOT NULL;   -- = <> < > between + numeric ORDER BY
CREATE INDEX av_attr_date_idx ON attribute_value (attribute_id, date_value, record_id)
  WHERE date_value IS NOT NULL;   -- before / after / between + chronological ORDER BY
CREATE INDEX av_attr_bool_idx ON attribute_value (attribute_id, bool_value, record_id)
  WHERE bool_value IS NOT NULL;   -- is yes / is no + "yes first" ORDER BY
CREATE INDEX av_attr_opt_idx  ON attribute_value (attribute_id, option_id,  record_id)
  WHERE option_id  IS NOT NULL;   -- is one of / contains any of / contains all of

-- 7. tags `contains any of` on the exact normalised key, which is untruncated, so no false matches
CREATE INDEX av_attr_key_idx ON attribute_value (attribute_id, value_key, record_id);

-- 8. `is empty` as an indexed anti-join, and the "Used in N records" count in Settings
CREATE INDEX av_attr_rec_idx ON attribute_value (attribute_id, record_id);

-- 9. `contains`, scoped PER ATTRIBUTE. Without the leading attribute_id — which needs btree_gin's
--    uuid opclass — `city contains 'munich'` would probe every text value in the database,
--    notes included, and then recheck.
CREATE INDEX av_trgm_idx ON attribute_value USING gin (attribute_id, text_norm gin_trgm_ops)
  WHERE text_norm IS NOT NULL;

-- Relations are the one attribute type that does not go through attribute_value, because the link
-- carries its own attributes and because one table gives bidirectionality for free. It is still
-- projected from fact, so a job-title change is auditable history.
CREATE TABLE record_link (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid REFERENCES workspace(id) ON DELETE CASCADE,
  attribute_id    uuid NOT NULL REFERENCES attribute_definition(id) ON DELETE CASCADE,
  from_record_id  uuid NOT NULL REFERENCES record(id) ON DELETE CASCADE,
  to_record_id    uuid NOT NULL REFERENCES record(id) ON DELETE CASCADE,
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

CREATE UNIQUE INDEX rl_uq         ON record_link (from_record_id, attribute_id, to_record_id);
-- "Exactly one primary organization", enforced by the database.
CREATE UNIQUE INDEX rl_primary_uq ON record_link (from_record_id, attribute_id) WHERE is_primary;
-- "All relations are bidirectional in the UI" = one index lookup, not a second stored row.
CREATE INDEX rl_reverse_idx       ON record_link (to_record_id, attribute_id, from_record_id);
-- The Connections tab reads as a CV: current before past, straight off the index.
CREATE INDEX rl_current_idx       ON record_link (from_record_id, attribute_id,
                                                  valid_to NULLS FIRST, valid_from DESC);
-- "Also at the same organization".
CREATE INDEX rl_same_org_idx      ON record_link (to_record_id, from_record_id) WHERE valid_to IS NULL;

-- Every handle we have ever seen. Uniqueness of emails lives here, not in the attribute system:
-- no dynamic attribute design can express "this attribute's values must be globally unique".
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

CREATE TABLE follow_up (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  contact_id   uuid NOT NULL REFERENCES contact(id) ON DELETE CASCADE,   -- one, and required
  title        text NOT NULL,
  due_at       date NOT NULL,
  status       text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Done','Snoozed')),
  recurrence   jsonb,                                    -- the closed five-variant union
  origin       text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','system')),
  notes        text,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fu_open_idx   ON follow_up (contact_id, due_at) WHERE status = 'Open';
CREATE INDEX fu_due_idx    ON follow_up (due_at, id)         WHERE status = 'Open';
CREATE INDEX fu_status_idx ON follow_up (status, due_at, id);

-- ---------------------------------------------------------------------------------------------
-- The default attribute definitions of §4.1, created on first run.
--
-- They live in a migration rather than in the demo seed because a fresh install with no demo data
-- must still have an `email` field on the contact form, and because every fixture, integration
-- test and golden filter test binds these ids. The uuids are therefore fixed literals, laid out as
-- 00000001-…-0000000000NN for contact definitions, 00000002-… for organization definitions,
-- 00000003-…-0000AAAA00PP for a contact option (attribute ordinal AAAA, option position PP) and
-- 00000004-… for an organization option.
--
-- is_system is false on every row: the brief's system attributes are columns on record / contact /
-- organization, declared as pseudo-fields in packages/core, and these twenty-two are seeds the
-- user may rename, reorder or delete.
-- ---------------------------------------------------------------------------------------------

INSERT INTO attribute_definition
  (id, workspace_id, object_type, title, slug, type, value_kind, is_multi, config, position)
VALUES
  ('00000001-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'contact',
   'Email', 'email', 'email', 'text', false, '{}'::jsonb, 0),
  ('00000001-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'contact',
   'Phone', 'phone', 'phone', 'text', false, '{}'::jsonb, 1),
  ('00000001-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'contact',
   'Job role', 'job_role', 'single_select', 'option', false, '{}'::jsonb, 2),
  ('00000001-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'contact',
   'Organization', 'organization', 'relation', 'relation', true,
   '{"target_object_type": "organization", "has_link_metadata": true}'::jsonb, 3),
  ('00000001-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 'contact',
   'City', 'city', 'short_text', 'text', false, '{}'::jsonb, 4),
  ('00000001-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', 'contact',
   'Country', 'country', 'short_text', 'text', false, '{}'::jsonb, 5),
  ('00000001-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001', 'contact',
   'Birthday', 'birthday', 'date', 'date', false, '{}'::jsonb, 6),
  ('00000001-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001', 'contact',
   'Areas of interest', 'areas_of_interest', 'tags', 'text', true, '{}'::jsonb, 7),
  ('00000001-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000001', 'contact',
   'Asks', 'asks', 'tags', 'text', true, '{}'::jsonb, 8),
  ('00000001-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000001', 'contact',
   'Offers', 'offers', 'tags', 'text', true, '{}'::jsonb, 9),
  ('00000001-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-000000000001', 'contact',
   'LinkedIn', 'linkedin_url', 'url', 'text', false, '{}'::jsonb, 10),
  ('00000001-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-000000000001', 'contact',
   'Website', 'website', 'url', 'text', false, '{}'::jsonb, 11),
  ('00000001-0000-4000-8000-00000000000d', '00000000-0000-4000-8000-000000000001', 'contact',
   'How we met', 'how_we_met', 'long_text', 'text', false, '{}'::jsonb, 12),
  ('00000001-0000-4000-8000-00000000000e', '00000000-0000-4000-8000-000000000001', 'contact',
   'Notes', 'notes', 'long_text', 'text', false, '{}'::jsonb, 13),

  ('00000002-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'organization',
   'Type', 'type', 'single_select', 'option', false, '{}'::jsonb, 0),
  ('00000002-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'organization',
   'Industry', 'industry', 'tags', 'text', true, '{}'::jsonb, 1),
  ('00000002-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'organization',
   'City', 'city', 'short_text', 'text', false, '{}'::jsonb, 2),
  ('00000002-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'organization',
   'Country', 'country', 'short_text', 'text', false, '{}'::jsonb, 3),
  ('00000002-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 'organization',
   'Website', 'website', 'url', 'text', false, '{}'::jsonb, 4),
  ('00000002-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', 'organization',
   'LinkedIn', 'linkedin_url', 'url', 'text', false, '{}'::jsonb, 5),
  ('00000002-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001', 'organization',
   'Description', 'description', 'long_text', 'text', false, '{}'::jsonb, 6),
  ('00000002-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001', 'organization',
   'Stage', 'stage', 'single_select', 'option', false, '{}'::jsonb, 7)
ON CONFLICT (id) DO NOTHING;

-- Option order is the sort order of a single_select, so `position` is exactly the order §4.1 lists.
-- `color` is left unset: the eleven chip colours are a closed token enum owned by packages/core.
INSERT INTO attribute_option (id, workspace_id, attribute_id, key, label, position)
VALUES
  ('00000003-0000-4000-8000-000000030000', '00000000-0000-4000-8000-000000000001',
   '00000001-0000-4000-8000-000000000003', 'founder',           'Founder',           0),
  ('00000003-0000-4000-8000-000000030001', '00000000-0000-4000-8000-000000000001',
   '00000001-0000-4000-8000-000000000003', 'investor',          'Investor',          1),
  ('00000003-0000-4000-8000-000000030002', '00000000-0000-4000-8000-000000000001',
   '00000001-0000-4000-8000-000000000003', 'operator',          'Operator',          2),
  ('00000003-0000-4000-8000-000000030003', '00000000-0000-4000-8000-000000000001',
   '00000001-0000-4000-8000-000000000003', 'student',           'Student',           3),
  ('00000003-0000-4000-8000-000000030004', '00000000-0000-4000-8000-000000000001',
   '00000001-0000-4000-8000-000000000003', 'community_builder', 'Community Builder', 4),
  ('00000003-0000-4000-8000-000000030005', '00000000-0000-4000-8000-000000000001',
   '00000001-0000-4000-8000-000000000003', 'other',             'Other',             5),

  ('00000004-0000-4000-8000-000000010000', '00000000-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000001', 'startup',    'Startup',    0),
  ('00000004-0000-4000-8000-000000010001', '00000000-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000001', 'vc_fund',    'VC Fund',    1),
  ('00000004-0000-4000-8000-000000010002', '00000000-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000001', 'angel',      'Angel',      2),
  ('00000004-0000-4000-8000-000000010003', '00000000-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000001', 'corporate',  'Corporate',  3),
  ('00000004-0000-4000-8000-000000010004', '00000000-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000001', 'university', 'University', 4),
  ('00000004-0000-4000-8000-000000010005', '00000000-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000001', 'community',  'Community',  5),
  ('00000004-0000-4000-8000-000000010006', '00000000-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000001', 'other',      'Other',      6),

  ('00000004-0000-4000-8000-000000080000', '00000000-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000008', 'pre_seed',      'Pre-seed',   0),
  ('00000004-0000-4000-8000-000000080001', '00000000-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000008', 'seed',          'Seed',       1),
  ('00000004-0000-4000-8000-000000080002', '00000000-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000008', 'series_a',      'Series A',   2),
  ('00000004-0000-4000-8000-000000080003', '00000000-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000008', 'series_b_plus', 'Series B+',  3),
  ('00000004-0000-4000-8000-000000080004', '00000000-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000008', 'public',        'Public',     4),
  ('00000004-0000-4000-8000-000000080005', '00000000-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000008', 'n_a',           'N/A',        5)
ON CONFLICT (id) DO NOTHING;
